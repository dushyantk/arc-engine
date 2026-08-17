"""Supervisor/Critic agent: watches a candidate shot version, compares it
against approved references and continuity context, and produces
structured QC findings — with an explicit instruction to tell creative
variation apart from generative defect, not just flag any change as fail.
"""

import time

from google.genai import types
from pydantic import BaseModel

from agents.decision_log import estimate_token_cost, log_decision
from db.models import ReferenceAsset
from genai_client import get_client
from models.contracts import QCFinding
from retry import call_with_retry

CRITIC_MODEL = "gemini-3.1-pro-preview"

CRITIC_PROMPT_TEMPLATE = """You are the supervisor/critic agent for Dailies, a GenFX dailies
review system. Watch the attached candidate shot and compare it against the reference images and
continuity context below. You are looking for objective continuity breaks, not giving a general
creative review.

Continuity context this shot must preserve:
{continuity_context}

Reference images are attached and labeled by type and name.

For each of these categories, produce a QCFinding: character_identity, costume_continuity,
hero_prop, environment_continuity, screen_direction, lighting_continuity, temporal_stability
(flickering, geometry crawl, deforming text/numerals, mutating faces). Skip a category only if it
genuinely does not apply to this shot (e.g. no on-screen text to evaluate for temporal_stability).

Critical instruction: distinguish creative variation from generative defect. A creature's
silhouette changing between takes, weather intensifying, or a camera move being more dynamic than
planned can be acceptable creative variation — say so and mark it pass, with a note. An extra
finger for a few frames, a prop changing color or vanishing, a face mutating, or geometry crawling
is a generative defect — mark it fail. When genuinely uncertain, mark it warning and say what you
are uncertain about. Cite approximate frame ranges for anything localized in time.
"""


class _QCFindingsResult(BaseModel):
    findings: list[QCFinding]


async def critique_shot_version(
    *,
    video_bytes: bytes,
    video_mime_type: str,
    reference_assets: list[ReferenceAsset],
    reference_images: dict[str, bytes],  # reference_assets[i].id (str) -> image bytes
    continuity_context: str,
    run_id: str,
    shot_version_ref: str,
) -> list[QCFinding]:
    client = get_client()

    parts: list[types.Part] = [types.Part.from_bytes(data=video_bytes, mime_type=video_mime_type)]
    for ref in reference_assets:
        image_bytes = reference_images.get(str(ref.id))
        if image_bytes is None:
            continue
        parts.append(types.Part.from_text(text=f"Reference — {ref.type}: {ref.name}"))
        parts.append(types.Part.from_bytes(data=image_bytes, mime_type="image/png"))

    parts.append(
        types.Part.from_text(
            text=CRITIC_PROMPT_TEMPLATE.format(continuity_context=continuity_context)
        )
    )

    start = time.monotonic()
    response = await call_with_retry(
        client.aio.models.generate_content,
        model=CRITIC_MODEL,
        contents=types.Content(role="user", parts=parts),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_QCFindingsResult,
        ),
    )
    latency_ms = int((time.monotonic() - start) * 1000)
    usage = response.usage_metadata
    tokens_in = usage.prompt_token_count if usage else 0
    tokens_out = usage.candidates_token_count if usage else 0

    if response.parsed is None:
        raise ValueError(f"Critic produced malformed QC findings JSON: {response.text!r}")
    result = _QCFindingsResult.model_validate(response.parsed)

    log_decision(
        run_id=run_id,
        agent_name="critic",
        step="qc_review",
        input_ref=shot_version_ref,
        output_ref=f"{len(result.findings)} findings",
        model=CRITIC_MODEL,
        tokens_in=tokens_in or 0,
        tokens_out=tokens_out or 0,
        cost_usd=estimate_token_cost(CRITIC_MODEL, tokens_in or 0, tokens_out or 0),
        latency_ms=latency_ms,
    )

    return result.findings
