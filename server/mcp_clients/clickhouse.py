"""The agent's own connection to the ClickHouse MCP server — distinct from
the `clickhouse-local` entry in .mcp.json, which is Claude Code's dev-session
connection. This is what satisfies the actual requirement: the planner
agent calling the official ClickHouse MCP as a tool during its own
reasoning, not a hardcoded SQL query. Same underlying `mcp-clickhouse`
server, same local instance, different caller.
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


def _server_params() -> StdioServerParameters:
    return StdioServerParameters(
        command="uv",
        args=["run", "--with", "mcp-clickhouse", "--python", "3.10", "mcp-clickhouse"],
        # cwd matters: this FastAPI process itself runs via `uv run` inside server/, whose
        # pyproject.toml requires Python >=3.12. Without an explicit neutral cwd here, the
        # inner `uv run --python 3.10` inherits server/ as its cwd, walks up to
        # server/pyproject.toml, and refuses the 3.10 override for a >=3.12 project.
        cwd="/tmp",
        env={
            "CLICKHOUSE_HOST": os.environ.get("CLICKHOUSE_HOST", "localhost"),
            "CLICKHOUSE_PORT": os.environ.get("CLICKHOUSE_PORT", "8124"),
            "CLICKHOUSE_USER": os.environ.get("CLICKHOUSE_USER", "default"),
            "CLICKHOUSE_PASSWORD": os.environ.get("CLICKHOUSE_PASSWORD", ""),
            "CLICKHOUSE_SECURE": os.environ.get("CLICKHOUSE_SECURE", "false"),
            "CLICKHOUSE_DATABASE": os.environ.get("CLICKHOUSE_DATABASE", "dailies"),
        },
    )


@asynccontextmanager
async def clickhouse_mcp_session() -> AsyncIterator[ClientSession]:
    async with (
        stdio_client(_server_params()) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        yield session
