"""Breakdown agent: an approved script turned into the shot list it implies.

The hinge of top-down planning. Everything before this is prose a human reads;
everything after is rows the existing pipeline already knows how to execute. The
agent's whole job is to cross that line - and to cross it as a *proposal*, since
materialising a breakdown creates real sequences and shots that real money then
gets spent against.

Text only, like the story agent. No Veo, no images. A director can re-break a
script for cents until the shot list is right, and the expensive half of the
product only ever runs against a list a human approved.

Deliberately writes into `brief`, the same field an operator types by hand and
the planner already consumes. That seam is why nothing downstream of a shot
changes to accept a shot that was proposed rather than typed.
"""

import time

from google.genai import types

from agents.decision_log import estimate_token_cost, log_decision
from genai_client import get_client
from models.contracts import SceneBreakdown, ScriptDraft
from retry import call_with_retry

MODEL = "gemini-3.1-pro-preview"

_SYSTEM = """You are a VFX supervisor breaking a short script into a shot list
that will be generated shot by shot, each shot a single continuous take of a few
seconds.

Rules that matter more than coverage:

Every shot gets a brief written to be *executed*, not admired. A brief states
what is in frame, what moves, the light, the lens, and what must stay true to
the rest of the sequence. It is the only thing a generator will see - if a
detail is not in the brief it will not survive.

Name recurring physical things exactly as the script names them. If the script
says "the red leather suitcase", every brief that shows it says "the red leather
suitcase". Those names are what continuity is checked against, so a synonym
introduced here becomes a continuity failure later that nobody can trace.

Give each shot an explicit screen_direction (for example "camera left to right",
"static, subject faces camera"). Two adjacent shots that cross the line is the
most common defect this pipeline catches, and it is cheaper to avoid here.

Keep it small and shootable. A handful of sequences at most, a handful of shots
each. Order shots within a sequence from 0.

Sequence codes look like SQ010, SQ020. Shot codes look like SH010, SH020 and
must be unique across the WHOLE show - keep counting up across sequences, never
restart the numbering. A shot code is how the rest of the system names a shot,
including in its cost record, so two shots sharing one is an ambiguity nothing
downstream can resolve.

List the assets a generator would need a locked visual reference for - the
recurring characters, hero props and environments. For each, say plainly why the
sequence needs it. A human decides from that sentence whether to spend on
generating a reference sheet, so write it as a reason, not a label."""


async def break_down(*, script: ScriptDraft, show_name: str, run_id: str) -> SceneBreakdown:
    """Turns an approved script into a proposed shot list.

    Raises on malformed output rather than returning a partial breakdown - this
    proposal becomes real rows, and a half-parsed one would materialise a shot
    list nobody reviewed.
    """
    client = get_client()

    scenes = "\n\n".join(
        f"{scene.heading}\n{scene.action}"
        + ("".join(f"\n  - {beat}" for beat in scene.beats) if scene.beats else "")
        for scene in script.scenes
    )
    prompt = (
        f"Show: {show_name}\n\n"
        f"Logline: {script.logline}\n\n"
        f"Synopsis: {script.synopsis}\n\n"
        f"Script:\n{scenes}\n\n"
        "Break this into sequences, shots and the assets they need."
    )

    start = time.monotonic()
    response = await call_with_retry(
        client.aio.models.generate_content,
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=_SYSTEM,
            response_mime_type="application/json",
            response_schema=SceneBreakdown,
        ),
    )
    latency_ms = int((time.monotonic() - start) * 1000)

    usage = response.usage_metadata
    tokens_in = usage.prompt_token_count if usage and usage.prompt_token_count else 0
    tokens_out = usage.candidates_token_count if usage and usage.candidates_token_count else 0

    log_decision(
        run_id=run_id,
        agent_name="breakdown_agent",
        step="break_down",
        input_ref=show_name,
        output_ref="scene_breakdown",
        model=MODEL,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=estimate_token_cost(MODEL, tokens_in, tokens_out),
        latency_ms=latency_ms,
    )

    # Same hard stop as story.py and critic.py: output that did not validate is a
    # system fault, not a weak breakdown.
    if response.parsed is None:
        raise ValueError(f"Breakdown agent produced malformed JSON: {response.text!r}")
    return SceneBreakdown.model_validate(response.parsed)
