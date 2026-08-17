# Dailies — Build Plan to Beta

Phased checklist. Each phase should leave the app runnable end-to-end at reduced scope — no phase
ships a mock that a later phase has to tear out. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
system design these phases implement.

---

## Phase 0 — Pivot & scaffold

- [x] Old "FateForge Multiverse" concept archived to `../arc-engine-archive/` (done prior to this
      plan — not this session's action, not touched here)
- [x] Repo re-initialized fresh at `~/dev/arc-engine`, docs moved to `docs/`
- [x] Design system locked: **Lab Bench** — see [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) and
      [`design/globals.css`](../design/globals.css)
- [ ] Scaffold Next.js app (App Router, TypeScript, Tailwind v4, pnpm-enforced via `preinstall`)
- [ ] `pnpm add geist`, `npx shadcn@latest init` (cssVariables: true, base color neutral), then
      replace the generated token block in `app/globals.css` with `design/globals.css`
- [ ] Scaffold FastAPI sidecar (`server/`)
- [ ] `docker-compose.yml`: Postgres (5451), ClickHouse (8124/9005), MinIO (9010/9011)
- [x] Update `~/dev/ports.md` ArcEngine entry description to reflect Dailies (ports unchanged)
- [ ] `.env.example`: `DATABASE_URL`, `CLICKHOUSE_URL`, `GOOGLE_APPLICATION_CREDENTIALS` /
      Vertex project config, `MINIO_ENDPOINT` + keys
- [x] Project `CLAUDE.md`: product identity + non-goals, so no future session drifts back to the
      viewer-choice concept
- [ ] Connect the official ClickHouse MCP server to this session/repo and confirm a live query
      against the docker-compose ClickHouse instance — this is a hard requirement for the
      production-memory feature, not optional tooling

## Phase 1 — Domain model & production memory

- [ ] Drizzle schema: `shows`, `sequences`, `shots`, `shot_versions`, `reference_assets`,
      `approval_events` (Postgres)
- [ ] ClickHouse DDL: `continuity_fingerprints`, `qc_findings`, `agent_decision_log`
- [ ] Zod schemas: `ShotBrief`, `ContinuityFingerprint`, `QCFinding`, `RevisionInstruction`
- [ ] Pydantic v2 mirrors in `server/models/`
- [ ] Seed script: the railway-station demo scene (3 shots, character Maya, red suitcase) as
      canonical fixture data — this becomes the actual demo, not a throwaway seed

## Phase 2 — Generation & critique pipeline (the core loop)

- [ ] Reference asset ingestion: upload character/prop/environment refs → MinIO + Postgres, lock
- [ ] Planner agent: scene brief + ClickHouse continuity query → `ShotBrief` per shot
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
