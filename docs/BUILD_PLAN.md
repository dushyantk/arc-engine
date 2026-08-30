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
