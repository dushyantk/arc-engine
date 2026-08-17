# Dailies (this directory: `arc-engine`)

Product: agentic GenFX dailies supervisor. Plans a shot, generates it with Veo, watches it with
Gemini, writes real VFX notes, regenerates what failed, approves only when the sequence agrees
with itself. Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Phases:
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## Do not

- Do not reintroduce viewer-choice / branching-narrative / live-streaming features. That was the
  previous occupant of this directory (archived at `../arc-engine-archive/`, "FateForge Multiverse
  Engine") and it is a dead concept, not a reference architecture.
- Do not add Parallel search or IBM watsonx integrations — sponsor artifacts of the old shape,
  not requirements here.
- Do not add multi-tenant auth without being asked — beta is single-operator, local/demo.

## Ports

Reserved in `~/dev/ports.md` under `ArcEngine`, path `~/dev/blockbuster/arc-engine`: web `3210`,
FastAPI `8091`, Postgres `5451`, ClickHouse `8124`/`9005`, MinIO `9010`/`9011`. Read that file
before adding any new service or port.
