# Dailies

> An agentic GenFX supervisor that makes an AI-generated sequence survive dailies.

Give it an idea. Dailies writes a script from it, breaks that into a shot list, generates the
reference sheets the sequence has to stay true to, plans each shot against the approved continuity
state, generates it with Veo 3.1, watches its own footage with Gemini, writes real dailies notes,
regenerates what failed, and doesn't approve the sequence until the shots agree with each other.

Generating a shot is easy. Making it belong in a movie is the problem.

A human gates every step that costs money or becomes canon. Nothing generates without explicit
cost consent, and nothing an agent produced is treated as the truth other shots are judged
against until a person locks it.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Phased checklist:
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) · Visual system: [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)

## From idea to approved sequence

```
idea → script → [approve] → breakdown → [approve] → shots + reference sheets → [lock as canon]
                                                                                      ↓
                                                        plan → generate → watch → critique → revise → [approve]
```

Everything in `[brackets]` is a human decision, recorded in `approval_events` with a reason.

| Stage | What actually happens |
| --- | --- |
| Script | An idea prompt becomes a short, shootable sequence. Text only, cents. Approving it is the gate |
| Breakdown | The approved script becomes sequences, shots and the assets they need. You see the whole plan, shot by shot, before anything is written |
| Materialise | Real rows, transactionally. A shot that already has generated versions is never rewritten by a re-plan |
| Sheets | Reference images for the recurring characters, props and environments. They arrive **unlocked** — invisible to every agent until a human locks them as canon |

## The per-shot loop

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

### Sign-in

The dashboard is behind a single-operator sign-in. There is **no sign-up route** — an open one on
a deployment that spends real money would look protected while being worse than nothing. Create the
one account deliberately:

```bash
openssl rand -base64 32              # BETTER_AUTH_SECRET
pnpm auth:create-operator you@example.com
```

The landing page stays public; everything that can see or spend is behind the gate.

**The agent runtime needs its own guard.** Signing in protects the browser, not the FastAPI
process, and every billed endpoint lives there. Set `AGENT_RUNTIME_TOKEN` to the same value on both
sides; the web app attaches it server-side and the browser never sees it. Unset means the runtime
is open — fine on a laptop, and `GET /health` reports `"auth":"open"` so it is answerable from
outside rather than only from the log.

### Spending ceiling

Set `DAILIES_BUDGET_USD` to cap total spend across all runs. The runtime refuses a billed call
that would take the logged total past it, **before** the call is made, and says what is left:

```
HTTP 402 — This run is estimated at $3.20 and $29.78 of the $30.00 ceiling is
already spent, leaving $0.22. Raise DAILIES_BUDGET_USD or wait.
```

The ceiling overrides consent: confirming a cost does not buy past it. Unset means unlimited, and
the dashboard says so rather than implying a cap exists. It is a global cap rather than per-show
because spend is attributed by shot code, which is not unique across shows — a per-show figure is
one the data cannot actually support.

## Deployed

Live at **https://dailies-five.vercel.app** — the landing page is public, everything that can see
or spend is behind sign-in.

| Piece | Where | Why there |
| --- | --- | --- |
| Web | Vercel (`dailies`) | Next.js, server components read Postgres and ClickHouse directly |
| Agent runtime | Fly `dailies-runtime`, iad | Not serverless: a run is a background task and a critique takes ~390s |
| Postgres | Neon `dailies`, aws-us-east-1 | Provisioned in the Neon console, not the Vercel Marketplace |
| ClickHouse | Fly `dailies-clickhouse`, iad | One node with a volume; Cloud would be another vendor account for no gain |
| Objects | Cloudflare R2 `arc-engine` | S3-compatible, so only the endpoint and keys change |

Two things worth knowing before touching it:

**The runtime binds `0.0.0.0`, not `::`.** ClickHouse binds `::` happily because Linux dual-stack
accepts IPv4 on an IPv6 any-socket; uvicorn sets `IPV6_V6ONLY`, so the same flag makes it answer
from inside the machine and 502 from outside.

**ClickHouse is publicly reachable, password-protected.** Vercel reads it directly — `lib/clickhouse.ts`
runs server-side, outside Fly's private network. Routing those reads through the runtime would let
it be private, and is the right shape if this ever grows past one operator.

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

## Demo script

Roughly five minutes, and **every step below is free** except the one marked otherwise. The
figures on screen are read live from `agent_decision_log`; none of them are written by hand.

**1 · The argument (`/`)** — the landing page is assembled from one real run's ledger. The header
counts the actual agent calls and actual spend. Scroll: each stage quotes its own ledger row, and
the critique section quotes real findings against a real take.

**2 · Where the money went (`/dashboard/cost`)** — the same rows, aggregated by agent. Note how
little of the total is supervision and how much is generation. That ratio is the pitch.

**3 · A shot that argued with itself** — open **Platform Chase → SQ010 → SH020**. Six versions,
each with the critic's findings on the record: what passed, what failed, and what the reviser was
told to change. Nothing is hidden and nothing is retried vaguely.

**4 · A human overrules the machine** — on **SH010**, version 1 is a candidate with real footage.
Approve it with a reason. That writes a real `approval_events` row with `actor='human'` and moves
the shot. Approving is free; it spends nothing.

**5 · Ship it (`/dashboard/export`)** — the approved shot exports a real VFX handoff package,
provenance traced to the run that produced it. Covered end to end by `e2e/approve-export.spec.ts`.

**6 · Top-down, from nothing** — open **Lantern Signal**, a show built by the system rather than
by hand:

- **Script** — written from a one-line idea, then approved. That approval is the gate everything
  downstream is planned from.
- **Breakdown** — the shot list the script implies. Every shot shows what approving would do to
  it, and any shot that already has generated versions is marked *protected* and left alone.
  Earlier proposals stay readable underneath.
- **Reference sheets** — generated from the breakdown's asset list, each arriving **unlocked**.
  Open a shot and it says which breakdown proposed it.

**7 · The one that costs money** — from any shot with a brief, **Start run**. The dialog shows the
live model list, the real per-second price and what has already been spent before the consent
checkbox. A run is ~$3.20 on the standard tier, less on Fast or Lite. Set `DAILIES_BUDGET_USD`
first if you want a hard stop.

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

## License

[Apache License 2.0](LICENSE). Chosen over MIT for the explicit patent grant —
this generates and supervises media, and a permissive licence without one leaves
that question open for anyone building on it commercially.
