# Dailies

> An agentic GenFX supervisor that makes an AI-generated sequence survive dailies.

Give it a scene. Dailies plans the shot against the approved continuity state, generates it with
Veo 3.1, watches its own footage with Gemini, writes real dailies notes, regenerates what failed,
and doesn't approve the sequence until the shots agree with each other.

Generating a shot is easy. Making it belong in a movie is the problem.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Phased checklist:
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) · Visual system: [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)

## The loop

**Plan → Generate → Watch → Critique → Revise → Verify → Approve.**

| Stage | What actually happens |
| --- | --- |
| Plan | Gemini queries approved continuity state from ClickHouse before writing the prompt |
| Generate | Veo 3.1 renders a candidate from that grounded prompt, image-conditioned on locked references |
| Watch | The critic reviews labelled frames in order, not just the first and last |
| Critique | Every finding is pass, warning or fail — creative variation is not a defect |
| Revise | A failed finding becomes a concrete regeneration instruction, not a vague retry |
| Approve | Deterministic gate. Only when every hard failure clears; warnings are logged, never hidden |

Revision rounds are capped (4). On cap-out a shot escalates to `needs_human` rather than looping
or auto-approving.

## Stack

Next.js (pnpm) · FastAPI · Postgres · ClickHouse (production memory, via the official MCP) ·
MinIO · Gemini (planning + multimodal critique) · Veo 3.1 (generation)

## Quickstart

Requires **pnpm**, **uv**, **Docker**, and **ffmpeg** on PATH (used for frame extraction).

```bash
pnpm install
uv sync --directory server
docker compose up -d          # Postgres, ClickHouse, MinIO
cp .env.example .env          # then add GEMINI_API_KEY — see Credentials below
pnpm db:push                  # Postgres schema (Drizzle)
pnpm ch:migrate               # ClickHouse tables
pnpm db:seed                  # optional demo fixture; refuses to run if shows already exist
pnpm dev                      # web on 3210, agent runtime on 8091
```

### Credentials

`GEMINI_API_KEY` is the only credential needed. Veo 3.1 is reachable through the same Gemini
Developer API as the text and vision models — no separate Vertex AI project or service account.
`GOOGLE_APPLICATION_CREDENTIALS` remains in `.env.example` as an optional upgrade path for higher
quota, not as a requirement.

> Generation makes **real, billed** Veo calls. Nothing generates on startup, on test, or on page
> load — only an explicit run does, and the dashboard requires cost consent before starting one.

## Ports

Reserved in `~/dev/ports.md` under `Dailies (~/dev/arc-engine)`.

| Service | Port |
| --- | --- |
| Web (Next.js) | `3210` |
| Playwright e2e web server | `3211` |
| Agent runtime (FastAPI) | `8091` |
| Postgres | `5451` |
| ClickHouse | `8124` (HTTP) / `9005` (TCP) |
| MinIO | `9010` (API) / `9011` (console) |

## Tests

```bash
pnpm lint                                   # eslint
pnpm build                                  # next build
uv run --directory server pytest            # contracts, approval gate, stack smoke
uv run --directory server pytest -m stack   # only the stack-dependent smoke tests
uv run --directory server ruff check .
uv run --directory server mypy .
pnpm test:e2e                               # Playwright, happy path
```

Nothing in the test suites spends money. The approval gate's ClickHouse logging is stubbed out in
tests so running them cannot write to the real decision log, and the stack smoke tests skip rather
than fail when Docker isn't up. The "seeded shot through the full agent loop" the build plan
mentions is deliberately *not* a test — that path makes billed Veo and Gemini calls, and a suite
must never be able to spend money by being run.

## Running the loop

The dashboard drives everything: create a show, sequence and shot, author a brief, upload and lock
references, start a run with explicit cost consent, watch it live, and approve, reject or veto any
version with a recorded reason.

The same loop is scriptable:

```bash
# Plan → generate → critique → approve for one shot. Costs real money.
uv run --directory server python run_session.py --shot SH020 --show "Platform Chase"

# Free: re-run the critic against footage already stored, no generation
uv run --directory server python run_session.py --shot SH020 --recritique-version 5

# Backfill poster stills for versions generated before posters existed
uv run --directory server python backfill_posters.py --dry-run
```

## Export

An approved shot exports a real VFX handoff package — `plate/ gen/ refs/ metadata/` plus a
templated Nuke script — with provenance traced from the actual run that produced it:

```
SQ010_SH030/
    gen/SH030_gen_v003.mov
    refs/{character,suitcase,environment}.png
    metadata/{manifest,generation,provenance,qc,notes}.json
    SH030_comp.nk
```

## Status

Pre-beta, and the numbers on the landing page are read live from `agent_decision_log` rather than
written by hand. Real spend to date is visible in the dashboard. Current phase and the remaining
work are tracked in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).
