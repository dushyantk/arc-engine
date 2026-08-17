"""Applies schema.sql to the ClickHouse instance at CLICKHOUSE_HOST.

Usage: uv run --directory server python clickhouse/migrate.py
"""

import os
import re
from pathlib import Path

import clickhouse_connect


def main() -> None:
    schema_path = Path(__file__).parent / "schema.sql"
    statements = [
        s.strip()
        for s in re.split(r";\s*\n", schema_path.read_text())
        if s.strip()
    ]

    client = clickhouse_connect.get_client(
        host=os.environ.get("CLICKHOUSE_HOST", "localhost"),
        port=int(os.environ.get("CLICKHOUSE_PORT", "8124")),
        username=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
        secure=os.environ.get("CLICKHOUSE_SECURE", "false").lower() == "true",
    )

    for statement in statements:
        client.command(statement)
        print(f"applied: {statement.splitlines()[0][:80]}...")

    print("done.")


if __name__ == "__main__":
    main()
