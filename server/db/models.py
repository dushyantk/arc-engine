"""Typed Postgres row models. Mirrors db/schema.ts (Drizzle) exactly —
Postgres is the transactional source of truth; see ARCHITECTURE.md section 4.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from models.contracts import ShotStatus

ShotVersionStatus = Literal["candidate", "failed", "approved"]
ReferenceAssetType = Literal["character", "prop", "environment", "palette"]
ApprovalActor = Literal["agent", "human"]


class Show(BaseModel):
    id: UUID
    name: str
    created_at: datetime


class Sequence(BaseModel):
    id: UUID
    show_id: UUID
    code: str
    description: str | None


class Shot(BaseModel):
    id: UUID
    sequence_id: UUID
    code: str
    order_index: int
    screen_direction: str | None
    status: ShotStatus
    brief: str | None


class ShotVersion(BaseModel):
    id: UUID
    shot_id: UUID
    version_number: int
    generation_prompt: str
    generation_settings: dict[str, object] | None
    video_asset_url: str | None
    status: ShotVersionStatus
    brief_used: str | None
    created_at: datetime


class ReferenceAsset(BaseModel):
    id: UUID
    show_id: UUID
    type: ReferenceAssetType
    name: str
    image_url: str
    locked_at: datetime | None
    approved_by: str | None


class ApprovalEvent(BaseModel):
    id: UUID
    shot_id: UUID
    shot_version_id: UUID
    actor: ApprovalActor
    decision: str
    reason: str | None
    created_at: datetime
