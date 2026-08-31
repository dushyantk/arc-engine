"""Smoke tests: can this checkout actually reach its own stores, and do they
hold the shape the code expects?

Read-only by design. Nothing here writes, and nothing here calls a model - the
build plan's "one seeded shot through the full agent loop" is deliberately NOT
implemented as a test, because that path makes real billed Veo and Gemini calls
and a test suite must never be able to spend money by being run. What is covered
is everything that can be verified for free: connectivity, schema shape, and the
invariants the dashboard and the agent loop both depend on.

Skips rather than fails when the stack is down, so `pytest` is still useful
without `docker compose up`. Run the stack-dependent ones deliberately with:

    uv run --directory server pytest -m stack
"""

import os
import urllib.error
import urllib.request

import asyncpg
import pytest

pytestmark = pytest.mark.stack

EXPECTED_TABLES = {
    "shows",
    "sequences",
    "shots",
    "shot_versions",
    "reference_assets",
    "approval_events",
}

EXPECTED_CLICKHOUSE_TABLES = {
    "continuity_fingerprints",
    "qc_findings",
    "agent_decision_log",
}


async def _connect() -> asyncpg.Connection:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("DATABASE_URL not set")
    try:
        return await asyncpg.connect(dsn)
    except (OSError, asyncpg.PostgresError) as exc:
        pytest.skip(f"Postgres unreachable: {exc}")


def _clickhouse(url: str, query: str) -> str:
    try:
        with urllib.request.urlopen(f"{url}?query={urllib.parse.quote(query)}", timeout=5) as r:
            body: bytes = r.read()
            return body.decode()
    except (urllib.error.URLError, OSError) as exc:
        pytest.skip(f"ClickHouse unreachable: {exc}")


class TestPostgres:
    async def test_every_expected_table_exists(self) -> None:
        conn = await _connect()
        try:
            rows = await conn.fetch(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
            )
        finally:
            await conn.close()
        present = {row["tablename"] for row in rows}
        assert EXPECTED_TABLES <= present, f"missing: {EXPECTED_TABLES - present}"

    async def test_shot_versions_carries_the_columns_the_product_reads(self) -> None:
        """poster_asset_url and brief_used were both added after the original
        schema; a checkout that skipped `pnpm db:push` fails here rather than
        at render time with a confusing query error."""
        conn = await _connect()
        try:
            rows = await conn.fetch(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'shot_versions'"
            )
        finally:
            await conn.close()
        columns = {row["column_name"] for row in rows}
        assert {"poster_asset_url", "brief_used", "video_asset_url"} <= columns

    async def test_no_shot_is_approved_without_an_approved_version(self) -> None:
        """The invariant behind resolve_shot_status(): shot status is resolved
        from the approval record, so an approved shot with no approved version
        anywhere would mean something wrote the shot directly."""
        conn = await _connect()
        try:
            orphans = await conn.fetch(
                """
                SELECT s.code FROM shots s
                 WHERE s.status = 'approved'
                   AND NOT EXISTS (
                     SELECT 1 FROM shot_versions v
                      WHERE v.shot_id = s.id AND v.status = 'approved')
                """
            )
        finally:
            await conn.close()
        assert not orphans, f"approved with no approved version: {[r['code'] for r in orphans]}"


class TestClickHouse:
    def test_every_expected_table_exists(self, clickhouse_url: str) -> None:
        database = os.environ.get("CLICKHOUSE_DATABASE", "dailies")
        out = _clickhouse(clickhouse_url, f"SHOW TABLES FROM {database}")
        present = set(out.split())
        assert EXPECTED_CLICKHOUSE_TABLES <= present, (
            f"missing: {EXPECTED_CLICKHOUSE_TABLES - present}"
        )

    def test_agent_name_enum_covers_every_agent_that_logs(self, clickhouse_url: str) -> None:
        """A value outside the Enum8 is silently coerced to NULL rather than
        rejected - that really happened when the continuity agent was added, and
        cost a debugging session. This fails loudly if an agent is missing."""
        database = os.environ.get("CLICKHOUSE_DATABASE", "dailies")
        out = _clickhouse(
            clickhouse_url,
            f"SELECT type FROM system.columns WHERE database = '{database}' "
            f"AND table = 'agent_decision_log' AND name = 'agent_name'",
        )
        # TSV escapes the quotes inside the type string as \' - compare unescaped.
        out = out.replace("\\'", "'")
        for agent in (
            "planner",
            "generation_adapter",
            "critic",
            "revision_agent",
            "approval_gate",
            "continuity_agent",
            "story_agent",
            "identity_check",
        ):
            assert f"'{agent}'" in out, f"{agent} missing from agent_name enum"

    def test_no_decision_row_lost_its_agent_name(self, clickhouse_url: str) -> None:
        database = os.environ.get("CLICKHOUSE_DATABASE", "dailies")
        out = _clickhouse(
            clickhouse_url,
            f"SELECT count() FROM {database}.agent_decision_log WHERE agent_name IS NULL",
        )
        assert out.strip() == "0", f"{out.strip()} rows silently coerced to NULL agent_name"


class TestMinio:
    def test_bucket_is_reachable(self) -> None:
        from storage.minio_client import get_client

        bucket = os.environ.get("MINIO_BUCKET", "dailies")
        try:
            client = get_client()
            exists = client.bucket_exists(bucket)
        except Exception as exc:  # noqa: BLE001 - any transport failure means "not up"
            pytest.skip(f"MinIO unreachable: {exc}")
        assert exists, f"bucket {bucket!r} does not exist"
