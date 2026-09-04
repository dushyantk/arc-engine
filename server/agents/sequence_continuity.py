"""The cross-shot continuity pass ARCHITECTURE.md promises as the product's
closing argument: "a sequence is approved only when every shot is approved
and a final cross-shot continuity pass agrees they belong together." Every
shot being individually approved has never implied the sequence agrees with
itself - nothing has ever compared adjacent shots against each other. This
closes that gap.

Text-only, over the already-extracted continuity_fingerprints - re-watching
every approved shot's video again here would just duplicate the critic's own
per-shot work at extra cost. What this checks that no single-shot critique
can is the seam between shots: does Maya's costume in SH020 match what SH010
left her in, does lighting_direction carry across the cut, does screen_
direction stay coherent across the sequence.
"""

import time
from typing import Literal

from google.genai import types
from pydantic import BaseModel

from agents.decision_log import estimate_token_cost, log_decision, token_usage
from genai_client import get_client
from models.contracts import ContinuityFingerprint
from retry import call_with_retry

CONTINUITY_MODEL = "gemini-3.6-flash"

CONTINUITY_PROMPT_TEMPLATE = """You are the sequence-level continuity supervisor for Dailies, a
GenFX dailies review system. Every shot below has already been individually approved by the
per-shot critic. Your job is different: check whether they agree with EACH OTHER as a sequence,
in shot order - continuity across the cut, not within one shot.

Shots in order, each an extracted continuity fingerprint from its approved version:
{fingerprints_json}

For each pair of consecutive shots, check whether these carry across the cut without an
unexplained break: character_identity, costume, props, environment, time_of_day,
lighting_direction, lens_language, palette, and screen_direction (does movement stay coherent
shot-to-shot, not reverse without narrative reason). A deliberate story beat - time passing,
a costume change the brief called for, a new location - is not a defect; an unexplained
contradiction (a scar that moved sides, a coat that changed color, lighting direction that
flips with no in-story reason) is.

Produce a verdict: "approved" if the sequence holds together, "needs_human" if you find any
unexplained cross-shot contradiction significant enough that a human should look before this
sequence is called done. Write concrete notes citing the specific shots and attributes involved
- "SH010 to SH020: costume held (dark blue coat), lighting_direction held (camera-left)" for
things that passed, "SH020 to SH030: character_identity broke - eyebrow scar reported on the
opposite side" for things that didn't. Be specific enough that a human reading only your notes
could go verify the same thing you saw.
"""


class _ContinuityVerdict(BaseModel):
    status: Literal["approved", "needs_human"]
    notes: str


async def evaluate_sequence_continuity(
    *,
    fingerprints: list[ContinuityFingerprint],
    run_id: str,
    sequence_ref: str,
) -> tuple[Literal["approved", "needs_human"], str]:
    genai_client = get_client()

    fingerprints_json = "\n".join(
        f"{i + 1}. {fp.shot} v{fp.version}: "
        f"character_identity={fp.character_identity!r}, costume={fp.costume!r}, "
        f"props={fp.props!r}, environment={fp.environment!r}, "
        f"time_of_day={fp.time_of_day!r}, lighting_direction={fp.lighting_direction!r}, "
        f"lens_language={fp.lens_language!r}, screen_direction={fp.screen_direction!r}, "
        f"palette={fp.palette!r}"
        for i, fp in enumerate(fingerprints)
    )

    start = time.monotonic()
    response = await call_with_retry(
        genai_client.aio.models.generate_content,
        model=CONTINUITY_MODEL,
        contents=types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    text=CONTINUITY_PROMPT_TEMPLATE.format(fingerprints_json=fingerprints_json)
                )
            ],
        ),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_ContinuityVerdict,
        ),
    )
    latency_ms = int((time.monotonic() - start) * 1000)
    tokens_in, tokens_out = token_usage(response)

    if response.parsed is None:
        raise ValueError(f"Sequence continuity pass produced malformed JSON: {response.text!r}")
    verdict = _ContinuityVerdict.model_validate(response.parsed)

    log_decision(
        run_id=run_id,
        agent_name="continuity_agent",
        step="sequence_continuity_pass",
        input_ref=sequence_ref,
        output_ref=verdict.status,
        model=CONTINUITY_MODEL,
        tokens_in=tokens_in or 0,
        tokens_out=tokens_out or 0,
        cost_usd=estimate_token_cost(CONTINUITY_MODEL, tokens_in or 0, tokens_out or 0),
        latency_ms=latency_ms,
    )

    return verdict.status, verdict.notes
