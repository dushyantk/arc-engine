# Dailies — Build Plan to Beta

Phased checklist. Each phase should leave the app runnable end-to-end at reduced scope — no phase
ships a mock that a later phase has to tear out. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
system design these phases implement.

---

## Phase 0 — Pivot & scaffold

- [x] Old "FateForge Multiverse" concept archived to `~/dev/blockbuster/arc-engine-archive/` (done
      prior to this plan — not this session's action, not touched here)
- [x] Repo re-initialized fresh at `~/dev/arc-engine`, docs moved to `docs/`
- [x] Design system locked: **Lab Bench** — see [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) and
      [`design/globals.css`](../design/globals.css)
- [x] Scaffold Next.js app (App Router, TypeScript, Tailwind v4, pnpm-enforced via `preinstall`) —
      `next 16.3.1`, `react 19.2.8`
- [x] `npx shadcn@latest init`, tokens wired into `app/globals.css` (kept in sync with
      `design/globals.css` by hand — see the setup notes in
      [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#setup-notes-phase-0--done) for the CLI's file-detection
      gotcha). Geist Sans/Mono come from `create-next-app`'s built-in `next/font/google`, no extra
      package needed.
- [x] Scaffold FastAPI sidecar (`server/`) — `uv`-managed, `fastapi`, `uvicorn`, `ruff`/`mypy`
      clean, `/health` verified
- [x] `docker-compose.yml`: Postgres (5451), ClickHouse (8124/9005), MinIO (9010/9011)
- [x] Update `~/dev/ports.md` Dailies entry to the new path (`~/dev/arc-engine`, no longer under
      `blockbuster/`) and current commands
- [x] `.env.example`: `DATABASE_URL`, `CLICKHOUSE_URL` (+ user/password), `MINIO_ENDPOINT` +
      keys + bucket, `GOOGLE_CLOUD_PROJECT` / `GOOGLE_APPLICATION_CREDENTIALS`, `AGENT_RUNTIME_URL`
- [x] Project `CLAUDE.md`: product identity + non-goals, so no future session drifts back to the
      viewer-choice concept
- [x] Connect the official ClickHouse MCP to this repo. Turned out to be two different things:
      the ClickHouse Cloud management MCP got connected first (org/service/billing tools, no
      Docker access, and the org has zero provisioned services) — kept as-is per decision below,
      not used for this project. The actual dev-tooling connection is the self-hostable
      `ClickHouse/mcp-clickhouse` server, configured in [`.mcp.json`](../.mcp.json) against the
      docker-compose instance (`localhost:8124`) and verified with a live query (server 24.10.2.80,
      `SHOW DATABASES` returned real results). New Claude Code sessions in this repo will prompt to
      approve it once.

## Phase 1 — Domain model & production memory

- [x] Drizzle schema: `shows`, `sequences`, `shots`, `shot_versions`, `reference_assets`,
      `approval_events` (Postgres) — [`db/schema.ts`](../db/schema.ts), pushed via `pnpm db:push`
- [x] ClickHouse DDL: `continuity_fingerprints`, `qc_findings`, `agent_decision_log` —
      [`server/clickhouse/schema.sql`](../server/clickhouse/schema.sql), applied via
      `pnpm ch:migrate`, verified through the `clickhouse-local` MCP
- [x] Zod schemas: `ShotBrief`, `ContinuityFingerprint`, `QCFinding`, `RevisionInstruction` —
      [`lib/schemas/index.ts`](../lib/schemas/index.ts)
- [x] Pydantic v2 mirrors in `server/models/contracts.py`
- [x] Seed script: the railway-station demo scene (Maya, red suitcase, SH010/SH020/SH030) —
      [`scripts/seed.ts`](../scripts/seed.ts) (`pnpm db:seed`). Full version history in Postgres
      (6 shot_versions across 3 shots); continuity fingerprints + QC findings in ClickHouse for
      the 3 versions that matter to the demo narrative. SH020 is deliberately left in `revise` at
      v002 — that's the shot the live agent session in Phase 2 picks up and carries to v003.

## Phase 2 — Generation & critique pipeline (the core loop)

- [ ] Reference asset ingestion: upload character/prop/environment refs → MinIO + Postgres, lock
- [ ] Planner agent: scene brief + ClickHouse continuity query → `ShotBrief` per shot. The query
      itself goes through an MCP client in the FastAPI runtime calling `mcp-clickhouse` (same
      server configured in `.mcp.json` for dev), not a bare `clickhouse-connect` call — that's
      the actual hackathon-track requirement, distinct from the dev-tooling connection above
- [ ] Veo 3.1 generation adapter: image-conditioned + first/last-frame calls → `shot_versions` row
- [ ] Supervisor/Critic agent: multimodal comparison against refs + neighbor shots → `QCFinding[]`,
      explicitly prompted to separate creative variation from generative defect
- [ ] Revision agent: FAILed findings → `RevisionInstruction` → re-trigger generation with locked refs
- [ ] Approval gate: deterministic status transitions, revision-round cap, `needs_human` escalation
- [ ] Every agent step writes to `agent_decision_log` (model, tokens, cost, latency) — no silent steps
- [ ] Malformed critic output is a hard stop with a visible error, not a silently-accepted pass

**Exit criteria for this phase**: run the seeded 3-shot sequence through the full loop end-to-end
from the command line (no UI yet) and get an `approved` sequence with a real revision history.

## Phase 3 — Dashboard (Next.js)

- [ ] Sequence view: shot thumbnails, status badges, live agent-session indicator
- [ ] Shot detail: version history, scrubber with timestamp-anchored QC notes, reference panel,
      provenance/lineage panel
- [ ] Live dailies session view: real-time plan → generate → critique → revise log (SSE/WebSocket
      from FastAPI) — this is the demo centerpiece
- [ ] Sequence playback: approved shots played back to back
- [ ] Empty, loading, and error states for every view — no bare spinners, no unhandled fetch failures

## Phase 4 — Export & handoff

- [ ] VFX package export: `plate/ gen/ refs/ metadata/` tree + `manifest.json` / `generation.json`
      / `provenance.json` / `qc.json` / `notes.json`
- [ ] Nuke script template generator (`.nk`: Read plate, Read gen, Merge, OCIO, Grain, Write)
- [ ] Export panel UI: package tree preview + Nuke script preview + download

## Phase 5 — Beta hardening

- [ ] Smoke tests: Postgres + ClickHouse connectivity, one seeded shot through the full agent loop
- [ ] Playwright e2e: sequence view → shot detail → approve → export, happy path
- [ ] Cost/latency view sourced from `agent_decision_log` (dashboard, not just raw table)
- [ ] `pnpm build` clean, FastAPI starts clean, docker-compose up clean from a fresh checkout
- [ ] README with quickstart commands and the demo script (3-shot railway sequence, 7 generations
      to converge, per the pitch)
- [ ] Beta release: tag, confirm demo runs unattended start to finish

---

## Explicit scope decisions (ask before reversing these)

- **No auth for beta.** Single operator, local/demo deployment. Multi-tenant auth is an additive
  layer later, not a beta requirement.
- **No Parallel / IBM watsonx integrations.** Those belonged to the old multiverse concept's
  sponsor lineup, not to this product.
- **FastAPI owns the agent loop; Next.js owns CRUD reads + the dashboard.** Python has the mature
  Gemini/Veo SDKs and the async loop is easier there than in a route handler.
- **Product surface name is "Dailies"; directory/ports stay `arc-engine`.** No path rename, no
  ports.md renumber — same reserved block, new description.
- **ClickHouse stays local (docker-compose), not ClickHouse Cloud.** A ClickHouse Cloud
  organization got connected via MCP on 2026-08-17 but has zero provisioned services and no
  "create service" tool exists to provision one unattended — that would need the ClickHouse Cloud
  console. Decided to keep the free, already-working Docker instance rather than take on a cloud
  dependency for a beta/demo. Revisit before the actual submission if "runs against localhost"
  reads as less credible than a Cloud service to whoever's judging it.
