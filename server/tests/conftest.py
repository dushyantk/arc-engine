"""Shared fixtures. Loads the repo `.env` through the same helper the
entrypoints use, so `pytest` sees exactly the environment a real run would.
"""

import os

import pytest

from env import load_repo_env

load_repo_env()


@pytest.fixture(scope="session")
def clickhouse_url() -> str:
    host = os.environ.get("CLICKHOUSE_HOST", "localhost")
    port = os.environ.get("CLICKHOUSE_PORT", "8124")
    return f"http://{host}:{port}/"
