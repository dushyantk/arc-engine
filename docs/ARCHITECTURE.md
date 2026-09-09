# Arc Engine — Architecture

> Product name: **Arc Engine**. Repo/dir/ports stay `arc-engine` (already reserved in `~/dev/ports.md`) for continuity — no path rename.

## 1. What this is, precisely

Not a generator. A supervisor.

Given a scene brief, Arc Engine plans a shot list, generates each shot with Veo, watches its own
footage with Gemini, writes real dailies notes, decides pass/fail per continuity axis, regenerates
what failed against locked reference material, and only marks a shot **Approved** when it agrees
with everything around it — the preceding shot, the following shot, the approved character/prop/
environment refs, and the show's technical rules. A sequence is approved only when every shot in
it is approved and a final cross-shot continuity pass agrees they belong together.

Closed loop: **Plan → Generate → Watch → Critique → Revise → Generate → Verify → Approve.**

## 2. Non-goals (explicit, so nobody drifts back to the old shape)

- Not a viewer-choice / branching-narrative engine. That was the previous occupant of this
  directory when it lived at `~/dev/blockbuster/arc-engine` (archived at
  `~/dev/blockbuster/arc-engine-archive/`, "FateForge Multiverse Engine") and it is dead. Do not
  resurrect choice trees, live streaming, or biometric input here.
- No multi-tenant auth / billing for beta. Single operator, local/demo deployment. If this
  becomes a real SaaS later, auth is an additive layer on top of the domain model below, not a
  redesign of it.
- No live web-trend scraping (Parallel), no IBM watsonx. Those were sponsor-integration artifacts
  of the old hackathon shape, not requirements of this product.
- No full Nuke automation — the export step writes a `.nk` script as a text template. Nobody
  needs a Nuke license to produce a script file.
- No ShotGrid/Flow/Ftrack integration. The VFX package export is the handoff boundary; what a
  studio does with it downstream is out of scope.

## 3. Product boundary (sibling projects)

- **Backlot** orchestrates generative workflows. **Big Squeeze** is an autonomous creative studio.
  Arc Engine owns one layer only: **GenFX supervision, continuity, and approval.** It exposes a
  narrow surface (submit a shot brief with references → get back an approval decision + QC
  history) that either sibling could call later. Arc Engine must not import from or depend on either.

## 4. Core domain model

Two stores, split by what each is good at. This is not "Postgres because CRUD, ClickHouse because
big data" — it's a genuine integrity/analytics split.

**Postgres — source of truth, transactional.** A shot cannot be `approved` while its latest
version is `failed`; that's a real invariant and needs a real database enforcing it.

```
shows            (id, name, created_at)
sequences        (id, show_id, code, description)
shots            (id, sequence_id, code, order_index, screen_direction,
                   status: pending | generating | reviewing | revise | approved | needs_human)
shot_versions    (id, shot_id, version_number, generation_prompt, generation_settings jsonb,
                   video_asset_url, status: candidate | failed | approved, created_at)
reference_assets (id, show_id, type: character | prop | environment | palette,
                   name, image_url, locked_at, approved_by)
approval_events  (id, shot_id, shot_version_id, actor: agent | human, decision, reason, created_at)
```

**ClickHouse — production memory, append-only, analytical.** This is the "secret sauce" the brief
calls out: not a log dump, the actual continuity state an agent queries before generating the next
shot. Schema follows the brief's field list directly:

```
continuity_fingerprints (
  show, sequence, shot, version,
  character_identity, costume, props, environment, time_of_day, lighting_direction,
  camera, lens_language, screen_direction, palette,
  approved_reference_frames, generation_prompt, generation_settings,
  qc_findings, supervisor_notes, revision_reason, approval_status,
  extracted_at
)
qc_findings (shot_id, version, category, verdict, frame_range_start, frame_range_end,
             description, severity, created_at)
agent_decision_log (run_id, agent_name, step, input_ref, output_ref, model,
                     tokens_in, tokens_out, cost_usd, latency_ms, created_at)
```

`agent_decision_log` exists because agent workflows must expose logs, decisions, cost, latency,
and retries — not just the pass/fail result. This is the audit trail, and it's queried the same
way as continuity state: through the ClickHouse MCP.

Query pattern before generating SH030:

> Give me approved continuity state for character Maya entering SH030.

→ ClickHouse MCP query against `continuity_fingerprints` filtered to `approval_status = 'approved'`
for the character across all prior shots in the sequence, most recent per attribute wins.

**Object storage (MinIO, S3-compatible, already reserved on ports 9010/9011):**

```
refs/{show}/{asset}.png
gen/{shot}/{version}.mp4
exports/{show}/{sequence}/{shot}/...
```

## 5. Typed contracts

Zod (TypeScript boundary) and Pydantic v2 (agent/generation backend) define the same shapes twice,
deliberately — not shared codegen, not a monorepo package. The four contracts that cross the
Next.js ↔ FastAPI boundary:

- `ShotBrief` — planner output: invariants to preserve, reference set, prompt, generation settings.
- `ContinuityFingerprint` — extracted per shot/version, mirrors the ClickHouse row above.
- `QCFinding` — one per continuity axis, `{ category, verdict: pass|fail|warning, frame_range?, description }`.
- `RevisionInstruction` — critic's FAILed findings turned into concrete regeneration instructions.

Bad handoffs fail loudly: if the critic's response doesn't validate against `QCFinding`, that's a
system fault — retry with backoff, then hard-stop with a visible error. Never silently accept
malformed QC data as a pass.

## 6. Agent architecture

Five roles, not five microservices — this can be one FastAPI process to start.

1. **Planner** (Gemini) — takes the scene brief + approved continuity state (queried from
   ClickHouse) → decides what must stay invariant, what reference assets are needed, produces
   `ShotBrief` per shot.
2. **Generation adapter** — calls Veo 3.1 with image-conditioning / first-last-frame guidance
   using the locked reference set → writes a `shot_versions` row as `candidate`.
3. **Supervisor/Critic** (Gemini, multimodal video understanding) — watches the candidate against
   approved refs, the preceding shot, the following shot, and the continuity bible → produces
   `QCFinding[]`. Must distinguish **creative variation** (the creature's silhouette shifting,
   consistent with brief) from **generative defect** (an extra finger for 11 frames) — this is a
   taste judgment, not a threshold, and the prompt needs to say so explicitly.
4. **Revision agent** — turns FAILed findings into a `RevisionInstruction` (lock this ref, remove
   that element) and triggers the next generation round.
5. **Approval gate** — deterministic, not agentic: a shot is `approved` only when every hard-fail
   category passes. Tolerated warnings are logged, not silently dropped. Cap revision rounds per
   shot (e.g. 4); on cap-out, transition to `needs_human` rather than looping forever or
   auto-approving — human-in-the-loop where production risk requires it.

Model split (verified live against the real API on 2026-08-17, not assumed — see the setup note
below for what changed):
- **Critic**: `gemini-3.1-pro-preview` — accuracy over cost, this is the judgment call that gates
  approval. Top reasoning tier available; "preview" naming, not a stability concern for this
  project.
- **Planner / fingerprint extraction**: `gemini-3.6-flash` — high-volume, structured,
  cost-sensitive. Confirmed working with a live `generateContent` call.
- **Generation**: `veo-3.1-generate-preview` (quality) or `veo-3.1-fast-generate-preview`
  (cheaper/faster revision iterations) — both confirmed available. Image-conditioned and
  first/last-frame guided calls are current Veo 3.1 capabilities (multi-image guidance, improved
  temporal consistency vs Veo 3).

**Auth, simpler than originally planned**: Veo 3.1 is reachable through the same Gemini Developer
API as the text/vision models — `models/veo-3.1-generate-preview` shows up in the same
`GEMINI_API_KEY`-authenticated model list. No separate Vertex AI project/service-account plumbing
needed for the beta. `GOOGLE_APPLICATION_CREDENTIALS` stays in `.env.example` as an optional
upgrade path (higher quota, org billing) but `GEMINI_API_KEY` is the primary credential — see
[`.env.example`](../.env.example).

## 7. System diagram

```
                         [ Director scene brief ]
                                    │
                                    ▼
                    [ Planner (Gemini) ] ◄── query approved continuity ──┐
                                    │                                     │
                                    ▼                                     │
                    [ ShotBrief: invariants, refs, prompt ]               │
                                    │                                     │
                                    ▼                                     │
                    [ Veo 3.1 generation adapter ] ──► shot_versions (Postgres, candidate)
                                    │                                     │
                                    ▼                                     │
                    [ Supervisor/Critic (Gemini, multimodal) ]            │
                                    │                                     │
                        ┌───────────┴───────────┐                        │
                        ▼                       ▼                        │
                    QCFinding: PASS        QCFinding: FAIL                │
                        │                       │                        │
                        ▼                       ▼                        │
              approval_events            [ Revision agent ]               │
              (Postgres, approved)              │                        │
                        │              RevisionInstruction                │
                        │                       │                        │
                        │                       ▼                        │
                        │            back to generation adapter          │
                        │                                                │
                        └──► continuity_fingerprints + qc_findings +    ─┘
                             agent_decision_log (ClickHouse, via MCP)
```

## 8. Frontend (Next.js, dashboard-grade)

Not a hackathon toy UI. Dashboard-grade: real empty/loading/error states, real hierarchy, real
spacing — this is a piece of the portfolio, not a demo throwaway.

Visual design system is locked: **Lab Bench** (cool slate, sharp corners, mono-forward headings
and data, single blue accent, semantic status colors on distinct hues). Landing page and app share
it. Full spec: [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md), tokens: [`design/globals.css`](../design/globals.css).

- **Sequence view** — shot thumbnails, status badges, live agent-session indicator.
- **Shot detail** — version history, scrubber with timestamp-anchored QC notes overlaid on the
  video, reference panel, provenance/lineage panel.
- **Live dailies session** — real-time plan → generate → critique → revise log, streamed from
  FastAPI (SSE or WebSocket). This is the demo centerpiece — the moment a viewer watches the agent
  fail and fix a shot in front of them.
- **Sequence playback** — approved shots played back to back.
- **Export panel** — VFX package tree preview + Nuke script preview + download.

## 9. Export / VFX handoff

```
SQ010_SH030/
    plate/
    gen/
        SH030_gen_v003.mov
    refs/
        character.png
        suitcase.png
        environment.png
    metadata/
        manifest.json
        generation.json
        provenance.json
        qc.json
        notes.json
    SH030_comp.nk        # templated: Read plate, Read gen, Merge, OCIO, Grain, Write
```

## 10. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js (App Router), pnpm-enforced | user default, dashboard-grade UX |
| Relational store | Postgres 16 (Docker) | transactional integrity on approval state |
| Analytics / production memory | ClickHouse (Docker) | required MCP track; append-only continuity history |
| Object storage | MinIO (S3-compatible, Docker) | generated video + reference frames + exports |
| Backend agent runtime | FastAPI (Python) | best Gemini/Veo SDK support, async agent loop |
| Frontend contracts | Zod | boundary validation |
| Backend contracts | Pydantic v2 | boundary validation, mirrors Zod shapes |
| Video generation | Veo 3.1, via the Gemini Developer API (`GEMINI_API_KEY`) | image-conditioned + first/last-frame guidance, no separate Vertex setup |
| Vision / critique / planning | `gemini-3.1-pro-preview` (critic) / `gemini-3.6-flash` (planner) | multimodal video understanding, structured output |
| ORM | Drizzle | matches existing project convention |

## 11. Ports (already reserved, `~/dev/ports.md`, path `~/dev/arc-engine`)

| Service | Port |
| --- | --- |
| Next.js web | 3210 |
| Playwright e2e | 3211 |
| FastAPI agent runtime | 8091 |
| Postgres | 5451 |
| ClickHouse HTTP / TCP | 8124 / 9005 |
| MinIO API / console | 9010 / 9011 |

Same port block as when this project lived at `~/dev/blockbuster/arc-engine`; ports.md tracks the
path change, not a renumber.
