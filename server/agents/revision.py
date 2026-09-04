"""Revision agent: turns FAILed (and worth-addressing warning) findings into
a concrete regeneration instruction — what to lock, what to remove, what to
preserve, and a revised prompt. One Gemini call, structured output.
"""

import time

from google.genai import types

from agents.decision_log import estimate_token_cost, log_decision, token_usage
from db.models import ReferenceAsset
from genai_client import get_client
from models.contracts import QCFinding, RevisionInstruction
from retry import call_with_retry

REVISION_MODEL = "gemini-3.6-flash"

REVISION_PROMPT_TEMPLATE = """You are the revision agent for Dailies. Shot {shot_code} v{version}
failed review. Turn the findings below into a concrete regeneration instruction for v{next_version}.

Prior generation prompt:
{prior_prompt}

QC findings from this version:
{findings}

Locked reference assets available to pin in this regeneration:
{reference_assets}

Produce a RevisionInstruction with these exact fields: shot_code, target_version (integer,
{next_version}), locked_reference_asset_ids (UUIDs from the list above that should be explicitly
pinned to fix the failures — pick the ones that address the actual failure, not all of them),
remove_elements (specific things to remove from the scene, from the failures), preserve_elements
(specific things to explicitly preserve, from the failures and from what already passed),
revised_prompt (the full next Veo generation prompt, incorporating the fixes), reason (one or two
sentences on why this revision addresses the failures).
"""


async def revise_shot(
    *,
    shot_code: str,
    prior_version: int,
    prior_prompt: str,
    findings: list[QCFinding],
    reference_assets: list[ReferenceAsset],
    run_id: str,
) -> RevisionInstruction:
    client = get_client()

    findings_text = "\n".join(
        f"- [{f.severity}/{f.verdict}] {f.category}: {f.description}"
        + (f" (frames {f.frame_range_start}-{f.frame_range_end})" if f.frame_range_start else "")
        for f in findings
        if f.verdict in ("fail", "warning")
    )
    ref_list = "\n".join(f"- {r.id} ({r.type}): {r.name}" for r in reference_assets)

    start = time.monotonic()
    response = await call_with_retry(
        client.aio.models.generate_content,
        model=REVISION_MODEL,
        contents=REVISION_PROMPT_TEMPLATE.format(
            shot_code=shot_code,
            version=prior_version,
            next_version=prior_version + 1,
            prior_prompt=prior_prompt,
            findings=findings_text or "(no fail/warning findings)",
            reference_assets=ref_list or "(none)",
        ),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=RevisionInstruction,
        ),
    )
    latency_ms = int((time.monotonic() - start) * 1000)
    tokens_in, tokens_out = token_usage(response)

    if response.parsed is None:
        raise ValueError(f"Revision agent produced malformed instruction JSON: {response.text!r}")
    instruction = RevisionInstruction.model_validate(response.parsed)

    log_decision(
        run_id=run_id,
        agent_name="revision_agent",
        step="revision_instruction",
        input_ref=f"shot:{shot_code}:v{prior_version}",
        output_ref=instruction.model_dump_json()[:200],
        model=REVISION_MODEL,
        tokens_in=tokens_in or 0,
        tokens_out=tokens_out or 0,
        cost_usd=estimate_token_cost(REVISION_MODEL, tokens_in or 0, tokens_out or 0),
        latency_ms=latency_ms,
    )

    return instruction
