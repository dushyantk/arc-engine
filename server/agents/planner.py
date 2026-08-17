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
