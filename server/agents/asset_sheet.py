"""Asset-sheet agent: a spec becomes a real reference image.

The last piece of top-down planning. The breakdown says which characters, props
and environments the script needs held constant; this makes something the
generator and the critic can actually be held to.

Two rules govern the output and neither is negotiable:

A sheet lands **unlocked**. `get_reference_assets()` selects only rows with
`locked_at IS NOT NULL`, so an unlocked sheet is already invisible to the
planner, the critic and the generation adapter. That is the whole approval
story - the lock verb an operator already has *is* the canon gate, so there is
no second approval concept here. A generated image is a proposal until a human
says it is canon, and it cannot leak into a run before that.

A sheet is **traceable**: which breakdown asked for it, the exact prompt, and
the model that made it, all on the row. Generated footage already carries this;
a generated reference is upstream of every shot judged against it, so it
carries more weight, not less.

Text-to-image through generateContent, the same call shape as the planner and
critic. Billed by tokens, priced in decision_log's table - see BUILD_PLAN 6.0.
"""

import time
from uuid import UUID

from google.genai import types

from agents.decision_log import estimate_token_cost, log_decision, token_usage
from db.postgres import Database
from genai_client import get_client
from models.contracts import AssetSheetSpec
from retry import call_with_retry
from storage.minio_client import get_client as get_minio
from storage.minio_client import put_bytes

MODEL = "gemini-3.1-flash-image"
BUCKET = "dailies"

# What a reference sheet has to be to be usable as one. Flat even light and a
# neutral ground because the sheet is the constant a shot is compared against -
# baking a mood into it means every lit shot reads as a continuity failure.
_SHEET_DIRECTION = (
    "Reference sheet for visual continuity, not a finished frame. "
    "Neutral mid-grey seamless background, flat even lighting, no cast shadows, "
    "no scene, no story, no text, labels or watermarks. Sharp focus throughout, "
    "full subject in frame, colour-accurate."
)


class AssetSheetFailed(Exception):
    """The model returned no image. Distinct from a network error: the call
    happened and may have been billed, so the caller must not silently retry."""


def build_prompt(spec: AssetSheetSpec) -> str:
    """The exact text sent to the model, assembled in one place so the prompt
    stored on the row is the prompt that ran - not a reconstruction of it."""
    views = ", ".join(spec.views)
    return (
        f"{_SHEET_DIRECTION}\n\n"
        f"Subject ({spec.asset_type}): {spec.name}\n"
        f"{spec.prompt}\n\n"
        f"Show these views in a single image, arranged left to right: {views}. "
        f"The subject must be identical in every view - same proportions, same "
        f"colours, same materials, same markings."
    )


async def generate_sheet(
    *,
    spec: AssetSheetSpec,
    show_id: UUID,
    breakdown_id: UUID | None,
    db: Database,
    run_id: str,
) -> tuple[UUID, float]:
    """Generates one sheet, stores it, and records it as an unlocked reference.

    Returns the new reference asset's id and what the call actually cost.
    Raises AssetSheetFailed if the model returned no image - nothing is written
    in that case, so a failed sheet never leaves a row pointing at no picture.
    """
    client = get_client()
    prompt = build_prompt(spec)

    start = time.monotonic()
    response = await call_with_retry(
        client.aio.models.generate_content,
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
    )
    latency_ms = int((time.monotonic() - start) * 1000)

    tokens_in, tokens_out = token_usage(response)
    cost = estimate_token_cost(MODEL, tokens_in, tokens_out)

    image: bytes | None = None
    mime = "image/png"
    for candidate in response.candidates or []:
        for part in (candidate.content.parts if candidate.content else None) or []:
            if part.inline_data and part.inline_data.data:
                image = part.inline_data.data
                mime = part.inline_data.mime_type or mime
                break
        if image:
            break

    # Logged before the failure check: the call was made and billed whether or
    # not it returned a picture, and a cost the ledger never saw is exactly the
    # under-reporting the budget ceiling now depends on not happening.
    log_decision(
        run_id=run_id,
        agent_name="asset_sheet_agent",
        step="generate_sheet",
        input_ref=f"{spec.asset_type}:{spec.name}",
        output_ref="image" if image else "no_image_returned",
        model=MODEL,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=cost,
        latency_ms=latency_ms,
    )

    if image is None:
        raise AssetSheetFailed(
            f"The image model returned no image for {spec.name!r}. The call was still billed."
        )

    extension = "jpg" if "jpeg" in mime else "png"
    slug = spec.name.lower().replace(" ", "-").replace("/", "-")
    key = f"refs/{show_id}/generated/{slug}-{int(time.time())}.{extension}"
    put_bytes(get_minio(), BUCKET, key, image, mime)

    asset = await db.insert_generated_reference(
        show_id=show_id,
        type=spec.asset_type,
        name=spec.name,
        image_url=key,
        breakdown_id=breakdown_id,
        generation_prompt=prompt,
        generation_model=MODEL,
    )
    return asset.id, cost
