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
- [x] Open product question: `shot.status` vs. latest version. **Decided and implemented in
      4b2c939.** Latest and approved are independent axes. An approval is a durable fact about one
      version, not a claim about whichever version is newest: a later version may simply not have
      been evaluated yet, or may have been fired deliberately after the approval landed — neither
      revokes it, and approving never locks the shot against generating more. So "shot approved,
      latest version failed" is a legitimate state to display, not a contradiction to design away.
      Shot status is resolved from the approval record through a named rule on both sides
      (`approval.resolve_shot_status()`, `resolveShotStatus()` in [`lib/data.ts`](../lib/data.ts)),
      each mandating that no path writes a version's verdict straight onto the shot — doing exactly
      that, unconditionally, in `_evaluate_and_record` is what let a re-critique of an old version
      silently move a shot's status. A human veto remains the one thing that revokes an approval,
      and needs no special case: it clears that version's own status first, so resolution still
      follows from the record. See `generations/LEDGER.md` Phase 3 §17 for the original symptom.

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
  - [x] **Spending ceiling across runs.** Closed below under the Rexgent transfers. Deliberately
        global rather than per-show: spend is attributed by shot code in the decision log's
        `input_ref`, which carries no show, and codes are not globally unique — a per-show cap
        would be computed from a figure the system cannot actually attribute.
- [x] **Approval control.** Human approve/reject at version level with a required reason (Zod,
      enforced both client- and server-side), writing a real `approval_events` row with
      `actor='human'` and moving shot status — rejection moves the shot to `revise`, not
      `needs_human`, since it was already reviewed by a human. A real veto, not just a
      `needs_human` resolution path: works on any version, including one an agent already marked
      `approved`, which is exactly why it exists (critic non-determinism, ledger §17). Verified
      end to end for real — submitted an actual rejection with real reasoning on SH020 v006,
      confirmed the real status change and the real `approval_events` row (correct actor,
      timestamp, and exact reason text) afterward. See `generations/LEDGER.md` Audit §29.
- [x] **Reference control.** Closed in d276b52. `uploadReferenceAsset` and `setReferenceLock`
      ([`lib/actions.ts`](../lib/actions.ts)) with a real upload dialog on the show page. Locking
      turned out to be load-bearing rather than cosmetic: `get_reference_assets()` selects
      `WHERE locked_at IS NOT NULL`, so the planner and generation adapter only ever see locked
      references and an unlocked one is invisible to the agent loop. Upload locks immediately,
      matching `insert_reference_asset()` on the Python side so the two ingestion paths cannot
      disagree; the key layout mirrors `_key()` except extension and content type come from the
      uploaded file instead of being hardcoded to png. The view carries locked date and approver,
      and an unlocked reference renders dimmed behind a **NOT IN CANON** badge stating it is not
      used by any run — the consequence made visible rather than left as a silent no-op.
- [x] **Budget visibility at the point of consent.** Closed in 0815e3d — the start-run panel shows
      what this shot and the system have already cost, beside the estimate. Surfaced a real
      attribution limit while building it: `agent_decision_log` anchors rows by the shot code in
      `input_ref` and carries no show column, and codes are unique per sequence rather than
      globally (SH010 exists in two shows). The panel therefore says "Logged against shot code
      SH010" rather than implying it is this shot's own spend, and `getShotSpend` returns
      `codeIsAmbiguous` so it states outright when the figure spans more than one show. Attributing
      it exactly would need a show anchor the log does not record — worth adding when something
      else needs it.

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
- [x] **No retry on the Veo call itself.** Closed in 0f00093, scoped to unbilled outcomes only —
      a blanket retry here would be worse than none, since repeating a rejected submission costs an
      attempt while repeating a generation that already produced output costs another generation.
      A `VeoNotBilled` exception marks the two safe cases (a submission the API refused, an
      operation that completed with an error); bounded at 3 attempts, each retry printed rather
      than swallowed. Deliberately not retried: an operation reporting success with no video
      (billing ambiguous, so it surfaces), the poll (retries the poll, never the generation), and
      the download (retried as a download, since the charge has already landed).
      `server/tests/test_generation_retry.py` pins the boundary with a scripted fake client.
- [x] **`needs_human` has no resolution path.** Closed in §29 — `HumanApprovalActions` +
      `submitHumanApproval` write a real `approval_events` row with `actor="human"` on shot
      detail; approve/reject + reason, verified live against SH020 v006.
- [x] **FastAPI runtime is `/health` only.** Closed in §28 — `server/routes/runs.py` adds real
      `/runs/generate`, `/runs/recritique`, `/runs/reuse-prompt` with cost-confirmation gating and
      a single-flight lock; the dashboard starts runs, not just watches them.
- [x] **Sequence-level continuity pass missing entirely.** Closed — `sequences` now has a real
      `status`/`continuity_notes`/`continuity_checked_at`, and
      `server/agents/sequence_continuity.py` compares every approved shot's continuity
      fingerprint in order, distinguishing a deliberate story beat from an unexplained
      cross-shot contradiction. `POST /runs/sequence-continuity` guards on every shot being
      approved first. Verified live: the guard correctly blocks and explains itself (both via
      curl and in the dashboard's disabled button) on Platform Chase/SQ010's real current state;
      the Gemini call, schema validation, and decision logging were verified directly against
      the one real fingerprint on record, which also caught and fixed a real bug — the
      `agent_decision_log.agent_name` ClickHouse enum silently dropped an unrecognized value to
      `NULL` instead of failing.
- [x] **Server entrypoints don't load `.env` and buffer stdout.** Closed in 95112da —
      `server/env.py` `bootstrap()`, called by `run_session.py`, `backfill_posters.py` and
      `main.py` before anything reads `os.environ` at module scope. Both halves were reproduced
      before fixing and measured after: the bare invocation now reaches the real lookup instead of
      `KeyError`, and the first line appears 1.2s into a run rather than only at exit.
      `load_repo_env()` never overwrites an already-set variable. `tests/conftest.py` had grown its
      own copy of the loader while the entrypoints had none; it now calls the shared one.
- [ ] **`scripts/seed.ts` re-seeds a known-bad state.** Two of the three problems are closed in
      4b2c939: it no longer fabricates approvals (SH010 v1 and SH030 v3 seeded as `approved`,
      against video keys with no bytes, with agent `approval_events` reading "All continuity checks
      pass" — harmless while later failures overwrote them, permanent under the approval-record
      rule; now seeded `candidate` with their shots `pending`), and it refuses to run against a
      database that already has shows rather than silently adding a second Platform Chase alongside
      the one carrying real spend. **Still open:** the pre-recanonization scar text in 3
      `continuity_fingerprints` literals — the canon was corrected in ec5bdba to a fresh cut after
      three real generations proved "healed scar" unproducible, and the fixture never caught up.
- [x] **Live-DB hygiene: SH010 v1 still reads `status='approved'`.** Closed in 4b2c939, alongside
      the shot.status decision it was waiting on — the approval-record rule made these rows
      load-bearing rather than merely untidy. SH010 v1 and SH030 v3 were both seed fixtures with no
      bytes behind their video keys and no critique ever run on them; set to `candidate`, and their
      two fabricated `agent:approved` events deleted, since they assert a continuity pass that
      never happened. Real history was checked first and is untouched: the surviving agent
      approvals are SH020 v5 and SH030 v5 from real runs on 2026-08-18, both against real stored
      footage, and the human rejection is still on record. No version currently holds an approval,
      which is the honest state of this sequence.

### Dashboard & frontend

- [x] **Sequence-view thumbnails are a hardcoded map that now lies.** Closed in 5d96eff, though
      not as written: `REAL_THUMBNAILS` and the "Seed data, not yet generated" copy were already
      gone, removed with the hierarchy refactor in 86ece1a. What replaced them had two defects of
      its own. The card posterised whichever version was *latest*, which is routinely not the
      version its status describes — the same "latest is not approved" trap fixed for playback and
      export in 05c90c4 — so every card in SQ010 was showing a `failed` take. And it painted the
      still by mounting a `<video preload="metadata">` per card, fetching container metadata out of
      MinIO to render a thumbnail. Now `shot_versions.poster_asset_url` holds a real midpoint JPEG
      written at generation time (`video_frames.extract_poster_frame`), resolved through the
      mandated `pickShotPoster()` helper in [`lib/data.ts`](../lib/data.ts), with the version
      labelled on the card. `server/backfill_posters.py` filled in the history: 9 real posters from
      real footage, 6 versions skipped for having no bytes behind their key, 0 failures. Cards mark
      a fallback **STAND-IN** where the version the status describes has no footage. That surfaced
      the two `approved` rows pointing at bytes never uploaded, which 4b2c939 then corrected — the
      badge remains for the general case rather than for those two rows.
- [x] **Landing-page stats are hardcoded and stale.** Closed in df1fbe3 — `app/page.tsx` carries
      neither a `STATS` array nor a `DEFECT_CATEGORIES` literal any more. `getLandingStats()` and
      `getLandingFindings()` ([`lib/data.ts`](../lib/data.ts)) read `agent_decision_log` and
      `qc_findings` at request time, and the page renders whatever categories the critic actually
      emitted rather than a hand-maintained list, so that particular drift cannot recur. The
      generation-vs-supervision split is computed, not asserted. One correction to the audit while
      closing it: `lighting_continuity` was genuinely missing, but **`camera_setup` appears in zero
      real rows** — checked across `qc_findings` and `continuity_fingerprints` — so there was
      nothing to restore there.
- [x] **REFERENCES rail item is a dead label.** Closed in d276b52, and partly stale as written:
      there is no REFERENCES rail item any more (it went with the hierarchy refactor in 86ece1a),
      and references live on the show page where they are scoped to a show, which is the only place
      they mean anything. The view now carries image, type, locked date and approver as asked, plus
      the lock state and its consequence. The remaining dead rail label is EXPORT, below.
- [x] **EXPORT rail item is a dead label.** Closed in f1824f7 — both halves, not either/or.
      `/dashboard/export` lists every sequence across every show with its shots' real status, a
      package download on the approved ones and a sequence bundle
      (`/api/export/sequence/[sequenceId]`). It deliberately lists sequences with nothing to ship:
      with no approved shot anywhere today, the page says so and names approval as the way through,
      rather than rendering an empty list that hides the gate. The zip tree, previously assembled
      inline in the per-shot route, is now `addShotFolder()` in
      [`lib/export-zip.ts`](../lib/export-zip.ts), mandated for every export route — verified that
      the same shot exported per-shot and via its sequence produces identical trees and
      byte-identical files apart from the two embedded timestamps. The sequence route returns 409
      with an explanation when nothing is approved rather than a valid-looking empty zip.
- [x] **Sessions list can't distinguish a live run from a finished one.** Closed in ea68253.
      Liveness is not a property of `agent_decision_log` — a running run and a finished one are
      both just rows — so it comes from the runtime's own single-flight marker. `/runs/status`
      reported *that* a run was active but not *which*, so it now carries `run_id`;
      [`components/session-list.tsx`](../components/session-list.tsx) polls it every 3s, marks the
      matching row live and banners the shot and mode with a link into the existing live view. A
      just-started run has no logged rows yet, so the banner says so rather than looking wrong.
      For the "no way to start one" half: a run plans against the shot's brief and cost consent
      belongs with the shot, so the idle state lists the genuinely startable shots
      (`getRunnableShots()` — only those with a brief, the same condition the Start run button
      enforces) instead of a control that would dead-end. With the runtime down it says so and
      drops the offer; the log keeps rendering, since it reads ClickHouse directly.
- [x] **Landing page reads as an internal page, not a polished landing.** Closed in df1fbe3 —
      rebuilt as a full-bleed cold open on the real SH020 v006 frame sitting over the six-stage
      supervision loop, with the footage and the critic's own findings hung at the stage each
      belongs to. Every symptom the audit named is addressed: display-scale type in place of the
      26–36px clamp, section rhythm and container width that vary by function rather than a uniform
      `py-16` at one width, restrained scroll motion, a footer with real depth, and the generated
      footage carrying the fold instead of sitting at body-copy weight. Stays inside the locked Lab
      Bench identity — no colour outside the token set, and `app/landing.css` is scoped under
      `.dailies-landing` so generic names (`.row`, `.btn`, `.wrap`) cannot reach the dashboard.
      Chosen from four directions explored as full mockups, then ported and verified against the
      approved one with a Playwright/Pillow screenshot diff (itself validated at 0 differing pixels
      of 16,280,640): **zero horizontal and zero structural differences at 1440/768/390**, cold open
      pixel-identical, and every remaining delta traceable to live data replacing static prose or to
      two unsourced quotes deliberately dropped (see the note in that commit — they came from
      `generations/LEDGER.md`, not from `qc_findings`).
- [x] **Build-process ledger page** (standing request, 2026-08-17). Closed in ec19788 —
      `/dashboard/ledger`, reached from a LEDGER rail item. `pnpm ledger:sync`
      ([`scripts/sync-build-artifacts.ts`](../scripts/sync-build-artifacts.ts)) publishes
      `generations/` into MinIO under `build-artifacts/` exactly as the item suggested, skipping
      unchanged files by comparing MinIO's ETag to the file's MD5 so a re-run moves nothing.
      No new service or port — MinIO was already up on its reserved 9010/9011.
      [`lib/ledger.ts`](../lib/ledger.ts) splits the narrative into its 6 phases and 31 numbered
      entries and renders it through `marked` (the ledger uses tables, fenced code and blockquotes,
      which a hand-rolled parser would get subtly wrong); the trust boundary for
      `dangerouslySetInnerHTML` is written on the function. The page lists the object store
      directly as well as parsing references, because the prose cites whole folders far more often
      than single files — reference-parsing alone found 5 of 23 artefacts. It dates itself from the
      object mtime, and with nothing published it prints the sync command rather than rendering an
      empty exhibit.

## Phase 5 — Beta hardening

- [x] Smoke tests: Postgres + ClickHouse connectivity — `server/tests/`, pytest + pytest-asyncio,
      17 tests (a892794). Connectivity and schema shape for Postgres, ClickHouse and MinIO, plus
      the deterministic logic that gates spend and shipping: `QCFinding` rejecting malformed critic
      output, the approval gate's fail/warning/cap-out transitions, and `resolve_shot_status`. They
      skip rather than fail with the stack down (verified against dead ports: 11 passed, 6 skipped,
      0 failed). **The "one seeded shot through the full agent loop" half is deliberately not
      implemented**: that path makes billed Veo and Gemini calls, and a suite must never be able to
      spend money by being run. Not hypothetical — the first run of these tests wrote 8 rows into
      the live `agent_decision_log` (`evaluate()` logs as a side effect, and the landing page counts
      those rows); removed, and `log_decision` is now stubbed by an autouse fixture so no test in
      that module can reintroduce it.
- [x] Playwright e2e: sequence view → shot detail → approve → export, happy path —
      [`playwright.config.ts`](../playwright.config.ts) (web server on **3211**, never 3210) and
      [`e2e/`](../e2e): hierarchy navigation, create flow, approve → export, reference control.
      Built to be incapable of touching real work: every fixture hangs off an `E2E %` show that is
      torn down per test with a global-teardown safety net, the read-only spec aborts every non-GET
      request at the browser, the three costed endpoints are aborted on every page, and the fixture
      version stores no `generation_settings` so `/runs/extract-fingerprint` short-circuits before
      Gemini whether or not the runtime is up. The export test unzips the downloaded package and
      asserts the real tree and `manifest.json`, not that a button exists.
- [x] Cost/latency view sourced from `agent_decision_log` — `/dashboard/cost` (0815e3d), reached
      from a new COST rail item. Headline totals, the generation-vs-supervision split, spend by
      agent, spend by model, and latency by agent. Deliberately **no spend-over-time chart**: the
      log spans two days, so a time series would be two points; the date range is stated as text.
      Magnitude bars use a single hue because the row label carries identity and the semantic
      tokens are reserved for real status, and latency gets its own chart rather than a second axis
      on spend.
- [ ] `pnpm build` clean, FastAPI starts clean, docker-compose up clean from a fresh checkout
- [ ] README with quickstart commands and the demo script (3-shot railway sequence, per the pitch).
      **Quickstart half done** in a892794 — the README was telling people to supply Vertex
      credentials the product stopped needing once Veo turned out to be reachable through the
      Gemini Developer API; it now carries the real prerequisites (including ffmpeg and the two
      schema pushes), the ports table, the loop, every test command, and the scriptable run
      invocations with flags checked against the actual argparse. **Still open: the demo script
      itself** — the walkthrough for showing the product start to finish. Deliberately left with
      the beta-release item below, since a demo script is only worth writing against the state the
      release actually ships. Note the original figure here was stale: the sequence took 9 real
      generations, not 7.
- [ ] Beta release: tag, confirm demo runs unattended start to finish

## Phase 6 — Top-down planning (idea → script → breakdown → assets → shots)

**The gap, stated plainly: the product supervises shots it did not originate.** Everything upstream
of `shots.brief` is done by hand — a human invents the scene, decides the shot list, writes each
brief, and uploads the references. That makes this an approval system with a generator attached,
not a filmmaking system. The pitch ("making it belong in the movie") is strongest when the system
owns the movie, because then the continuity bible is derived from the script rather than asserted
shot by shot.

```
idea prompt → script → [approve] → breakdown → [approve] → materialise entities
                                                              ↓
                                    asset sheets → [lock as canon] → per-shot loop (existing)
```

**The whole design rests on one seam: `shots.brief`.** The breakdown agent writes the briefs the
existing planner already consumes, so nothing downstream of a shot changes. New work bolts on in
front of the existing loop rather than through it.

**Thin slice (†)** — tasks marked † are script → breakdown → materialise, text only. That subset
adds no new billed call class, needs no image model, and still turns the demo from "watch it
supervise a shot" into "watch an idea become a shot list the system then executes". It is the
recommended first move if this is attempted before the beta release rather than after it.

### 6.0 — Settle before building

- [x] **Generalise `approval_events`.** Done in 7662675 — widened, not given a second table, so
      there stays one audit trail and one human-veto path. Not an untyped
      `(subject_type, subject_id)` pair either: that trades real foreign keys for a column that can
      dangle, and would break the delete-cascade the e2e fixtures rely on. It is an **exclusive
      arc** — `subject_type` says what the decision is about, target columns stay real FKs with
      real cascades, and a CHECK constraint requires exactly the columns that subject needs.
      Scripts and breakdowns extend the enum, add their own FK, and extend the check.
      `subject_type` has a default only so the 21 existing rows could be classified in place; every
      caller states it explicitly, and the check rejects a subject that forgets. Verified live: all
      21 rows classified, a malformed row rejected by the constraint, a well-formed one still
      inserting. †
- [x] **Pick the image model and price it.** Model availability checked live against the API:
      **no Imagen on this key** — image generation is Gemini image models via `generateContent`
      (`gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`,
      `gemini-2.5-flash-image`, plus `-preview` variants), the same call shape as the planner and
      critic rather than Veo's long-running poll. Priced **per token, not per image**, in the same
      `_TOKEN_PRICING` table as the text models — because that is how they actually bill, and a
      per-image constant silently goes wrong when an image is a different size. The per-image
      figure the consent UI shows is *derived* from that rate and a **measured** output-token count
      (`gemini-3.1-flash-image` 1512 tokens, `gemini-3-pro-image` 1430), so there is one source of
      truth rather than two copies. Recommended default `gemini-3.1-flash-image` at ~$0.045 an
      image against `gemini-3-pro-image` at ~$0.172. †
- [x] **Thinking tokens were missing from every cost figure.** Found while measuring the above, and
      much worse than the thing it was blocking. All eight agent call sites read
      `candidates_token_count` as their output count. Thinking tokens bill at the output rate and
      are not in that field: a real `gemini-3.1-pro-preview` story call reported 568 candidate
      tokens and **2611 thinking tokens**, so the logged cost was 4.4× under the real one. This
      mattered more than an ordinary reporting bug because the budget ceiling refuses runs against
      that number — an undercounting ledger spends past a cap the operator set and believes is
      holding. Closed with `token_usage()` in `decision_log.py`, which computes output as
      `total - prompt`; **RULE: every path that logs a model call reads its token counts through
      it, never `usage_metadata` directly.** All eight sites converted, 12 tests over the fix and
      the degraded-response cases. Of the $29.86 logged to date, $28.80 is Veo per-second billing
      and unaffected; the $1.06 token portion is understated and cannot be recomputed, because the
      missing number was never written down. `/dashboard/cost` says so on the page rather than
      leaving it to be discovered.

### 6.1 — Idea to script

- [x] `scripts` table — done in 53919b4, versioned like `shot_versions`, with `source_prompt`
      kept separate from the generated text so the human intent stays recoverable. Drizzle +
      `server/db/models.py` mirror. †
- [x] `ScriptDraft` contract — done in 53919b4, Zod and Pydantic mirrors, malformed output a hard
      stop matching `critic.py`. †
- [x] Story agent ([`server/agents/story.py`](../server/agents/story.py)) — done in 53919b4.
      Deliberately *not* given the continuity state the planner queries: a script is written
      before there is anything to be continuous with. Its system prompt carries the one
      instruction the rest of the pipeline depends on — name recurring physical things identically
      every time, since those names become the continuity references. Verified with a real call:
      26s, $0.008992, logged as `story_agent`. Required extending the ClickHouse `agent_name`
      Enum8 first, since an unlisted value coerces to NULL rather than failing. †
- [x] Script UI — done in a5997e1 at `/dashboard/[showId]/script`, linked and summarised from the
      show page. Writing is ungated and says so; approval is the gate. Approving supersedes the
      previously approved script (one per show is planned from at a time) and the form says which
      version that is *before* the click. First real use of the widened `approval_events`: the row
      lands with `subject_type='script'` and no shot attached. Verified by driving the actual UI —
      empty state, real draft, approve, decision on the record, no page errors. †

### 6.2 — Script to breakdown to real entities

- [x] `breakdowns` table — done in b6e7d09. Its own artifact rather than only its effects: once
      materialised nothing reads the row, but "why does this shot exist" needs an answer that
      outlives the run, and a rejected proposal has to stay readable next to the one taken.
      `payload` stored whole, not shredded into columns — it is a proposal, read back for review
      and provenance, never queried across. `approval_events` took `breakdown` as a third subject
      with its own FK and its own arm of the CHECK. †
- [x] `SceneBreakdown` contract — done in b6e7d09, Zod and Pydantic mirrors, malformed output a
      hard stop like `story.py` and `critic.py`. †
- [x] Breakdown agent ([`server/agents/breakdown.py`](../server/agents/breakdown.py)) — done in
      59e1573. Writes into `shots.brief`, the same field an operator types and the planner already
      consumes, so nothing downstream of a shot changes to accept one that was proposed rather
      than typed. Required extending the ClickHouse `agent_name` Enum8 for `breakdown_agent`
      *before* anything wrote to it. Real cost: $0.012-$0.014 a pass, 55-190s. †
- [x] Breakdown review UI — done at `/dashboard/[showId]/breakdown`, linked and summarised from
      the show page. Shows the whole plan shot by shot with what each action would do, before the
      button that does it. A protected shot's proposed brief is struck through and marked
      "proposed, not applied": it is the one place the system deliberately ignores the agent, and
      printing the discarded proposal plainly would read as the shot's real brief. A plan that
      would write nothing disables the button and says why rather than pretending to work.
      Approval writes the `approval_events` row *first*, then materialises, so the record of the
      decision cannot go missing if materialising fails. Verified by driving the real UI. †
- [x] **Materialisation — transactional, additive, and non-destructive.** Done in 59e1573.
      `agents/materialise.py` computes a plan and writes nothing; `apply_materialisation` writes it
      in one transaction. Splitting them is deliberate — these are the rules where being wrong
      destroys paid work, so they are pure, unit-tested, and reviewable as a list first. A shot
      with versions is untouchable. Nothing is ever deleted: a dropped shot is reported as
      orphaned, which is what "explicit, itemised confirmation" means in practice — the plan is
      the itemisation and a human reading it is the confirmation. `/materialise` re-plans against
      live state rather than trusting the plan from `/propose`, since a shot may have been
      generated in between. Verified against live data: a re-breakdown rewriting every brief left
      the one shot carrying a version alone and updated the other six — protection is per shot,
      not per sequence. †
- [x] `shots.created_from_breakdown_id` — done in b6e7d09. `ON DELETE SET NULL`, not cascade:
      deleting a proposal must not delete real work that came out of it. Null stays valid, since
      creating a shot by hand remains supported. Not touched on a brief update — this breakdown
      revised the brief, it did not create the shot, and claiming otherwise rewrites history. †

### 6.3 — Asset sheets

- [x] `reference_assets` gains `source`, `generated_from_breakdown_id`, `generation_prompt` and
      `generation_model`. Defaults to `uploaded`, so the three existing rows classified correctly
      in place and a caller that forgets cannot pass a generated image off as one a human supplied.
      `ON DELETE SET NULL` on the breakdown link — binning a proposal must not bin a reference
      somebody has since locked as canon.
- [x] `AssetSheetSpec` contract — Zod and Pydantic mirrors. `views` is what makes it a *sheet*
      rather than a picture: a character the critic later judges identity against has to be seen
      from more than one side. Views are per asset type — "side profile" means something for a
      character and nothing for a palette.
- [x] Asset-sheet agent ([`server/agents/asset_sheet.py`](../server/agents/asset_sheet.py)) — spec
      to a real image, stored in MinIO, landing as an **unlocked** `reference_assets` row. The
      prompt is assembled in one place so the text stored on the row is the text that ran. A
      failed sheet writes no row, so a reference never points at no picture — but its cost is
      logged *before* the failure check, because the call was billed either way and a cost the
      ledger never saw is what the budget now depends on not happening.
- [x] Cost consent before generating sheets, matching the Veo run gate. Both gates moved to
      `server/routes/gates.py` rather than copied: video bills per second, images per token, and
      two inline copies of one ceiling check is how one of them ends up not enforcing it.
      **RULE: every billed route calls `require_budget()` and `require_consent()`, never
      re-derives them.** The ceiling is checked against the whole batch up front — per-sheet
      checking would let a batch walk past the cap by paying for the first few before the check
      that stops it. Verified: a $0.23 batch at a $29.90 ceiling with $29.86 spent returned 402
      and generated nothing.
- [x] **No new approval concept for assets — confirmed, not built.** Every agent reads references
      through `get_reference_assets()`, which selects `WHERE locked_at IS NOT NULL`; all three
      call sites (`run_session`, `routes/runs`, and nothing else) go through it. An unlocked sheet
      is therefore already invisible to the planner, the critic and the generation adapter, and
      the lock verb built in d276b52 *is* the canon gate. Verified against the real rows: agents
      see 0 references, the operator sees 2. `get_all_reference_assets()` exists for the operator
      surfaces only and says in its docstring never to wire an agent to it.
- [x] **The card says which references a machine made.** Locking a generated sheet asserts a
      model's guess as the thing every shot is judged against — a different decision from locking
      a plate a human chose — so the plate carries a GENERATED badge, the prompt and model are
      readable on the card, and the button reads "Lock this generated sheet as canon".

### 6.x — Everything generated is reachable in the product

Audited after 6.3: every page loads, and every stored artifact can be opened by a person rather
than only by a query. Two things the schema promised were true only in the database.

- [x] **Superseded breakdowns were unreachable.** The table exists so a proposal that was
      replaced stays readable next to the one taken, and so a shot's `created_from_breakdown_id`
      points at something openable — but the UI only ever fetched `/latest`, stranding three of
      four proposals. `GET /breakdowns/{show}/history` returns them all, and the page lists them
      under "Earlier proposals" with each one's shot list readable. Not re-planned against live
      state: these are historical proposals, and a plan computed now would answer a different
      question. A payload written under an older shape is skipped rather than failing the whole
      history.
- [x] **Shot provenance was a column, not an answer.** All 7 materialised shots carried
      `created_from_breakdown_id` and nothing rendered it. The shot page now says "Proposed by
      breakdown vN … not authored by hand" and links to `#history`, where that version is
      actually readable — the named version is usually not the one the page opens on, so linking
      at the page alone would have been a dead end dressed as provenance.
- [x] **Sweep of all 11 pages**: every route 200, zero page errors, zero broken images, generated
      sheets serving from MinIO as `image/jpeg`. Two apparent failures during the audit were
      defects in the audit itself, not the product — a lazy below-the-fold image measured before
      it decoded, and a case-sensitive assertion against CSS-uppercased text.

### 6.4 — Prove the chain

- [x] End-to-end on a throwaway show ("Lantern Signal"): idea prompt → script → approval →
      breakdown → 3 sequences and 7 shots with provenance → resolvable by the run trigger. $0.045
      for the whole chain. Carrying one of those shots through to a real Veo generation is the
      remaining half of this item and is deliberately deferred — it is the same existing loop,
      already proven, and costs $3.20 to re-demonstrate.
      **Two defects the run found that reasoning had not.** The agent was told to restart shot
      numbering per sequence, producing three SH010s in one show; they materialised fine and then
      could not be run at all, since `find_shot_by_code` resolves by code. Fixed in the prompt and
      *enforced* in `plan_materialisation` — a prompt is guidance, a guard is a guarantee. That
      failure surfaced as "exists in more than one show (Breakdown Chain Test) — pass --show to
      disambiguate", which named one show as more than one and told the operator to pass a flag
      they had already passed; it now separates the two causes and says which one happened. †
- [x] Tests: `server/tests/test_materialise.py`, 18 cases over the rules where being wrong
      destroys paid work — protection per shot, orphans reported and never deleted, no-op plans
      identified, duplicate codes refused before any planning happens. 63 tests total. †

### Ideas taken from Rexgent (`~/dev/Rexgent`), and what they cost to adopt

That project solves the same three problems (consistency, hallucination, cost) further
along — 717 commits, 891 backend tests, CI, Alembic, deployed. Read for technique rather than
strategy. What transfers, in value order:

- [ ] **Split continuity axes by what kind of question each one is.** The single best idea there,
      and the one this project does not have. Its `ContinuityAgent` scores **face with an ArcFace
      embedding** (a measurement — never a language model) and **outfit and background with a vision
      model** (judgements), combined 0.5 / 0.25 / 0.25 and re-normalised when an axis is
      unavailable. This project asks one model for prose verdicts on all seven axes equally, which
      is why identity has been its least reliable finding: it is the one axis that is a measurement
      question. The compliant measurement is **Vertex AI multimodal embeddings**, needing the Vertex
      credential path skipped in ARCHITECTURE.md section 6.
- [x] **Suppress an axis when the framing makes it meaningless.** Their `outfit_scoring_applies()`
      returns False on CU/ECU/OTS framings, because an over-the-shoulder shows a back — their
      comment records one such shot scoring outfit 0.1 and dragging a good take down to 40. Taken
      differently here: rather than a hardcoded framing table, the critic declines an axis it
      cannot observe by returning `not_applicable`, and the approval gate counts declined axes
      separately from passes so "approved" can never quietly mean "nothing was checked". The
      reason line states how many axes were actually checked. Covered by
      `TestNotApplicableAxes` in `server/tests/test_contracts.py`.
- [ ] **Calibrate a raw similarity before treating it as confidence.** A genuine same-person ArcFace
      pair only clears ~0.35; read raw as "35/100" every real match fails. They map it through a
      curve so the genuine threshold lands at 0.75. Any measurement adopted here needs the same
      treatment — `server/agents/identity_check.py` used a flat 0.6 cutoff and was wrong to.
- [x] **Attempted directly and got it wrong — recorded in `server/agents/identity_check.py`.**
      Ported the MCP-exposed `ConsistencyGuard` rather than the pipeline's real `ContinuityAgent`,
      and asked a flash model for the identity number, which is precisely what that design never
      does. The "it scored 0.98 on a photograph of an empty platform" result proved nothing about
      VLM-vs-embedding: there a non-face reference never reaches the scorer, because ArcFace
      returns no vector and the character is flagged unverifiable. Left advisory and wired to
      nothing; the mistakes are documented in the module.
- [x] **A cheapest-first repair ladder.** Done in 80dbc58 — `server/agents/repair.py`, pure logic,
      ten tests. That project varies the *strategy* (reseed/reanchor/videoedit); this one has three
      Veo tiers with an 8x spread, so the tier is the first lever. Rerolls before revising unless
      the failure already reproduced, because SH020 v006 proved by hand that three of four findings
      were run-to-run variance — that experiment cost a full-price generation and now costs an
      eighth. Escalates the tier last: a dearer tier renders a bad prompt more expensively rather
      than fixing it. Against real history, SH020 v2 and SH030 v5 both open on a $0.40 reroll where
      the naive retry is $3.20. Advisory, printed by `run_session` after a failed evaluation;
      automatic repair is off by default there too.
- [x] **Per-run budget enforcement** (closes the item deferred under Run control). Taken from its
      `cost_ledger.aggregate()`, which returns `within_budget` and `remaining` against a project
      budget: the idea worth transferring is that the ledger this project already keeps accurately
      should be able to *refuse*, not only report. `server/agents/budget.py` reads a ceiling from
      `DAILIES_BUDGET_USD`, totals real logged spend, and `_require_budget()` gates both billed
      endpoints with HTTP 402 before the call is made. Unset, malformed, zero or negative all mean
      unlimited, and the status endpoint says `enforced: false` rather than implying a cap exists.
      Scoped globally, not per-show, for the attribution reason recorded under Run control above.
      An unknown tier prices at the dearest rather than the cheapest, so an unrecognised model
      cannot slip under a cap by being unpriced. `/runs/recritique` is deliberately ungated — it
      spends no Veo money. Verified live: at a $30 ceiling with $29.78 already spent, a $3.20 run
      returned 402 with the remaining balance in the message, and the ceiling overrode an explicit
      `confirm_cost: true` — consent does not buy past it. The start-run panel now fetches
      `/runs/budget` and says what is left before the click, so a refusal is predictable rather
      than a surprise at submit time.
- [ ] **Deterministic pre-generation checks.** `continuity_monitor.py` is pure, no I/O, and catches
      script-level breaks before anything is spent — repeated action across shots, no emotional
      progression between cuts, a question answered by a people-free scenery shot. Free to run, and
      it applies directly to 6.2's breakdown output.
- [ ] **CI and migrations.** GitHub Actions running pytest and lint on every push; Alembic with 28
      revisions instead of `drizzle-kit push` with no history — which has already cost two
      hand-applied CHECK constraints in this project.

### Deliberately out of scope for a first pass

Feature-length or multi-act structure (one sequence, a handful of shots); per-shot storyboard
frames; casting, dialogue or voice; any editing timeline.

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
