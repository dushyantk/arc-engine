"""Applies schema.sql to the ClickHouse instance at CLICKHOUSE_HOST.

Usage: uv run --directory server python clickhouse/migrate.py
"""

import os
import re
import sys
from pathlib import Path

import clickhouse_connect

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import env


def main() -> None:
    # Without this the repo .env is never read and every setting silently falls
    # back to its default. Found the hard way: a fresh checkout configured for a
    # ClickHouse on another port had its schema applied to whatever happened to
    # be on 8124 instead, and still printed "done."
    env.bootstrap()

    schema_path = Path(__file__).parent / "schema.sql"
    statements = [
        s.strip()
        for s in re.split(r";\s*\n", schema_path.read_text())
        if s.strip()
    ]

    host = os.environ.get("CLICKHOUSE_HOST", "localhost")
    port = int(os.environ.get("CLICKHOUSE_PORT", "8124"))
    database = os.environ.get("CLICKHOUSE_DATABASE", "dailies")

    # Named before the work, not after. "done." on its own cannot be checked
    # against what the operator meant to migrate.
    print(f"migrating {database} at {host}:{port}")

    client = clickhouse_connect.get_client(
        host=host,
        port=port,
        username=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
        secure=os.environ.get("CLICKHOUSE_SECURE", "false").lower() == "true",
    )

    for statement in statements:
        client.command(statement)
        print(f"applied: {statement.splitlines()[0][:80]}...")

    # Proves the work rather than announcing it. A migration that reports success
    # while the database it claims to have made is absent is worse than one that
    # fails: the next command inherits the confusion and gets blamed for it.
    tables = {
        row[0]
        for row in client.query(
            "SELECT name FROM system.tables WHERE database = %(db)s", {"db": database}
        ).result_rows
    }
    expected = {"continuity_fingerprints", "qc_findings", "agent_decision_log"}
    missing = expected - tables
    if missing:
        raise SystemExit(
            f"migration reported success but {database} at {host}:{port} is missing "
            f"{', '.join(sorted(missing))}. Nothing downstream will work; check "
            f"CLICKHOUSE_HOST/CLICKHOUSE_PORT in .env."
        )

    print(f"done. {database} at {host}:{port} has {', '.join(sorted(expected))}.")


if __name__ == "__main__":
    main()
