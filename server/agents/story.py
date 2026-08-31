"""Story agent: an idea prompt expanded into a script a breakdown can be made from.

The first stage of top-down planning, and the cheapest. Text only - no Veo, no
images - so a director can iterate on the premise for cents before anything
expensive is committed to. That is the point of putting it first: the expensive
half of this product should only ever run against something a human has read and
approved.

Deliberately not given the continuity state the planner queries. A script is
written before there is anything to be continuous with; grounding it in existing
fingerprints would bias a new story toward the last one.
"""

import time

from google.genai import types

from agents.decision_log import estimate_token_cost, log_decision
from genai_client import get_client
from models.contracts import ScriptDraft
from retry import call_with_retry

MODEL = "gemini-3.1-pro-preview"

_SYSTEM = """You are a screenwriter working with a VFX supervisor on a short
sequence that will be generated shot by shot.

Write something *shootable*, not something literary. Every scene must be
describable as camera-facing action: what is physically in frame, what moves,
what the light is doing. Avoid interiority, backstory and dialogue - none of it
survives into a generated shot.

Keep it small. One location if you can, a handful of scenes, a single continuous
run of action. A short sequence that holds together beats an epic that cannot be
generated.

Name recurring physical things precisely and identically every time they appear -
a character's coat, a hero prop, the specific light source. Those names become
the continuity references the rest of the pipeline is held to, so "the red
leather suitcase" must not become "her bag" three scenes later."""


async def write_script(*, idea: str, show_name: str, run_id: str) -> ScriptDraft:
    """Expands an operator's idea into a ScriptDraft.

    Raises on malformed output rather than returning a partial script - a bad
    draft here propagates into every shot planned from it.
    """
    client = get_client()

    prompt = (
        f"Show: {show_name}\n\n"
        f"The director's idea, in their own words:\n{idea}\n\n"
        "Expand this into a short, shootable sequence."
    )

    start = time.monotonic()
    response = await call_with_retry(
        client.aio.models.generate_content,
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=_SYSTEM,
            response_mime_type="application/json",
            response_schema=ScriptDraft,
        ),
    )
    latency_ms = int((time.monotonic() - start) * 1000)

    usage = response.usage_metadata
    tokens_in = usage.prompt_token_count if usage and usage.prompt_token_count else 0
    tokens_out = usage.candidates_token_count if usage and usage.candidates_token_count else 0

    log_decision(
        run_id=run_id,
        agent_name="story_agent",
        step="write_script",
        input_ref=show_name,
        output_ref="script_draft",
        model=MODEL,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=estimate_token_cost(MODEL, tokens_in, tokens_out),
        latency_ms=latency_ms,
    )

    # Same hard stop as every other structured call in this chain - a draft that
    # did not validate is a system fault, not a weak script. Matches critic.py.
    if response.parsed is None:
        raise ValueError(f"Story agent produced malformed script JSON: {response.text!r}")
    return ScriptDraft.model_validate(response.parsed)


def render_body(draft: ScriptDraft) -> str:
    """The draft as readable screenplay text, for `scripts.body`.

    Stored rendered as well as structured because the structure is what the
    breakdown consumes, while this is what a human actually reads and approves.
    """
    parts: list[str] = []
    for scene in draft.scenes:
        parts.append(scene.heading.upper())
        parts.append(scene.action)
        if scene.beats:
            parts.extend(f"  - {beat}" for beat in scene.beats)
        parts.append("")
    return "\n".join(parts).strip()
