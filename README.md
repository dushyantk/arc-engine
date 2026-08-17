# Dailies

> An agentic GenFX supervisor that makes an AI-generated sequence survive dailies.

Give it a scene. Dailies generates the sequence, watches its own work, writes itself VFX notes,
regenerates what failed, and doesn't approve the sequence until the shots agree with each other.

Generating a shot is easy. Making it belong in a movie is the problem.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system design and
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) for the phased build checklist.

## Stack

Next.js (pnpm) · FastAPI · Postgres · ClickHouse (production memory, via the official MCP) ·
MinIO · Gemini (planning + multimodal critique) · Veo 3.1 (generation)

## Ports

| Service | Port |
| --- | --- |
| Web (Next.js) | `3210` |
| Playwright e2e | `3211` |
| Agent runtime (FastAPI) | `8091` |
| Postgres | `5451` |
| ClickHouse | `8124` (HTTP) / `9005` (TCP) |
| MinIO | `9010` (API) / `9011` (console) |

Reserved in `~/dev/ports.md` under `ArcEngine (~/dev/blockbuster/arc-engine)` — same block used
by this directory's previous occupant; unchanged.

## Quickstart

```bash
pnpm install
docker compose up -d          # Postgres, ClickHouse, MinIO
pnpm dev                      # web (3210) + api (8091)
```

## Status

Pre-beta. Follow [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) for current phase.
