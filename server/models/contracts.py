"""Typed contracts crossing the Next.js <-> FastAPI boundary.

Hand-mirrored from lib/schemas/index.ts — see ARCHITECTURE.md section 5 for
why these are two hand-written definitions rather than one generated source.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

ShotStatus = Literal[
    "pending", "generating", "reviewing", "revise", "approved", "needs_human"
]
QCVerdict = Literal["pass", "fail", "warning"]
QCSeverity = Literal["info", "warning", "critical"]


class ShotBrief(BaseModel):
    """Planner output: what a shot needs to preserve and how to generate it."""

    shot_code: str
    invariants: list[str]
    reference_asset_ids: list[UUID]
    prompt: str
    generation_settings: dict[str, object]


class QCFinding(BaseModel):
    """One continuity axis check on a shot version."""

    category: str
    verdict: QCVerdict
    frame_range_start: int | None = None
    frame_range_end: int | None = None
    description: str
    severity: QCSeverity


class ContinuityFingerprint(BaseModel):
    """Extracted continuity state for one shot/version. Mirrors the
    ClickHouse continuity_fingerprints row exactly (server/clickhouse/schema.sql)."""

    show: str
    sequence: str
    shot: str
    version: int
    character_identity: str
    costume: str
    props: str
    environment: str
    time_of_day: str
    lighting_direction: str
    camera: str
    lens_language: str
    screen_direction: str
    palette: list[str]
    approved_reference_frames: list[str]
    generation_prompt: str
    generation_settings: dict[str, object]
    qc_findings: list[QCFinding]
    supervisor_notes: str
    revision_reason: str | None = None
    approval_status: ShotStatus
    extracted_at: datetime


class RevisionInstruction(BaseModel):
    """Critic's FAILed findings turned into concrete regeneration instructions."""

    shot_code: str
    target_version: int
    locked_reference_asset_ids: list[UUID]
    remove_elements: list[str]
    preserve_elements: list[str]
    revised_prompt: str
    reason: str
