"""Shared fixtures. Loads the repo `.env` so a bare `pytest` works the same way
the entrypoints are meant to, rather than only under a shell that happened to
export the right variables.
"""

import os
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_env() -> None:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        # Never clobber something the caller set deliberately.
        os.environ.setdefault(key.strip(), value.strip())


_load_env()


@pytest.fixture(scope="session")
def clickhouse_url() -> str:
    host = os.environ.get("CLICKHOUSE_HOST", "localhost")
    port = os.environ.get("CLICKHOUSE_PORT", "8124")
    return f"http://{host}:{port}/"
