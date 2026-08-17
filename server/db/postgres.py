"""Async Postgres access for the agent runtime.

Next.js/Drizzle owns the schema and the dashboard's CRUD reads (see
db/schema.ts). This module is hand-written SQL against the same tables —
no second ORM, no migrations owned here — because the agent runtime needs
write access as shots move through the pipeline (ARCHITECTURE.md's scope
decision: "FastAPI owns the agent loop; Next.js owns CRUD reads").
"""

import json
import os
from typing import Any
from uuid import UUID

import asyncpg

from db.models import ApprovalEvent, ReferenceAsset, Sequence, Shot, ShotVersion, Show


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )


class Database:
    def __init__(self, dsn: str | None = None) -> None:
        self._dsn = dsn or os.environ["DATABASE_URL"]
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self._pool = await asyncpg.create_pool(self._dsn, init=_init_connection)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("Database.connect() was not called")
        return self._pool

    async def get_show(self, show_id: UUID) -> Show:
        row = await self.pool.fetchrow("SELECT * FROM shows WHERE id = $1", show_id)
        if row is None:
            raise LookupError(f"show {show_id} not found")
        return Show(**dict(row))

    async def get_sequence(self, sequence_id: UUID) -> Sequence:
        row = await self.pool.fetchrow("SELECT * FROM sequences WHERE id = $1", sequence_id)
        if row is None:
            raise LookupError(f"sequence {sequence_id} not found")
        return Sequence(**dict(row))

    async def get_shots_for_sequence(self, sequence_id: UUID) -> list[Shot]:
        rows = await self.pool.fetch(
            "SELECT * FROM shots WHERE sequence_id = $1 ORDER BY order_index", sequence_id
        )
        return [Shot(**dict(r)) for r in rows]

    async def get_shot(self, shot_id: UUID) -> Shot:
        row = await self.pool.fetchrow("SELECT * FROM shots WHERE id = $1", shot_id)
        if row is None:
            raise LookupError(f"shot {shot_id} not found")
        return Shot(**dict(row))

    async def get_reference_assets(self, show_id: UUID) -> list[ReferenceAsset]:
        rows = await self.pool.fetch(
            "SELECT * FROM reference_assets WHERE show_id = $1 AND locked_at IS NOT NULL",
            show_id,
        )
        return [ReferenceAsset(**dict(r)) for r in rows]

    async def insert_reference_asset(
        self,
        *,
        show_id: UUID,
        type: str,
        name: str,
        image_url: str,
        approved_by: str,
    ) -> ReferenceAsset:
        row = await self.pool.fetchrow(
            """
            INSERT INTO reference_assets (show_id, type, name, image_url, locked_at, approved_by)
            VALUES ($1, $2, $3, $4, now(), $5)
            RETURNING *
            """,
            show_id,
            type,
            name,
            image_url,
            approved_by,
        )
        assert row is not None
        return ReferenceAsset(**dict(row))

    async def get_shot_versions(self, shot_id: UUID) -> list[ShotVersion]:
        rows = await self.pool.fetch(
            "SELECT * FROM shot_versions WHERE shot_id = $1 ORDER BY version_number", shot_id
        )
        return [ShotVersion(**dict(r)) for r in rows]

    async def get_latest_shot_version(self, shot_id: UUID) -> ShotVersion | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM shot_versions WHERE shot_id = $1 ORDER BY version_number DESC LIMIT 1",
            shot_id,
        )
        return ShotVersion(**dict(row)) if row else None

    async def insert_shot_version(
        self,
        *,
        shot_id: UUID,
        version_number: int,
        generation_prompt: str,
        generation_settings: dict[str, Any],
        video_asset_url: str | None,
        status: str,
    ) -> ShotVersion:
        row = await self.pool.fetchrow(
            """
            INSERT INTO shot_versions
                (shot_id, version_number, generation_prompt, generation_settings, video_asset_url, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            shot_id,
            version_number,
            generation_prompt,
            generation_settings,
            video_asset_url,
            status,
        )
        assert row is not None
        return ShotVersion(**dict(row))

    async def update_shot_version_status(self, shot_version_id: UUID, status: str) -> None:
        await self.pool.execute(
            "UPDATE shot_versions SET status = $2 WHERE id = $1", shot_version_id, status
        )

    async def update_shot_status(self, shot_id: UUID, status: str) -> None:
        await self.pool.execute("UPDATE shots SET status = $2 WHERE id = $1", shot_id, status)

    async def insert_approval_event(
        self,
        *,
        shot_id: UUID,
        shot_version_id: UUID,
        actor: str,
        decision: str,
        reason: str | None,
    ) -> ApprovalEvent:
        row = await self.pool.fetchrow(
            """
            INSERT INTO approval_events (shot_id, shot_version_id, actor, decision, reason)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            shot_id,
            shot_version_id,
            actor,
            decision,
            reason,
        )
        assert row is not None
        return ApprovalEvent(**dict(row))
