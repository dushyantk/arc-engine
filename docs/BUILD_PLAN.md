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
fixed. (Note SH020's *latest* version is still v6, marked `failed` — `shot.status` reflects the
outcome of the most recent evaluation action, not necessarily of the latest version; see the open
product question in Phase 3.)

**Status update 2026-08-18** (see `generations/LEDGER.md` §21–23): filled the SH010/SH030
placeholders with real generations. SH030 reached `approved` with real stored footage (v5) after
recanonizing Maya's facial mark — three real generations across two shots proved the "healed scar"
canon was unproducible against the real reference photo, so production memory was corrected to
match what actually renders. SH010 sits at `needs_human` after 3 real attempts (recurring hero-prop
screen-side defect, never independently root-caused) — left as real, honest state, not forced
through. Current sequence state (as of writing): **1 of 3 shots approved with real footage**
(SH030 v5) — SH020 flipped from `approved` back to `needs_human` on 2026-08-18 as a real side
effect of verifying the run-control feature below (a real recritique came back with a different
verdict than its last real pass; left as real state, not re-rolled to force a nicer number). This
number will keep moving as real runs happen — read it from the dashboard, not this doc, for
current truth. Cumulative real spend: **$29.71+, 97+ agent calls, 9 real Veo generations** (as of
the run-control verification pass; recritique calls have no Veo cost but do add to the call count).

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

- [x] VFX package export: `plate/ gen/ refs/ metadata/` tree + `manifest.json` / `generation.json`
      / `provenance.json` / `qc.json` / `notes.json`. Real approved-version lookup (not "latest"),
      real MinIO bytes, real ClickHouse-traced provenance. `lib/export.ts`,
      `app/api/export/[shotCode]/route.ts`.
- [x] Nuke script template generator (`.nk`: Read plate, Read gen, Merge, OCIO, Grain, Write).
      `lib/nuke-script.ts`.
- [x] Export panel UI: package tree preview + Nuke script preview + download.
      `app/dashboard/[shotCode]/export/page.tsx`. Verified by downloading the real zip and
      inspecting its contents directly, not just the preview — caught and fixed a real
      preview/reality mismatch; see `generations/LEDGER.md` Phase 4 §20.
- [x] Along the way: uploaded real reference images (frames from SH020 v005, the actual approved
      version) to the `reference_assets` MinIO keys that had existed since Phase 1 with no bytes
      behind them. See `generations/LEDGER.md` Phase 3 §19.

## Audit — 2026-08-18, gaps found end to end

Full pass over agents, data stores, dashboard, and docs against what ARCHITECTURE.md promises and
what real runs actually exercised. Every item below was verified against the live system (grep,
real ClickHouse queries, real page loads), not inferred. Ordered by how much each one undermines
the product's own core claim (supervision with full lineage).

### Operator control plane — the structural gap

The finding that outranks everything else in this audit, named directly: **the dashboard has zero
write paths.** Every route in the Next app and the FastAPI sidecar is a GET; every state change
the system has ever made (runs, approvals, recanonization, reference uploads) went through CLI
commands and ad-hoc scripts. The hierarchy — show → sequence → shot → version — exists only as
seed fixtures the UI reads back. A supervisor product with no operator verbs is a demo board, not
a tool. This section absorbs and widens the FastAPI-run-trigger and needs_human items below.

In hierarchy order:

- [x] **Entity hierarchy: shows on top, creatable at every level.** Real route tree — shows list
      at `/dashboard` (root) → `/dashboard/[showId]` (sequences + real references view) →
      `/dashboard/[showId]/[sequenceCode]` (shots) → `.../[shotCode]` (detail, export, playback) —
      replacing the `limit(1)`-assumes-one-show queries throughout. Create at every level via real
      Server Actions with Zod validation (`lib/actions.ts`), scoped strictly to parent context as
      decided: "New show" only at the root, "New sequence" only inside a show, "New shot" only
      inside a sequence, no create form at version level (a version is only ever produced by a
      run). Verified end to end for real — created a real show/sequence/shot through the actual UI
      forms, then walked the full existing Platform Chase hierarchy through to a real approved
      shot and downloaded its real export zip at the new shot-id URL. See
      `generations/LEDGER.md` Phase "Audit" §26 for the account, including a real Base UI
      SSR/CSR hydration bug found and fixed along the way.
- [x] **Brief authoring and persistence.** `shots.brief` (live, editable) and
      `shot_versions.brief_used` (a stamp of whatever brief was actually live when that version
      generated — editing later doesn't rewrite history). Real editor on the shot detail page
      (`lib/actions.ts`, Zod-validated), shown per version, carried into the export's
      `generation.json`. `server/run_session.py --goal` is now optional — given, it persists as
      the brief; omitted, it reads the shot's existing one and errors clearly if there isn't one.
      Found and fixed a real, separate bug while wiring this: `_load_show_shot` hardcoded
      `WHERE name = 'Platform Chase'`, broken the moment a second real show existed (SH010 now
      collides across two shows) — replaced with `find_shot_by_code`, a real cross-show lookup
      plus `--show` to disambiguate. Verified without spending on Veo: authored a real brief
      through the dashboard, confirmed via a zero-cost Python check that the ambiguous lookup
      correctly errors and `--show` correctly resolves it, reading back the exact saved text. See
      `generations/LEDGER.md` Audit §27.
- [x] **Run control (core).** Start a run from the shot view — real model tier choice (the
      operator's pick deterministically overrides the planner's, since it's LLM-picked output, not
      otherwise steerable), real live pricing, explicit cost consent required both server-side
      (`confirm_cost`) and client-side (a checkbox gating the button) — plus the CLI's other two
      real modes (`--recritique-version`, `--reuse-prompt-from-version`) as real UI actions.
      `server/routes/runs.py` (FastAPI's first routes beyond `/health`), single-flight lock (one
      real-money run at a time). Starting a run redirects straight into the existing live session
      view via a pre-generated `run_id`. Verified end to end for real, including the actual
      zero-cost Recritique button proving the full loop (UI → proxy → FastAPI → background
      execution → real SSE events landing live). See `generations/LEDGER.md` Audit §28.
  - [ ] **Not built: cancel-in-flight.** Deliberately deferred rather than shipped half-safe —
        canceling the polling loop client-side doesn't necessarily stop real billing if Veo's
        operation is already in flight server-side at Google, and a cancel button that doesn't
        actually stop real money would be worse than no button. Needs its own design pass on what
        "cancel" honestly means once money may already be spent.
  - [ ] **Not built: per-run budget cap.** No enforcement yet of a spending ceiling across runs.
- [x] **Approval control.** Human approve/reject at version level with a required reason (Zod,
      enforced both client- and server-side), writing a real `approval_events` row with
      `actor='human'` and moving shot status — rejection moves the shot to `revise`, not
      `needs_human`, since it was already reviewed by a human. A real veto, not just a
      `needs_human` resolution path: works on any version, including one an agent already marked
      `approved`, which is exactly why it exists (critic non-determinism, ledger §17). Verified
      end to end for real — submitted an actual rejection with real reasoning on SH020 v006,
      confirmed the real status change and the real `approval_events` row (correct actor,
      timestamp, and exact reason text) afterward. See `generations/LEDGER.md` Audit §29.
- [ ] **Reference control.** Upload and lock/unlock references from the UI —
      `ingest_reference_asset()` already exists server-side and has never been callable from the
      product. Pairs with the references view task below.
- [ ] **Budget visibility at the point of consent.** Show cumulative and per-shot real spend
      (already in `agent_decision_log`) next to every start-run button, so cost consent is
      informed rather than a bare confirm dialog.

**Beta-cut status: done.** Entity hierarchy, brief authoring, run control, and approval control —
the four items judged the minimum for this to stop being a demo board — are all built and
verified for real (`generations/LEDGER.md` Audit §26–29). The dashboard has real write paths at
every level now: create a show/sequence/shot, author a brief, start a real run with real cost
consent, watch it live, and a human can approve, reject, or veto any version with a recorded
reason. Reference upload/locking and budget-at-point-of-consent remain as fast-follows, along
with cancel-in-flight and a per-run budget cap (both deliberately deferred under Run control
above, not forgotten).

### Agent loop & backend

- [x] **Real runs never write production memory.** Closed — `server/agents/production_memory.py`
      now writes both tables for real. `store_qc_findings()` fires on every critique
      (run/recritique/reuse-prompt), so the QC report UI renders for real versions, not just
      seeded SH020 v002. `extract_and_store_fingerprint()` fires on any approval (agent or
      human — human approval has no critique of its own to piggyback on, so it calls a dedicated
      `POST /runs/extract-fingerprint` endpoint instead), extracting structured continuity state
      from the approved prompt so the planner's ClickHouse research reflects what a show has
      actually produced, not the frozen seed. Verified live: a real recritique on SH030 v5 wrote
      7 genuine finding rows, and a backfill extraction on the same version produced a correct
      fingerprint row.
- [ ] **No retry on the Veo call itself.** `generate_shot_version` raises raw on transient server
      errors — hit for real on SH010 (code-13 internal error, after ~$0.03 of planner calls were
      already spent; a second full attempt was needed). The planner/critic Gemini calls are
      wrapped in `call_with_retry`; the most expensive call in the system is not. Add a bounded,
      billing-aware retry (safe: the operation error path bills nothing — cost is only logged on
      operation success).
- [x] **`needs_human` has no resolution path.** Closed in §29 — `HumanApprovalActions` +
      `submitHumanApproval` write a real `approval_events` row with `actor="human"` on shot
      detail; approve/reject + reason, verified live against SH020 v006.
- [x] **FastAPI runtime is `/health` only.** Closed in §28 — `server/routes/runs.py` adds real
      `/runs/generate`, `/runs/recritique`, `/runs/reuse-prompt` with cost-confirmation gating and
      a single-flight lock; the dashboard starts runs, not just watches them.
- [ ] **Sequence-level continuity pass missing entirely.** ARCHITECTURE §1: "a sequence is
      approved only when every shot is approved and a final cross-shot continuity pass agrees
      they belong together." Nothing compares adjacent approved shots today; `sequences` has no
      status column. This is the product's closing argument and it doesn't exist yet.
- [ ] **Server entrypoints don't load `.env` and buffer stdout.** Both bit for real:
      `KeyError: DATABASE_URL` on a bare invocation, and `run_id` staying invisible until process
      exit (needed manual `PYTHONUNBUFFERED=1`) which blocked watching a live run. Load the repo
      `.env` from the entrypoints; print run_id unbuffered.
- [ ] **`scripts/seed.ts` re-seeds two known-bad states.** It still carries the
      pre-recanonization scar text (3 `continuity_fingerprints` literals) and seeds SH010 v1 as
      `approved` with a `videoAssetUrl` that has no bytes behind it — the exact source of the
      stale-approved bug fixed in 05c90c4. It's also not idempotent against the real rows that
      now exist. Update the canon text, stop seeding fake version-level approvals, and refuse to
      run (or scope down) when real data is present.
- [ ] **Live-DB hygiene: SH010 v1 still reads `status='approved'`.** Playback/export now gate
      around it, but the row itself is still wrong. Resolve together with the open shot.status
      product question in Phase 3 (whether re-evaluations of old versions move shot status, and
      whether version status should ever survive contradicting later evidence).

### Dashboard & frontend

- [ ] **Sequence-view thumbnails are a hardcoded map that now lies.** `REAL_THUMBNAILS` in
      `app/dashboard/page.tsx` knows only SH020. SH030's card says "Seed data, not yet generated"
      over real approved footage; SH010's says the same over 3 real generations. Store or extract
      a real poster frame per version (at generation time, or server-side from MinIO) and delete
      the hardcoded map and the placeholder copy.
- [ ] **Landing-page stats are hardcoded and stale.** `app/page.tsx` STATS says
      "$13.23 / 55 calls / 6 versions / 4 generations"; real totals as of this audit are
      **$29.63 / 91 calls / 9 generations**. Source them from ClickHouse (the queries already
      exist in `lib/data.ts`) or visibly date-stamp them. `DEFECT_CATEGORIES` also omits two
      categories the real critic has actually emitted in production (`camera_setup`,
      `lighting_continuity`).
- [ ] **REFERENCES rail item is a dead label** even though real reference images now exist in
      MinIO with `lockedAt`/`approvedBy` set in Postgres. Build the references view (image, type,
      locked date, approver — the lineage the export's refs/ folder already draws from).
- [ ] **EXPORT rail item is a dead label**; export exists per-shot only. Either a sequence-level
      export page (bundle every approved shot) or link the rail to the per-shot export pages.
- [ ] **Sessions list can't distinguish a live run from a finished one** (no running-now
      indicator) and offers no way to start one (depends on the FastAPI run-trigger task above).
- [ ] **Landing page reads as an internal page, not a polished landing.** Root cause is honest:
      it applies the app's tokens wholesale (same card/border/background treatment as the
      dashboard) and copies the design-directions artifact's pixel values literally — but that
      artifact was a direction *sketch* rendered as a miniature panel mock, an identity spec
      (palette, mono type, tone), not a 1:1 landing layout. The result: app-scale hero type
      (clamp 26–36px where a landing earns 48px+), uniform `py-16` section rhythm with one
      container width throughout (reads as stacked admin panels), zero motion, and the real
      generated footage — the single strongest asset this product has — presented at the same
      visual weight as body copy. Polish task, staying inside the locked Lab Bench identity (no
      generic-SaaS drift, no new colors): landing-grade display scale and type contrast, varied
      section rhythm and width (full-bleed moments for the real footage), restrained motion
      (scroll reveals, hover states on the evidence cards), a footer with actual depth, and the
      hero treated cinematically rather than as a card in a grid.
- [ ] **Build-process ledger page** (standing request, 2026-08-17): surface the
      `generations/LEDGER.md` narrative, the preserved generations/frames, and per-step costs as
      a page on the portal — the "how this was actually built" exhibit. Media is gitignored by
      design, so it needs a serving path (e.g. a MinIO `build-artifacts/` prefix mirroring
      `generations/`).

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
