# The agent runtime: FastAPI, the agents, and the two binaries they shell out to.
#
# Not serverless, deliberately. A run is fired as a background task and the
# request returns immediately; real observed latencies are 72s for a Veo call and
# 390s for a critique. A function that gets killed at its timeout would bill for
# footage nobody receives.
FROM python:3.12-slim

# ffmpeg/ffprobe: video_frames.py shells out to both to extract the frames the
# critic reviews. Without them every critique fails.
# curl: fetches uv below, and gives the image a way to probe itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# uv is not just the package manager here: the planner spawns the ClickHouse MCP
# server with `uv run --with mcp-clickhouse`, so it has to exist at runtime too.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app/server
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev

COPY server/ ./

# Pre-fetch the MCP server into uv's cache so the first planning call does not
# pay to download it - and so a network blip at that moment is not a run failure.
RUN uv run --with mcp-clickhouse --python 3.10 python -c "print('mcp-clickhouse cached')" || true

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
# 0.0.0.0, not "::". ClickHouse binds "::" happily because Linux dual-stack
# accepts IPv4 on an IPv6 any-socket, but uvicorn sets IPV6_V6ONLY on that host,
# so the socket exists, answers on the machine's private IPv6, and refuses the
# proxy's IPv4 connection. The app then looks healthy from inside and 502s from
# outside - which is exactly what Fly's "is your app listening on 0.0.0.0:8080?"
# warning is trying to tell you.
CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
