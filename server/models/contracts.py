"""Typed contracts crossing the Next.js <-> FastAPI boundary.

Hand-mirrored from lib/schemas/index.ts — see ARCHITECTURE.md section 5 for
why these are two hand-written definitions rather than one generated source.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

ShotStatus = Literal[
    "pending", "generating", "reviewing", "revise", "approved", "needs_human"
]
QCVerdict = Literal["pass", "fail", "warning"]
QCSeverity = Literal["info", "warning", "critical"]


class GenerationSettings(BaseModel):
    """Veo 3.1 call parameters. An explicit model, not a loose dict — Gemini's
    Developer API structured-output mode rejects open-ended `additionalProperties`
    objects outright, and an explicit shape is the right call anyway."""

    model: str
    seed: int | None = None
    image_refs: list[str] = Field(default_factory=list)


class ShotBrief(BaseModel):
    """Planner output: what a shot needs to preserve and how to generate it."""

    shot_code: str
    invariants: list[str]
    reference_asset_ids: list[UUID]
    prompt: str
    generation_settings: GenerationSettings


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
    generation_settings: GenerationSettings
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


class ScriptScene(BaseModel):
    """One scene of a draft: a slugline, what happens, and the beats a shot
    list is cut from."""

    heading: str
    action: str
    beats: list[str] = Field(default_factory=list)


class ScriptDraft(BaseModel):
    """Story agent output. Deliberately small - a logline to check the premise
    against, a synopsis to read, and scenes carrying the action a breakdown
    turns into shots. Anything richer is a later pass, not this contract."""

    logline: str
    synopsis: str
    scenes: list[ScriptScene] = Field(min_length=1)


class CharacterIdentityScore(BaseModel):
    """One character's identity match against its locked reference."""

    character_name: str
    # 0.0-1.0. Not a face embedding - see agents/identity_check.py for why this
    # is a model's judgement rather than a cosine distance.
    similarity: float = Field(ge=0.0, le=1.0)
    verdict: QCVerdict
    # Per-frame, kept rather than averaged away: a character that drifts mid-shot
    # reads completely differently from one that was wrong in every frame, and
    # the fix is different too.
    frame_similarities: list[float] = Field(default_factory=list)
    note: str


class IdentityReport(BaseModel):
    """Cheap first-pass identity gate over a generated version.

    Deliberately separate from the critic's holistic QC: this asks one narrow,
    repeatable question (is this the same person as the locked reference) so a
    drift that prose judgement has historically been inconsistent about gets a
    number attached to it.
    """

    overall_pass: bool
    overall_similarity: float = Field(ge=0.0, le=1.0)
    characters: list[CharacterIdentityScore] = Field(default_factory=list)
    # Only populated on failure, by the second-tier diagnosis call.
    diagnosis: str | None = None
    suggested_change: str | None = None
