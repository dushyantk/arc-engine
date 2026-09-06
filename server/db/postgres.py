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

from agents.materialise import ExistingShot, MaterialisationPlan
from db.models import (
    ApprovalEvent,
    Breakdown,
    ReferenceAsset,
    Script,
    Sequence,
    Shot,
    ShotVersion,
    Show,
)


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

    async def find_shot_by_code(
        self, shot_code: str, show_name: str | None = None
    ) -> tuple[Shot, Show, Sequence]:
        """Cross-show shot lookup. Shot codes are only unique within a
        sequence now that multiple real shows exist - pass show_name to
        disambiguate, or this errors if the code matches more than one
        show. (Previously this always searched a single hardcoded show,
        which broke for real the moment a second show existed.)"""
        # sh.sequence_id (from sh.*) already equals sq.id via the join - no
        # need to re-select it under another name.
        base_query = """
            SELECT sh.*, sq.code AS sequence_code, sq.description AS sequence_description,
                   sq.status AS sequence_status, sq.continuity_notes AS sequence_continuity_notes,
                   sq.continuity_checked_at AS sequence_continuity_checked_at,
                   s.id AS show_id, s.name AS show_name, s.created_at AS show_created_at
            FROM shots sh
            JOIN sequences sq ON sq.id = sh.sequence_id
            JOIN shows s ON s.id = sq.show_id
            WHERE sh.code = $1
        """
        if show_name is not None:
            rows = await self.pool.fetch(base_query + " AND s.name = $2", shot_code, show_name)
        else:
            rows = await self.pool.fetch(base_query, shot_code)

        if not rows:
            raise LookupError(
                f"no shot {shot_code!r} found"
                + (f" in show {show_name!r}" if show_name else "")
            )
        if len(rows) > 1:
            shows = sorted({r["show_name"] for r in rows})
            if len(shows) > 1:
                raise LookupError(
                    f"shot {shot_code!r} exists in more than one show "
                    f"({', '.join(shows)}) - name the show to disambiguate"
                )
            # Same show, so naming it would not disambiguate anything. Saying
            # "more than one show" here would assert a cause that is not true and
            # send the operator to fix their side for our lapse: shot codes are
            # required to be unique within a show, and these are not.
            sequences = ", ".join(sorted(r["sequence_code"] for r in rows))
            raise LookupError(
                f"shot {shot_code!r} is not unique within show {shows[0]!r} - it exists in "
                f"sequences {sequences}. Shot codes must be unique per show; this show's data "
                f"violates that and no argument can pick between them."
            )
        row = rows[0]
        shot = Shot(**{k: row[k] for k in Shot.model_fields})
        show = Show(id=row["show_id"], name=row["show_name"], created_at=row["show_created_at"])
        sequence = Sequence(
            id=row["sequence_id"],
            show_id=row["show_id"],
            code=row["sequence_code"],
            description=row["sequence_description"],
            status=row["sequence_status"],
            continuity_notes=row["sequence_continuity_notes"],
            continuity_checked_at=row["sequence_continuity_checked_at"],
        )
        return shot, show, sequence

    async def update_shot_brief(self, shot_id: UUID, brief: str) -> None:
        await self.pool.execute(
            "UPDATE shots SET brief = $2 WHERE id = $1", shot_id, brief
        )

    async def update_sequence_continuity(
        self, sequence_id: UUID, *, status: str, notes: str
    ) -> None:
        await self.pool.execute(
            """
            UPDATE sequences
            SET status = $2, continuity_notes = $3, continuity_checked_at = now()
            WHERE id = $1
            """,
            sequence_id,
            status,
            notes,
        )

    async def get_reference_assets(self, show_id: UUID) -> list[ReferenceAsset]:
        rows = await self.pool.fetch(
            "SELECT * FROM reference_assets WHERE show_id = $1 AND locked_at IS NOT NULL",
            show_id,
        )
        return [ReferenceAsset(**dict(r)) for r in rows]

    async def get_all_reference_assets(self, show_id: UUID) -> list[ReferenceAsset]:
        """Every reference, locked or not.

        Deliberately separate from get_reference_assets, which returns only
        canon and is what every agent reads. This one exists for the operator
        surfaces - deciding whether a sheet still needs generating means seeing
        the ones that are not canon yet. Never wire an agent to this.
        """
        rows = await self.pool.fetch(
            "SELECT * FROM reference_assets WHERE show_id = $1 ORDER BY name", show_id
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

    async def insert_generated_reference(
        self,
        *,
        show_id: UUID,
        type: str,
        name: str,
        image_url: str,
        breakdown_id: UUID | None,
        generation_prompt: str,
        generation_model: str,
    ) -> ReferenceAsset:
        """A generated sheet, landing UNLOCKED.

        Deliberately a separate method from insert_reference_asset, which locks
        on insert because an operator uploading a plate is asserting it as canon
        by the act of uploading it. A generated image asserts nothing. Leaving
        locked_at NULL is what keeps it out of get_reference_assets, and
        therefore out of the planner, the critic and the generation adapter,
        until a human locks it. Same column, same verb, no second gate.
        """
        row = await self.pool.fetchrow(
            """
            INSERT INTO reference_assets
                (show_id, type, name, image_url, locked_at, approved_by,
                 source, generated_from_breakdown_id, generation_prompt, generation_model)
            VALUES ($1, $2, $3, $4, NULL, NULL, 'generated', $5, $6, $7)
            RETURNING *
            """,
            show_id,
            type,
            name,
            image_url,
            breakdown_id,
            generation_prompt,
            generation_model,
        )
        assert row is not None
        return ReferenceAsset(**dict(row))

    async def get_scripts(self, show_id: UUID) -> list[Script]:
        rows = await self.pool.fetch(
            "SELECT * FROM scripts WHERE show_id = $1 ORDER BY version_number DESC", show_id
        )
        return [Script(**dict(r)) for r in rows]

    async def insert_script(
        self,
        *,
        show_id: UUID,
        source_prompt: str,
        logline: str,
        synopsis: str,
        body: str,
    ) -> Script:
        """Always a new version, never an edit - the script a breakdown was made
        from has to stay readable after the script moves on."""
        row = await self.pool.fetchrow(
            """
            INSERT INTO scripts
                (show_id, version_number, source_prompt, logline, synopsis, body, status)
            VALUES (
                $1,
                (SELECT coalesce(max(version_number), 0) + 1 FROM scripts WHERE show_id = $1),
                $2, $3, $4, $5, 'draft'
            )
            RETURNING *
            """,
            show_id,
            source_prompt,
            logline,
            synopsis,
            body,
        )
        assert row is not None
        return Script(**dict(row))

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
        brief_used: str | None = None,
        poster_asset_url: str | None = None,
    ) -> ShotVersion:
        row = await self.pool.fetchrow(
            """
            INSERT INTO shot_versions
                (shot_id, version_number, generation_prompt, generation_settings, video_asset_url,
                 status, brief_used, poster_asset_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
            """,
            shot_id,
            version_number,
            generation_prompt,
            generation_settings,
            video_asset_url,
            status,
            brief_used,
            poster_asset_url,
        )
        assert row is not None
        return ShotVersion(**dict(row))

    async def set_shot_version_poster(self, shot_version_id: UUID, poster_asset_url: str) -> None:
        await self.pool.execute(
            "UPDATE shot_versions SET poster_asset_url = $2 WHERE id = $1",
            shot_version_id,
            poster_asset_url,
        )

    async def update_shot_version_status(self, shot_version_id: UUID, status: str) -> None:
        await self.pool.execute(
            "UPDATE shot_versions SET status = $2 WHERE id = $1", shot_version_id, status
        )

    async def update_shot_status(self, shot_id: UUID, status: str) -> None:
        await self.pool.execute("UPDATE shots SET status = $2 WHERE id = $1", shot_id, status)

    async def has_approved_version(self, shot_id: UUID) -> bool:
        """Whether any version of this shot currently carries an approval.

        Latest and approved are independent axes, so this is deliberately not
        "is the newest version approved" - see resolve_shot_status().
        """
        row = await self.pool.fetchrow(
            "SELECT 1 FROM shot_versions WHERE shot_id = $1 AND status = 'approved' LIMIT 1",
            shot_id,
        )
        return row is not None

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
            INSERT INTO approval_events
                (subject_type, shot_id, shot_version_id, actor, decision, reason)
            VALUES ('shot_version', $1, $2, $3, $4, $5)
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

    # -- Breakdowns -------------------------------------------------------

    async def get_approved_script(self, show_id: UUID) -> Script | None:
        """The one script a breakdown may be made from. There is at most one:
        approving a script supersedes the previously approved one."""
        row = await self.pool.fetchrow(
            "SELECT * FROM scripts WHERE show_id = $1 AND status = 'approved'", show_id
        )
        return Script(**dict(row)) if row else None

    async def get_breakdowns(self, script_id: UUID) -> list[Breakdown]:
        rows = await self.pool.fetch(
            "SELECT * FROM breakdowns WHERE script_id = $1 ORDER BY version_number DESC", script_id
        )
        return [Breakdown(**dict(r)) for r in rows]

    async def get_breakdown(self, breakdown_id: UUID) -> Breakdown:
        row = await self.pool.fetchrow("SELECT * FROM breakdowns WHERE id = $1", breakdown_id)
        if row is None:
            raise LookupError(f"breakdown {breakdown_id} not found")
        return Breakdown(**dict(row))

    async def insert_breakdown(self, *, script_id: UUID, payload: dict[str, Any]) -> Breakdown:
        """A new version per attempt, like scripts and shot versions. A
        breakdown that was rejected stays readable next to the one that won."""
        row = await self.pool.fetchrow(
            """
            INSERT INTO breakdowns (script_id, version_number, payload, status)
            VALUES (
                $1,
                (SELECT coalesce(max(version_number), 0) + 1
                   FROM breakdowns WHERE script_id = $1),
                $2, 'draft'
            )
            RETURNING *
            """,
            script_id,
            payload,
        )
        assert row is not None
        return Breakdown(**dict(row))

    async def get_existing_shape(self, show_id: UUID) -> dict[str, dict[str, ExistingShot]]:
        """What already exists for this show, keyed the way a breakdown talks:
        sequence code -> shot code -> shot.

        `has_versions` is computed here rather than inferred from status,
        because status is a judgement and versions are a fact - and the fact is
        what decides whether a shot may be rewritten.
        """
        rows = await self.pool.fetch(
            """
            SELECT sq.code AS sequence_code,
                   sh.code AS shot_code,
                   sh.brief,
                   EXISTS (SELECT 1 FROM shot_versions v WHERE v.shot_id = sh.id) AS has_versions
            FROM sequences sq
            LEFT JOIN shots sh ON sh.sequence_id = sq.id
            WHERE sq.show_id = $1
            """,
            show_id,
        )
        shape: dict[str, dict[str, ExistingShot]] = {}
        for r in rows:
            # LEFT JOIN: a sequence with no shots still has to appear, or it
            # would be planned as a create and collide on insert.
            bucket = shape.setdefault(r["sequence_code"], {})
            if r["shot_code"] is None:
                continue
            bucket[r["shot_code"]] = ExistingShot(
                code=r["shot_code"], brief=r["brief"], has_versions=r["has_versions"]
            )
        return shape

    async def apply_materialisation(
        self, *, show_id: UUID, breakdown_id: UUID, plan: MaterialisationPlan
    ) -> None:
        """Writes the plan, in one transaction. Creates and brief updates only -
        the plan's skip actions are skips here too, and nothing is deleted.

        Transactional because a half-materialised shot list is worse than none:
        the operator would have to work out by hand which shots were real.
        """
        async with self.pool.acquire() as conn, conn.transaction():
            for seq in plan.sequences:
                sequence_id = await conn.fetchval(
                    "SELECT id FROM sequences WHERE show_id = $1 AND code = $2",
                    show_id,
                    seq.code,
                )
                if sequence_id is None:
                    sequence_id = await conn.fetchval(
                        """
                        INSERT INTO sequences (show_id, code, description, status)
                        VALUES ($1, $2, $3, 'pending') RETURNING id
                        """,
                        show_id,
                        seq.code,
                        seq.description,
                    )

                for shot in seq.shots:
                    if shot.action == "create":
                        await conn.execute(
                            """
                            INSERT INTO shots
                                (sequence_id, code, order_index, screen_direction, brief,
                                 status, created_from_breakdown_id)
                            VALUES ($1, $2, $3, $4, $5, 'pending', $6)
                            """,
                            sequence_id,
                            shot.code,
                            shot.order_index,
                            shot.screen_direction,
                            shot.brief,
                            breakdown_id,
                        )
                    elif shot.action == "update_brief":
                        # Provenance is not touched on an update. The shot was
                        # created by whatever created it; this breakdown only
                        # revised its brief, and claiming otherwise would
                        # rewrite history.
                        await conn.execute(
                            """
                            UPDATE shots SET brief = $1, screen_direction = $2, order_index = $3
                            WHERE sequence_id = $4 AND code = $5
                            """,
                            shot.brief,
                            shot.screen_direction,
                            shot.order_index,
                            sequence_id,
                            shot.code,
                        )

            await conn.execute(
                "UPDATE breakdowns SET status = 'materialised', materialised_at = now() "
                "WHERE id = $1",
                breakdown_id,
            )
