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

All pieces below are real implementations, verified against the live local stack (Postgres,
ClickHouse, MinIO, real Gemini calls) — not mocked, not just type-checked. Two real SDK bugs were
found and fixed along the way; see [`server/agents/planner.py`](../server/agents/planner.py) and
[`server/models/contracts.py`](../server/models/contracts.py) comments for what and why.

- [x] Reference asset ingestion: [`server/reference_ingestion.py`](../server/reference_ingestion.py)
      — upload → MinIO, lock → Postgres. Verified with a real upload + byte-for-byte read-back.
- [x] Planner agent: [`server/agents/planner.py`](../server/agents/planner.py). Verified live — the
      agent queried `dailies.continuity_fingerprints` and `dailies.qc_findings` through its own MCP
      tool calls (not a hardcoded query) and produced a `ShotBrief` grounded in what it found,
      including the exact suitcase hex color from seeded data.
- [x] Supervisor/Critic agent: [`server/agents/critic.py`](../server/agents/critic.py). Verified
      with a synthetic test clip (real multimodal call, real schema validation) — full QC judgment
      needs real footage, see below.
- [x] Revision agent: [`server/agents/revision.py`](../server/agents/revision.py). Verified against
      the real seeded SH020 v002 findings — correctly targeted v003, locked the right refs.
- [x] Approval gate: [`server/agents/approval.py`](../server/agents/approval.py). Deterministic,
      unit-verified: fail → revise, fail at round cap → needs_human, warnings-only → approved.
- [x] Every agent step writes to `agent_decision_log` — confirmed real cost/token/latency rows in
      ClickHouse after each of the above (e.g. ~$0.01 for a full plan_shot call).
- [x] Malformed output is a hard stop: every structured call raises on `response.parsed is None`
      or a Pydantic validation failure, not caught or swallowed anywhere in the chain.
- [x] Added an outer retry/backoff layer ([`server/retry.py`](../server/retry.py)) after hitting
      transient 503s specifically on MCP-tool-enabled calls during verification — not just relying
      on the SDK's own internal retry.
- [x] **Veo 3.1 generation adapter**: [`server/agents/generation.py`](../server/agents/generation.py).
      Run for real on 2026-08-17 (SH020 v003, `veo-3.1-generate-preview`, quality tier, ~$3.20,
      user-approved). Two real bugs found on the first live call, both fixed: the Developer API
      rejects the `seed` config field outright (Vertex-only), and downloading the result needs
      `client.aio.files.download()` — a raw `httpx.get()` on the returned URI 302-redirects and
      has no auth, so it fails. The already-billed video was recovered via the Files API by file
      ID rather than re-generating.
      [`run_session.py --reuse-video`](../server/run_session.py) now exists so the critic/approval
      logic can be iterated on without paying for another generation each time.

**Real result, not staged**: SH020 v003 fixed the original bug (suitcase stayed red, not brown —
the planner's continuity-grounded prompt worked) but the critic caught two new issues: the
suitcase in the wrong hand, and the background clock still legible with mutating hands. Approval
gate correctly returned `revise`, not a rubber-stamped pass. Revision agent proposed a side-profile
framing for v004 that plausibly fixes both at once. This is the real product behavior — continuity
whack-a-mole — not a rigged demo. Full record, including the exact prompt and cost breakdown:
`generations/LEDGER.md` (gitignored — real generated video doesn't belong in git history).

**A "no silent steps" gap this run found**: the $3.20 Veo charge above was originally missing
from `agent_decision_log` — the download step crashed (see the fix above) after the money was
spent but before `log_decision()` ran. Fixed by moving the log call to right after the Veo
operation itself succeeds, not after the download; the missing entry was backfilled by hand with
the real cost. See `generations/LEDGER.md` for the full account.

**A critic-reliability finding, architectural not cosmetic**: holistic "watch the video" judgment
missed a real defect (a suitcase duplicating across both hands for ~1s, then settling into the
wrong one) — once calling it a static "wrong hand" and, after a first tightening attempt, once
missing it entirely. Verified by hand (frame-by-frame extraction) that the defect was real both
times. The fix that actually worked: [`video_frames.py`](../server/video_frames.py) extracts N
evenly-spaced labeled stills, and the critic prompt requires stating the prop's hand for *every*
labeled frame in order rather than trusting continuous playback. Confirmed reliable across two
independent re-runs. Lesson for any future QC category that tracks a discrete attribute over time
(hand, position, held object): prefer explicit frame-by-frame comparison over holistic video
judgment. Full narrative: `generations/LEDGER.md`.

**Exit criteria for this phase**: run the seeded 3-shot sequence through the full loop end-to-end
from the command line (no UI yet) and get an `approved` sequence with a real revision history.

**Status: exit criteria met — SQ010 is approved.** Six real generations (v001–v006, four of them
real Veo calls: v003–v006), a real root-cause investigation into three separate defect classes
(hand laterality, character appearance drift, subject-vs-camera motion), a real fix verified to
work (screen-left/screen-right vocabulary, exclude-vs-blur framing), and a reproducibility test
(`--reuse-prompt-from-version`) that separated genuine systematic defects from one-off stochastic
noise. SH020 sat at `needs_human` for a while — past the 4-round cap, with the background clock as
the one real remaining fail. It reached `approved` on 2026-08-17 not through a new engineered fix,
but from a routine re-critique of the existing v5 footage (run while building and verifying the
live session view — see `generations/LEDGER.md` Phase 3 §16–17): the critic's own judgment on the
exact same video differed run to run, finding 0 fails and 1 tolerated warning this time against a
harder finding previously. Worth being honest about rather than spinning as "solved": this is
real evidence the critic isn't perfectly deterministic, not proof the clock defect is structurally
fixed. All three shots (SH010, SH020, SH030) now read `approved`, but note SH020's *latest*
version is still v6, marked `failed` — `shot.status` reflects the outcome of the most recent
evaluation action, not necessarily of the latest version, so the sequence card and the version list
can legitimately disagree at a glance. Left as real, unmassaged data rather than reconciled by
hand; worth a real product decision later (see Phase 3 note below). Total real spend so far:
**$13.23**, 55 API calls, 4 real Veo generations.

## Phase 3 — Dashboard (Next.js)

- [x] Landing page: real product pitch, not hackathon enthusiasm — real hero frame from v006, real
      critic findings quoted verbatim, real spend/call stats, defect categories that map to actual
      `QCFinding` categories. `app/page.tsx`.
- [x] Sequence view: shot thumbnails (real thumbnail for SH020, honest placeholder for seed-only
      shots), status badges. `app/dashboard/page.tsx`.
- [x] Shot detail: version history with real video playback (MinIO via a Range-request-aware API
      route), generation prompt text, approval-event trail. `app/dashboard/[shotCode]/page.tsx`.
- [x] Empty state for versions with no uploaded video (seed data) — fixed an SSR race where the
      fallback silently failed to appear; see `generations/LEDGER.md` Phase 3 §14.
- [x] Live dailies session view: real-time plan → generate → critique → revise log. Built as a
      Next.js SSE route polling ClickHouse directly (`app/api/sessions/[runId]/stream/route.ts`,
      1s interval) rather than FastAPI SSE/WebSocket — same direct-ClickHouse-read pattern as the
      QC report and rail stats, and it means the view works regardless of what actually triggered
      the run (today: the CLI; later: a FastAPI-triggered job) since it just tails the real log
      table. `app/dashboard/sessions/` (list + live detail), `components/live-session-log.tsx`.
      Live-streaming behavior (not just historical replay) verified against a real
      `--recritique-version` run — see `generations/LEDGER.md` Phase 3 §16 for the account.
- [x] Sequence playback: approved shots played back to back, following each shot's actual approved
      version (not assumed to be its latest — SH020 is the real counterexample). Honest slate for
      approved shots with no stored footage, auto-advancing. `app/dashboard/playback/page.tsx`,
      `components/sequence-player.tsx`. Caught and fixed a real bug: reintroduced the same SSR
      video-error race already fixed on the shot detail page by not reusing `ShotVideo` at first —
      see `generations/LEDGER.md` Phase 3 §18.
- [x] Loading and error states for slow/failed data fetches. `app/dashboard/loading.tsx` (skeleton
      while Postgres/ClickHouse fetches are in flight), `app/error.tsx` (styled retry boundary —
      has to live at the app root, not `app/dashboard/error.tsx`, since a segment's error.tsx
      doesn't catch its own `layout.tsx` throwing, and the rail's live queries run in
      `dashboard/layout.tsx`; verified for real by pointing ClickHouse at an unreachable port and
      confirming the boundary rendered, then reverting), `app/dashboard/not-found.tsx` (styled 404
      for an unknown shot code, rail still visible).
- [ ] Open product question: `shot.status` currently reflects whichever version was *last
      evaluated*, not the latest version number — SQ010 hit this for real on 2026-08-17 (SH020
      reads `approved` while its latest version, v6, reads `failed`, because the approving
      evaluation was a re-critique of v5). Decide whether shot status should instead be derived
      from the latest version's own status, and whether re-critiquing an older version should be
      allowed to move shot status at all. See `generations/LEDGER.md` Phase 3 §17.

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
