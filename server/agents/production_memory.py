"""Writes real runs' output into ClickHouse's actual production memory
tables — qc_findings and continuity_fingerprints. Neither table has ever
been written to by a real run before this: only the Phase 1 seed rows
exist in either, which is why the QC report UI has only ever rendered for
seeded SH020 v002, and why the planner's own continuity research has been
reading memory frozen at the seed regardless of what's actually happened
since. This is the audit's headline finding, closed.
"""

import json
import os
import time
from datetime import UTC, datetime

import clickhouse_connect
from google.genai import types
from pydantic import BaseModel

from agents.decision_log import estimate_token_cost, log_decision
from genai_client import get_client
from models.contracts import ContinuityFingerprint, GenerationSettings, QCFinding, ShotStatus
from retry import call_with_retry

# Same tier as the planner's research call - this is a cheap text-extraction
# task (structuring an already-written prompt), not a vision task like the
# critic's.
FINGERPRINT_MODEL = "gemini-3.6-flash"

FINGERPRINT_PROMPT_TEMPLATE = """Extract structured continuity state from this real, approved
Veo generation prompt for {shot_code}. This becomes the production-memory record future shots'
planning will research before writing their own prompts, so be concrete and specific, not
generic - copy exact descriptive details (names, colors, hex codes, ages, materials) straight
from the prompt rather than summarizing them away.

Approved generation prompt:
{prompt}

Produce: character_identity, costume, props, environment, time_of_day, lighting_direction,
camera, lens_language (all strings), and palette (a list of color names or hex codes actually
mentioned or clearly implied). If the prompt has no characters, or no props, etc., say so plainly
("no characters in this shot") rather than inventing detail that isn't there.
"""


def _client() -> clickhouse_connect.driver.Client:
    return clickhouse_connect.get_client(
        host=os.environ.get("CLICKHOUSE_HOST", "localhost"),
        port=int(os.environ.get("CLICKHOUSE_PORT", "8124")),
        username=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
        secure=os.environ.get("CLICKHOUSE_SECURE", "false").lower() == "true",
        database=os.environ.get("CLICKHOUSE_DATABASE", "dailies"),
    )


def get_qc_findings(*, shot_id: str, version: int) -> list[QCFinding]:
    """Reads back whatever real findings store_qc_findings wrote for this
    shot/version - lets fingerprint extraction triggered later (e.g. a
    human approval, which doesn't have the original critique's findings
    in memory) include the real findings rather than an empty list."""
    client = _client()
    result = client.query(
        "SELECT category, verdict, frame_range_start, frame_range_end, description, severity "
        "FROM qc_findings WHERE shot_id = {shot_id:String} AND version = {version:UInt32} "
        "ORDER BY created_at ASC",
        parameters={"shot_id": shot_id, "version": version},
    )
    return [
        QCFinding(
            category=row[0],
            verdict=row[1],
            frame_range_start=row[2],
            frame_range_end=row[3],
            description=row[4],
            severity=row[5],
        )
        for row in result.result_rows
    ]


def get_latest_fingerprint(*, shot_code: str, version: int) -> ContinuityFingerprint | None:
    """Reads back the real continuity_fingerprints row for one approved
    shot version - what the sequence-level continuity pass compares across
    shots. None if this version predates the fingerprint-extraction feature
    or was never approved."""
    client = _client()
    result = client.query(
        "SELECT show, sequence, shot, version, character_identity, costume, props, "
        "environment, time_of_day, lighting_direction, camera, lens_language, "
        "screen_direction, palette, approved_reference_frames, generation_prompt, "
        "generation_settings, qc_findings, supervisor_notes, revision_reason, "
        "approval_status, extracted_at "
        "FROM continuity_fingerprints "
        "WHERE shot = {shot:String} AND version = {version:UInt32} AND approval_status = 'approved' "
        "ORDER BY extracted_at DESC LIMIT 1",
        parameters={"shot": shot_code, "version": version},
    )
    if not result.result_rows:
        return None
    row = result.result_rows
    (
        show,
        sequence,
        shot,
        ver,
        character_identity,
        costume,
        props,
        environment,
        time_of_day,
        lighting_direction,
        camera,
        lens_language,
        screen_direction,
        palette,
        approved_reference_frames,
        generation_prompt,
        generation_settings,
        qc_findings_json,
        supervisor_notes,
        revision_reason,
        approval_status,
        extracted_at,
    ) = row[0]
    return ContinuityFingerprint(
        show=show,
        sequence=sequence,
        shot=shot,
        version=ver,
        character_identity=character_identity,
        costume=costume,
        props=props,
        environment=environment,
        time_of_day=time_of_day,
        lighting_direction=lighting_direction,
        camera=camera,
        lens_language=lens_language,
        screen_direction=screen_direction,
        palette=palette,
        approved_reference_frames=approved_reference_frames,
        generation_prompt=generation_prompt,
        generation_settings=GenerationSettings.model_validate_json(generation_settings),
        qc_findings=[QCFinding.model_validate(f) for f in json.loads(qc_findings_json)],
        supervisor_notes=supervisor_notes,
        revision_reason=revision_reason or None,
        approval_status=approval_status,
        extracted_at=extracted_at,
    )


def store_qc_findings(*, shot_id: str, version: int, findings: list[QCFinding]) -> None:
    """Every real critique's findings, granular - one row per finding, same
    shape the seed data already has, so the QC report UI (built against
    that seed shape) now renders for real versions too, not just v002."""
    if not findings:
        return
    client = _client()
    client.insert(
        "qc_findings",
        [
            [
                shot_id,
                version,
                f.category,
                f.verdict,
                f.frame_range_start,
                f.frame_range_end,
                f.description,
                f.severity,
            ]
            for f in findings
        ],
        column_names=[
            "shot_id",
            "version",
            "category",
            "verdict",
            "frame_range_start",
            "frame_range_end",
            "description",
            "severity",
        ],
    )


class _FingerprintFields(BaseModel):
    character_identity: str
    costume: str
    props: str
    environment: str
    time_of_day: str
    lighting_direction: str
    camera: str
    lens_language: str
    palette: list[str]


async def extract_and_store_fingerprint(
    *,
    show_name: str,
    sequence_code: str,
    shot_code: str,
    version_number: int,
    prompt: str,
    generation_settings: GenerationSettings,
    screen_direction: str | None,
    reference_frame_urls: list[str],
    qc_findings: list[QCFinding],
    approval_status: ShotStatus,
    run_id: str,
) -> None:
    """Real production memory for one approved version - a cheap text-only
    extraction from the exact prompt that was actually used (the prompt
    itself is already precise; this structures it, not re-derives it from
    scratch), plus fields we already know for certain (screen_direction,
    reference URLs, the real findings) rather than asking the model to
    guess at those too."""
    genai_client = get_client()
    start = time.monotonic()
    response = await call_with_retry(
        genai_client.aio.models.generate_content,
        model=FINGERPRINT_MODEL,
        contents=types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    text=FINGERPRINT_PROMPT_TEMPLATE.format(shot_code=shot_code, prompt=prompt)
                )
            ],
        ),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_FingerprintFields,
        ),
    )
    latency_ms = int((time.monotonic() - start) * 1000)
    usage = response.usage_metadata
    tokens_in = usage.prompt_token_count if usage else 0
    tokens_out = usage.candidates_token_count if usage else 0

    if response.parsed is None:
        raise ValueError(f"Fingerprint extraction produced malformed JSON: {response.text!r}")
    fields = _FingerprintFields.model_validate(response.parsed)

    log_decision(
        run_id=run_id,
        agent_name="revision_agent",  # closest existing category; no dedicated one for this step
        step="fingerprint_extraction",
        input_ref=f"{shot_code}:v{version_number}",
        output_ref=fields.character_identity[:200],
        model=FINGERPRINT_MODEL,
        tokens_in=tokens_in or 0,
        tokens_out=tokens_out or 0,
        cost_usd=estimate_token_cost(FINGERPRINT_MODEL, tokens_in or 0, tokens_out or 0),
        latency_ms=latency_ms,
    )

    warnings = [f.description for f in qc_findings if f.verdict == "warning"]
    fingerprint = ContinuityFingerprint(
        show=show_name,
        sequence=sequence_code,
        shot=shot_code,
        version=version_number,
        character_identity=fields.character_identity,
        costume=fields.costume,
        props=fields.props,
        environment=fields.environment,
        time_of_day=fields.time_of_day,
        lighting_direction=fields.lighting_direction,
        camera=fields.camera,
        lens_language=fields.lens_language,
        screen_direction=screen_direction or "unspecified",
        palette=fields.palette,
        approved_reference_frames=reference_frame_urls,
        generation_prompt=prompt,
        generation_settings=generation_settings,
        qc_findings=qc_findings,
        supervisor_notes="; ".join(warnings) if warnings else "",
        revision_reason=None,
        approval_status=approval_status,
        # Real wall-clock time, not fabricated - ClickHouse's own
        # DEFAULT now64(3) is what actually lands in the row (this field
        # isn't in the INSERT's column list below), this is only here to
        # satisfy the Pydantic model's non-optional field.
        extracted_at=datetime.now(UTC),
    )

    client = _client()
    client.insert(
        "continuity_fingerprints",
        [
            [
                fingerprint.show,
                fingerprint.sequence,
                fingerprint.shot,
                fingerprint.version,
                fingerprint.character_identity,
                fingerprint.costume,
                fingerprint.props,
                fingerprint.environment,
                fingerprint.time_of_day,
                fingerprint.lighting_direction,
                fingerprint.camera,
                fingerprint.lens_language,
                fingerprint.screen_direction,
                fingerprint.palette,
                fingerprint.approved_reference_frames,
                fingerprint.generation_prompt,
                fingerprint.generation_settings.model_dump_json(),
                json.dumps([f.model_dump() for f in fingerprint.qc_findings]),
                fingerprint.supervisor_notes,
                fingerprint.revision_reason or "",
                fingerprint.approval_status,
            ]
        ],
        column_names=[
            "show",
            "sequence",
            "shot",
            "version",
            "character_identity",
            "costume",
            "props",
            "environment",
            "time_of_day",
            "lighting_direction",
            "camera",
            "lens_language",
            "screen_direction",
            "palette",
            "approved_reference_frames",
            "generation_prompt",
            "generation_settings",
            "qc_findings",
            "supervisor_notes",
            "revision_reason",
            "approval_status",
        ],
    )
