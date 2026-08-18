"""Planner agent: scene brief + ClickHouse continuity query -> ShotBrief.

Two Gemini calls, deliberately kept separate:
1. An MCP-tool-enabled call that lets the model actually query ClickHouse's
   continuity_fingerprints/qc_findings through the official ClickHouse MCP
   server — the agent doing its own research, not us hardcoding SQL. This
   is the actual hackathon-track requirement (distinct from the
   `clickhouse-local` dev-session connection in .mcp.json).
2. A schema-constrained call that turns that research into a validated
   ShotBrief. Kept separate because Gemini's MCP tool-calling loop and
   strict JSON-schema output don't compose cleanly in one turn.
"""

import time

from google.genai import types

from agents.decision_log import estimate_token_cost, log_decision
from db.models import ReferenceAsset, Shot
from genai_client import get_client
from mcp_clients.clickhouse import clickhouse_mcp_session
from models.contracts import ShotBrief
from retry import call_with_retry

PLANNER_MODEL = "gemini-3.6-flash"

RESEARCH_PROMPT_TEMPLATE = """You are the planning agent for Dailies, a GenFX dailies supervisor.

Before drafting a generation brief for shot {shot_code} in sequence {sequence_code} of show
"{show_name}", query the production memory in ClickHouse (database `dailies`) for the approved
continuity state of everything that must carry forward into this shot: character identity,
costume, props, environment, lighting direction, screen direction, and camera/lens language from
the most recent approved shots in this sequence.

Use the available tools to run real queries against `dailies.continuity_fingerprints` and
`dailies.qc_findings`. Then summarize, in plain prose, the approved continuity state this shot
must preserve. If nothing is approved yet, say so plainly.

Scene goal for this shot: {scene_goal}
"""

BRIEF_PROMPT_TEMPLATE = """You are the planning agent for Dailies. Turn the continuity research
below into a generation brief for shot {shot_code}.

Continuity research (grounded in production memory):
{research}

Scene goal for this shot: {scene_goal}

Available locked reference assets (use their IDs in reference_asset_ids, pick only the ones this
shot actually needs):
{reference_assets}

Known Veo failure modes to defend against in the prompt text — each was found by generating real
footage and checking it by hand, not theorized:

1. **Mid-shot hand-swap/teleport.** A hand-held prop can change hands partway through a shot, most
   often at the exact moment the character does something else with their other hand or body —
   reaching into a pocket, touching their hair, gesturing. If the scene has a hand-held prop AND
   any such secondary action, state explicitly that the prop stays gripped in its original hand
   for the entire duration, unaffected by the other hand's movement.

2. **Anatomical left/right is unreliable, especially combined with (1).** "Right hand" is
   self-referential and ambiguous to a model that doesn't reliably track character-relative vs.
   screen-relative framing — a character facing camera has her anatomical right hand on the
   viewer's left, and this flips constantly depending on which way she faces or turns. Mentioning
   two hands with two different actions in one sentence (needed to satisfy failure mode 1) also
   raises the odds of the model swapping which hand does which action.

   Fix: use standard film-continuity vocabulary — **screen-left** / **screen-right** — for every
   spatial instruction involving hands, props, or blocking. Screen-left/screen-right describe
   frame position exactly as the viewer sees it and never change with the character's facing
   direction or movement, unlike "her left"/"her right". State the anatomical hand once for
   characterization, then govern the actual generation instruction with screen-left/screen-right,
   e.g.: "holds the suitcase in her right hand, positioned screen-right for the duration of the
   shot; her left hand (screen-left) is free to move to her pocket without affecting the prop."
   Every invariant and the prompt text itself should describe blocking, movement (e.g. "screen-left
   to screen-right", not just "left to right"), and hand/prop position in screen-left/screen-right
   terms first, with anatomical side as secondary context only. Keep the two hands' actions in
   separate sentences rather than one combined clause regardless.

   Never qualify screen-left/screen-right with a body-relative phrase like "relative to her body"
   or "relative to her position" — a real generated shot for SH010 did exactly this ("in her right
   hand, positioned screen-right relative to her body") and the suitcase still rendered
   screen-left, twice in a row. That qualifier reopens the same ambiguity screen-left/screen-right
   exists to close: it invites reading the position as anchored to the character's own facing
   rather than to the fixed camera frame. State the screen position as an absolute fact about the
   frame — "positioned screen-right" full stop, nothing appended after it.

3. **"Static shot" can bleed into "static subject."** This is real cinematography shorthand for a
   locked-off, unmoving camera — it says nothing about whether the character moves. A model
   without deep cinematography grounding may apply "static" to the whole scene, including the
   subject, and render the character standing still even when the prompt separately asks for
   movement. Never write "static shot of [character] walking/moving" as one description — say the
   camera is fixed/locked-off/unmoving in its own clause, and describe the character's motion in a
   separate clause with no shared modifier between them.

4. **Character appearance drifts between generations when underspecified.** Real reference
   photography now exists for Maya (character), the red leather suitcase (prop), and Station
   Platform 2 (environment) — real frames pulled from SH020's approved generation, uploaded to
   the reference asset image URLs above. Always include their IDs in `reference_asset_ids` and in
   `generation_settings.image_refs` when this shot features them; the generation call is genuinely
   image-conditioned against whatever you list there, not text-only. Still write the prompt's own
   physical description to match the continuity research exactly rather than inventing specifics —
   image-conditioning constrains appearance, it doesn't replace grounding the text in what's
   actually approved. If a shot introduces a character/prop/environment with no matching reference
   asset yet, note in the invariants list that its appearance isn't grounded and will vary between
   generations until a reference exists.

   The Maya character reference photo itself has a real limitation worth defending against: it
   shows her facial mark looking like a fresh, wet, actively-bleeding injury (extracted from a
   dramatic mid-scene moment), not the "small healed scar" the continuity record actually
   establishes. Two real SH010 generations conditioned on it both rendered a fresh red
   mark/wound instead of a healed scar — the image is winning over the text on this specific
   detail. Defend against it explicitly in the prompt: state that despite any fresh-looking mark
   in the reference photo, her scar is old, healed, and faded — pale/silvery, not red or wet —
   and describe it that way in its own sentence rather than assuming the reference image alone
   conveys "healed."

5. **Relying on blur/focus to hide an object has a 0-for-3 real track record.** Three separate real
   generations asked for a background object (a station clock) to be blurred or out of focus so it
   wouldn't be legible — different wording each time — and all three rendered it sharp and legible
   anyway. Do not repeat that approach. If something must not be prominent or legible, prefer
   excluding it from the composition/frame entirely (camera angle, framing, blocking that puts it
   out of shot) over asking for shallow depth of field or bokeh to obscure it — the evidence so far
   says that instruction doesn't get followed reliably.

Produce a ShotBrief with these exact fields: shot_code (string), invariants (a list of specific
things that must NOT change from the continuity research above — be concrete, not generic),
reference_asset_ids (a list of UUIDs from the reference list above), prompt (the actual Veo
generation prompt text), generation_settings (an object with: model, e.g.
"veo-3.1-generate-preview"; seed, an integer, optional; image_refs, a list of reference asset
UUIDs from the list above to use for image-conditioned generation).
"""


async def plan_shot(
    *,
    show_name: str,
    sequence_code: str,
    shot: Shot,
    scene_goal: str,
    reference_assets: list[ReferenceAsset],
    run_id: str,
) -> ShotBrief:
    client = get_client()

    # Step 1: research via the ClickHouse MCP — the agent's own tool call.
    research_start = time.monotonic()
    async with clickhouse_mcp_session() as session:
        research_response = await call_with_retry(
            client.aio.models.generate_content,
            model=PLANNER_MODEL,
            contents=RESEARCH_PROMPT_TEMPLATE.format(
                shot_code=shot.code,
                sequence_code=sequence_code,
                show_name=show_name,
                scene_goal=scene_goal,
            ),
            # A plain dict here, not types.GenerateContentConfig(tools=[session]): passing an
            # already-constructed config object makes the SDK unconditionally deep-copy it
            # (google/genai/models.py generate_content), which fails on a live MCP ClientSession
            # (unpicklable asyncio internals). A dict takes a different internal path
            # (GenerateContentConfig(**config), no deepcopy) — this is what the SDK's own MCP
            # tests use, not incidental.
            config={"tools": [session]},
        )
    research_latency_ms = int((time.monotonic() - research_start) * 1000)
    research_text = research_response.text or ""
    research_usage = research_response.usage_metadata
    research_tokens_in = research_usage.prompt_token_count if research_usage else 0
    research_tokens_out = research_usage.candidates_token_count if research_usage else 0

    log_decision(
        run_id=run_id,
        agent_name="planner",
        step="continuity_research",
        input_ref=f"shot:{shot.code}",
        output_ref=research_text[:200],
        model=PLANNER_MODEL,
        tokens_in=research_tokens_in or 0,
        tokens_out=research_tokens_out or 0,
        cost_usd=estimate_token_cost(PLANNER_MODEL, research_tokens_in or 0, research_tokens_out or 0),
        latency_ms=research_latency_ms,
    )

    # Step 2: structured ShotBrief from the research.
    ref_list = "\n".join(f"- {r.id} ({r.type}): {r.name}" for r in reference_assets)
    brief_start = time.monotonic()
    brief_response = await call_with_retry(
        client.aio.models.generate_content,
        model=PLANNER_MODEL,
        contents=BRIEF_PROMPT_TEMPLATE.format(
            shot_code=shot.code,
            research=research_text,
            scene_goal=scene_goal,
            reference_assets=ref_list or "(none)",
        ),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ShotBrief,
        ),
    )
    brief_latency_ms = int((time.monotonic() - brief_start) * 1000)
    brief_usage = brief_response.usage_metadata
    brief_tokens_in = brief_usage.prompt_token_count if brief_usage else 0
    brief_tokens_out = brief_usage.candidates_token_count if brief_usage else 0

    if brief_response.parsed is None:
        raise ValueError(f"Planner produced malformed ShotBrief JSON: {brief_response.text!r}")
    shot_brief = ShotBrief.model_validate(brief_response.parsed)

    log_decision(
        run_id=run_id,
        agent_name="planner",
        step="shot_brief",
        input_ref=f"shot:{shot.code}",
        output_ref=shot_brief.model_dump_json()[:200],
        model=PLANNER_MODEL,
        tokens_in=brief_tokens_in or 0,
        tokens_out=brief_tokens_out or 0,
        cost_usd=estimate_token_cost(PLANNER_MODEL, brief_tokens_in or 0, brief_tokens_out or 0),
        latency_ms=brief_latency_ms,
    )

    return shot_brief
