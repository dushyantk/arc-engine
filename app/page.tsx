import { Fragment, type CSSProperties } from "react";
import Image from "next/image";
import Link from "next/link";
import { LandingMotion } from "@/components/landing-motion";
import {
  getLandingFindings,
  getLandingStats,
  getShotDeepLink,
  type LandingFinding,
  type LandingStats,
} from "@/lib/data";
import "./landing.css";

export const dynamic = "force-dynamic";

// Runs while the HTML is still parsing, so the hidden reveal states only ever
// exist once something can undo them; an effect would run after first paint and
// flash. It marks the landing root rather than <html>, whose class attribute the
// root layout owns - mutating that before hydration is a React attribute
// mismatch, and suppressHydrationWarning can only be set where the element is
// rendered.
const MARK_SCRIPT_CAPABLE =
  "document.currentScript.parentElement.classList.add('js')";

// The shot public/proof/evidence-clock.jpg is a frame of, and the shot the
// Revise stage quotes its logged failures from.
const EVIDENCE_SHOT_CODE = "SH020";

// Stage 04 quotes one take's review rather than the whole findings table; the
// full review for every version lives on that shot's dashboard page.
const FEATURED_QUOTE_LIMIT = 5;

// The seven axes server/agents/critic.py asks the critic to score.
const CONTINUITY_AXES = [
  "Character identity",
  "Costume continuity",
  "Hero prop",
  "Screen direction",
  "Environment continuity",
  "Temporal stability",
  "Lighting continuity",
];

const HANDOFF_TREE = [
  { path: "├─ plate/        ", note: "source plate" },
  { path: "├─ gen/          ", note: "generated takes" },
  { path: "├─ refs/         ", note: "locked references" },
  { path: "├─ metadata/     ", note: "findings, versions, lineage" },
  { path: "└─ *.nk          ", note: "templated Nuke script" },
];

const STACK = [
  "Next.js",
  "FastAPI",
  "Postgres",
  "ClickHouse",
  "MinIO",
  "Gemini",
  "Veo 3.1",
];

// What each ledger row is, beyond its agent name. Counts come from the log.
const LEDGER_DETAIL: Record<string, (calls: number) => string> = {
  generation_adapter: (calls) => `Veo 3.1 · ${formatCount(calls)} renders`,
  critic: (calls) => `${formatCount(calls)} reviews`,
  planner: (calls) => `${formatCount(calls)} calls`,
  revision_agent: () => "regeneration instructions",
  approval_gate: () => "deterministic",
};

type Verdict = LandingFinding["verdict"];
type AgentSpend = LandingStats["byAgent"][number];

// Declined axes sort last: the page quotes the critic to show it makes real
// calls, and "could not observe this" is the least interesting of them.
const VERDICT_ORDER: Record<Verdict, number> = {
  fail: 0,
  warning: 1,
  pass: 2,
  not_applicable: 3,
};

const VERDICT_UI: Record<Verdict, { label: string; icon: string; tone: string }> = {
  fail: { label: "Fail", icon: "#i-fail", tone: "fail" },
  warning: { label: "Warning", icon: "#i-warn", tone: "warn" },
  pass: { label: "Pass", icon: "#i-check", tone: "pass" },
  // Not a pass, and styled so it cannot be mistaken for one.
  not_applicable: { label: "Not checked", icon: "#i-human", tone: "warn" },
};

function formatUsd(amount: number) {
  return `$${amount.toFixed(2)}`;
}

function formatCount(value: number) {
  return value.toLocaleString("en-US");
}

function categoryLabel(category: string) {
  const words = category.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function versionLabel(version: number) {
  return `v${String(version).padStart(3, "0")}`;
}

// A stage cannot be described without its own ledger row: a silently zeroed
// figure would claim a stage was free when in fact it never ran.
function agentSpend(stats: LandingStats, agentName: string): AgentSpend {
  const row = stats.byAgent.find((entry) => entry.agentName === agentName);
  if (!row) {
    throw new Error(`No agent_decision_log rows for agent "${agentName}"`);
  }
  return row;
}

type Review = { shotCode: string; version: number; findings: LandingFinding[] };

function groupReviews(findings: LandingFinding[]): Review[] {
  const byVersion = new Map<string, Review>();
  for (const finding of findings) {
    const key = `${finding.shotCode}#${finding.version}`;
    const review = byVersion.get(key) ?? {
      shotCode: finding.shotCode,
      version: finding.version,
      findings: [],
    };
    review.findings.push(finding);
    byVersion.set(key, review);
  }
  return [...byVersion.values()];
}

// The most thoroughly reviewed take is the one that carries the section's
// argument: pass, warning and fail landing on the same version.
function pickFeaturedReview(reviews: Review[]): Review | null {
  return reviews.reduce<Review | null>(
    (best, review) =>
      best === null || review.findings.length > best.findings.length ? review : best,
    null,
  );
}

function worstFirst(findings: LandingFinding[]) {
  return [...findings].sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict],
  );
}

function findingKey(finding: LandingFinding) {
  return `${finding.shotCode}#${finding.version}#${finding.category}`;
}

function Finding({ finding }: { finding: LandingFinding }) {
  const ui = VERDICT_UI[finding.verdict];
  return (
    <li className={`finding finding--${ui.tone}`}>
      <div className="finding__hd">
        <span className={`pill pill--${ui.tone}`}>
          <svg className="ic" aria-hidden="true"><use href={ui.icon} /></svg>{ui.label}
        </span>
        <span className="finding__cat">{categoryLabel(finding.category)}</span>
        <span className="finding__src">{finding.shotCode} · {versionLabel(finding.version)}</span>
      </div>
      <blockquote className="finding__q">{`“${finding.description}”`}</blockquote>
    </li>
  );
}

export default async function LandingPage() {
  const [stats, findings, evidenceShotLink] = await Promise.all([
    getLandingStats(),
    getLandingFindings(),
    getShotDeepLink(EVIDENCE_SHOT_CODE),
  ]);

  const planner = agentSpend(stats, "planner");
  const generation = agentSpend(stats, "generation_adapter");
  const critic = agentSpend(stats, "critic");
  const revision = agentSpend(stats, "revision_agent");
  const approval = agentSpend(stats, "approval_gate");

  const featured = pickFeaturedReview(groupReviews(findings));
  const featuredQuotes = featured
    ? worstFirst(featured.findings).slice(0, FEATURED_QUOTE_LIMIT)
    : [];
  const evidenceFailures = findings.filter(
    (finding) =>
      finding.shotCode === EVIDENCE_SHOT_CODE && finding.verdict === "fail",
  );

  const shotLink = evidenceShotLink ?? "/dashboard";
  const totalSpend = formatUsd(stats.totalSpendUsd);
  const totalCalls = formatCount(stats.totalCalls);

  return (
    <div className="dailies-landing" suppressHydrationWarning>
      <script dangerouslySetInnerHTML={{ __html: MARK_SCRIPT_CAPABLE }} />
      <LandingMotion />

      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
        <defs>
          <symbol id="i-plan" viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h6" /><circle cx="18" cy="15" r="3" /><path d="M20.5 17.5 22.5 19.5" /></symbol>
          <symbol id="i-gen" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="1" /><path d="M8 6v12M16 6v12" /></symbol>
          <symbol id="i-watch" viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="2.6" /></symbol>
          <symbol id="i-crit" viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M8 9h8M8 13h8M8 17h4" /></symbol>
          <symbol id="i-rev" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8" /><path d="M20 3v4h-4" /></symbol>
          <symbol id="i-appr" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M8.5 12.2l2.6 2.6 4.8-5.6" /></symbol>
          <symbol id="i-check" viewBox="0 0 24 24"><path d="M4 12.6l5 5L20 6.4" /></symbol>
          <symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 4.2 21 20H3z" /><path d="M12 10v4M12 17h.01" /></symbol>
          <symbol id="i-fail" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></symbol>
          <symbol id="i-human" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4" /><path d="M4.6 20a7.4 7.4 0 0 1 14.8 0" /></symbol>
          <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6" /></symbol>
          <symbol id="i-loop" viewBox="0 0 24 24"><path d="M4 9.5A5.5 5.5 0 0 1 9.5 4H19" /><path d="M16 1l3 3-3 3" /><path d="M20 14.5a5.5 5.5 0 0 1-5.5 5.5H5" /><path d="M8 23l-3-3 3-3" /></symbol>
          <symbol id="i-box" viewBox="0 0 24 24"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" /><path d="M3 7.5 12 12l9-4.5M12 12v9" /></symbol>
          <symbol id="i-play" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" /><path d="M10.2 8.8 15.4 12l-5.2 3.2Z" /></symbol>
        </defs>
      </svg>

      <a className="co-skip" href="#top">Skip to content</a>

      <div className="co-slatebar" id="co-slatebar">
        <div className="co-slatebar__id">
          <b>DAILIES</b>
          <span>SH020_v006</span>
          <span>REAL RUN</span>
        </div>
        <Link className="co-btn co-btn--primary" href="/dashboard">See the pipeline <svg aria-hidden="true"><use href="#i-arrow" /></svg></Link>
      </div>

      <div className="co-topbar" role="banner">
        <div className="co-brand">
          <span className="co-brand__name">Dailies</span>
          <span className="co-brand__meta">Agentic GenFX supervisor</span>
        </div>
        <nav className="co-topnav" aria-label="Primary">
          <a href="#loop">The loop</a>
          <a href="#watch">Evidence</a>
          <a href="#critique">Notes</a>
          <a href="#ledger">Cost</a>
        </nav>
        <Link className="co-btn co-btn--primary" href="/dashboard">See the pipeline <svg aria-hidden="true"><use href="#i-arrow" /></svg></Link>
      </div>

      <section className="co-hero" id="co-hero" aria-labelledby="co-hero-title">
        <div className="co-hero__plate">
          <Image
            src="/proof/hero.jpg"
            alt="Frame from shot SH020, take 006: a woman crosses a rain-soaked railway station platform at night, carrying a red suitcase."
            width={1280}
            height={720}
            priority
          />
          <div className="co-hero__scrim" aria-hidden="true"></div>
          <div className="co-fx-scan" aria-hidden="true"></div>
          <svg className="co-fx-grain" aria-hidden="true" focusable="false" preserveAspectRatio="none">
            <filter id="co-grainfx"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
            <rect width="100%" height="100%" filter="url(#co-grainfx)" />
          </svg>
        </div>

        <div className="co-hero__bar co-hero__bar--top" aria-hidden="true"></div>

        <div className="co-hero__content">
          <div className="co-slate">
            <span className="co-slate__code">SH020_v006</span>
            <span className="co-slate__sep" aria-hidden="true"></span>
            <span>Veo 3.1</span>
            <span className="co-slate__sep" aria-hidden="true"></span>
            <span>16:9</span>
            <span className="co-slate__sep" aria-hidden="true"></span>
            <span>TC 00:00:03:18</span>
          </div>

          <h1 className="co-hero__title" id="co-hero-title">
            <span className="l1">Generating a shot is easy.</span>
            <span className="l2">Making it belong in the movie is the problem.</span>
          </h1>

          <p className="co-hero__deck">Dailies plans the shot, generates it with Veo 3.1, watches its own footage with Gemini, writes the notes, and regenerates what failed. It marks a shot approved only when the shot agrees with everything around it.</p>

          <div className="co-hero__cta">
            <Link className="co-btn co-btn--primary" href="/dashboard">See the pipeline <svg aria-hidden="true"><use href="#i-arrow" /></svg></Link>
            <a className="co-btn co-btn--ghost" href="#revise"><svg aria-hidden="true"><use href="#i-play" /></svg> Watch SH020 fail, then get fixed</a>
          </div>
        </div>

        <div className="co-hero__cue" aria-hidden="true"><span>Scroll</span><i></i></div>

        <div className="co-hero__bar co-hero__bar--bot">
          <span>Dailies · Agentic GenFX supervisor</span>
          <span>Real run · {totalCalls} calls · {totalSpend}</span>
        </div>
      </section>

      <main id="top">

        {/* ======================= HERO ======================= */}
        <section className="wrap row hero" aria-labelledby="thesis">
          <div className="rail" aria-hidden="true">
            <span className="rail__track"></span>
            <span className="rail__fill"></span>
            <span className="rail__origin"></span>
          </div>
          <div className="body">
            <p className="kicker hero__kicker" data-reveal>SH020 · rain platform · v001 → v006 · {formatCount(stats.runCount)} runs logged</p>

            <h2 id="thesis" data-reveal data-d="1">
              <span className="dim">From brief to approval.</span>
              Every verdict on the record.
            </h2>

            <p className="hero__lede" data-reveal data-d="2">
              Dailies is a <strong>supervisor, not a generator</strong>. It plans a shot against the
              approved continuity state, renders it with Veo 3.1, watches its own footage with Gemini,
              writes real dailies notes, and regenerates what failed. A shot is marked approved only when
              it agrees with the shot before it, the shot after it, the locked character, prop and
              environment references, and the show’s technical rules.
            </p>

            <div className="hero__cta" data-reveal data-d="3">
              <Link className="btn btn--primary" href="/dashboard">
                See the pipeline
                <svg className="ic" aria-hidden="true"><use href="#i-arrow" /></svg>
              </Link>
              <a className="btn btn--ghost" href="#plan">Start at the first stage</a>
            </div>

            <div className="hero__note" data-reveal data-d="3">
              <span>This is a real run, not a mockup.</span>
              <span><b>{totalSpend}</b> logged</span>
              <span><b>{totalCalls}</b> agent calls</span>
              <span><b>{formatCount(stats.veoGenerations)}</b> Veo 3.1 generations</span>
            </div>
          </div>
        </section>

        {/* ======================= THE LOOP ======================= */}
        <section id="loop" aria-label="The closed loop, stage by stage">

          {/* spine origin */}
          <div className="wrap row row--open">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
              <span className="rail__mark"><span className="rail__idx">00</span><span className="rail__node rail__node--dot"></span></span>
            </div>
            <div className="body">
              <p className="kicker" data-reveal>The loop</p>
              <h2 className="open__title" data-reveal data-d="1">Six stages, one shot, in the order the run actually happened.</h2>
              <p className="open__chain" data-reveal data-d="2">
                <a href="#plan">Plan</a><span>→</span>
                <a href="#generate">Generate</a><span>→</span>
                <a href="#watch">Watch</a><span>→</span>
                <a href="#critique">Critique</a><span>→</span>
                <a href="#revise">Revise</a><span>→</span>
                <a href="#approve">Approve</a>
              </p>
            </div>
          </div>

          {/* ---------- 01 PLAN ---------- */}
          <section className="wrap row station station--tight" id="plan" aria-labelledby="h-plan">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
              <span className="rail__mark"><span className="rail__idx">01</span><span className="rail__node"></span></span>
            </div>
            <div className="body">
              <div className="st-head" data-reveal>
                <p className="st-idx-inline">Stage 01</p>
                <div className="st-title">
                  <svg className="ic ic--lg" aria-hidden="true"><use href="#i-plan" /></svg>
                  <h2 id="h-plan">Plan</h2>
                </div>
                <p className="st-cost">
                  <span className="st-cost__n">{formatUsd(planner.spendUsd)}</span>
                  <span className="st-cost__l">planner · {formatCount(planner.calls)} calls</span>
                </p>
              </div>
              <p className="st-lede" data-reveal data-d="1">
                Gemini queries the approved continuity state through ClickHouse before it writes a single
                word of the prompt.
              </p>
              <p className="st-body" data-reveal data-d="2">
                The prompt is not authored from the scene brief alone. It is authored from what has
                already been approved — the preceding shot, the following shot, and the locked
                character, prop and environment references. {formatCount(planner.calls)} planner calls
                across this run, {formatUsd(planner.spendUsd)}.
              </p>
            </div>
          </section>

          {/* ---------- 02 GENERATE ---------- */}
          <section className="wrap row station" id="generate" aria-labelledby="h-generate">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
              <span className="rail__mark"><span className="rail__idx">02</span><span className="rail__node"></span></span>
            </div>
            <div className="body">
              <div className="st-head" data-reveal>
                <p className="st-idx-inline">Stage 02</p>
                <div className="st-title">
                  <svg className="ic ic--lg" aria-hidden="true"><use href="#i-gen" /></svg>
                  <h2 id="h-generate">Generate</h2>
                </div>
                <p className="st-cost">
                  <span className="st-cost__n">{formatUsd(generation.spendUsd)}</span>
                  <span className="st-cost__l">generation_adapter · {formatCount(generation.calls)} renders</span>
                </p>
              </div>
              <p className="st-lede" data-reveal data-d="1">
                Veo 3.1 renders the candidate shot from that grounded prompt.
              </p>
              <p className="st-body" data-reveal data-d="2">
                This is the expensive part of the run: <strong>{formatUsd(generation.spendUsd)} of {totalSpend}</strong>. Every stage
                below it exists to protect that spend — and together they cost {formatUsd(stats.supervisionSpendUsd)}.
              </p>

              <div className="panel record" data-reveal data-d="2">
                <div className="panel__hd">
                  <span>Shot record</span>
                  <span>SH020</span>
                </div>
                <div className="record__rows">
                  <div className="record__row"><span className="record__k">Shot</span><span className="record__v">SH020 · rain platform, night</span></div>
                  <div className="record__row"><span className="record__k">Takes</span><span className="record__v">v001 · v003 · v005 · v006</span></div>
                  <div className="record__row"><span className="record__k">Model</span><span className="record__v">Veo 3.1</span></div>
                  <div className="record__row"><span className="record__k">Grounding</span><span className="record__v">approved continuity state (ClickHouse)</span></div>
                  <div className="record__row"><span className="record__k">Constraint</span><span className="record__v"><em>station clock excluded from frame</em></span></div>
                </div>
              </div>
            </div>
          </section>

          {/* ---------- 03 WATCH ---------- */}
          <section className="wrap row station station--wide" id="watch" aria-labelledby="h-watch">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
              <span className="rail__mark"><span className="rail__idx">03</span><span className="rail__node"></span></span>
            </div>
            <div className="body">
              <div className="st-head" data-reveal>
                <p className="st-idx-inline">Stage 03</p>
                <div className="st-title">
                  <svg className="ic ic--lg" aria-hidden="true"><use href="#i-watch" /></svg>
                  <h2 id="h-watch">Watch</h2>
                </div>
                <p className="st-cost">
                  <span className="st-cost__n">{formatCount(critic.calls)}</span>
                  <span className="st-cost__l">critic reviews · Gemini</span>
                </p>
              </div>
              <p className="st-lede" data-reveal data-d="1">
                The critic reviews labeled frames in order, not just the first and last one.
              </p>

              <figure className="plate" data-reveal data-d="2">
                <Image
                  className="plate__img"
                  src="/proof/hero.jpg"
                  width={1280}
                  height={720}
                  alt="SH020 v006 — Maya crossing a rain-soaked railway station platform at night, carrying a red suitcase, lit from camera-left."
                />
                <span className="plate__scrim" aria-hidden="true"></span>
                <div className="plate__burn" aria-hidden="true">
                  <span>SH020</span><span className="sep">/</span><span>v006</span>
                  <span className="sep">/</span><span>Veo 3.1</span>
                  <span className="sep">/</span><span>16:9</span>
                </div>
                <figcaption className="plate__foot">Generated footage — the shot under supervision</figcaption>
              </figure>
              <p className="cap">
                <Link href={shotLink}><b>SH020 v006.</b></Link> Real generated footage from this run. Nothing on this page is stock,
                storyboard or concept art — it is the material the critic actually watched.
              </p>

              <div className="frames-blk" data-reveal>
                <h3 className="kicker">The frame strip</h3>
                <div className="frames" role="img" aria-label="Schematic of the labeled frame sequence handed to the critic, with the defect boundary marked between frame 4 and frame 5.">
                  <div className="frame"><span className="frame__lbl">F1</span></div>
                  <div className="frame"><span className="frame__lbl">F2</span></div>
                  <div className="frame"><span className="frame__lbl">F3</span></div>
                  <div className="frame"><span className="frame__lbl">F4</span></div>
                  <div className="frame frame--break"><span className="frame__lbl">F5</span></div>
                  <div className="frame frame--more"><span className="frame__lbl">…</span></div>
                </div>
                <p className="frames-key"><span><span className="tick" aria-hidden="true"></span>Defect boundary — adjacent frames</span></p>
                <p className="cap">
                  Schematic of how frames reach the critic: labeled, ordered, compared against each other.
                  A hero prop that changes hands <b>between two adjacent frames</b> is caught here.
                  A first-and-last-frame check would have passed that take.
                </p>
              </div>
            </div>
          </section>

          {/* ---------- 04 CRITIQUE ---------- */}
          <section className="wrap row station station--wide" id="critique" aria-labelledby="h-critique">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
              <span className="rail__mark"><span className="rail__idx">04</span><span className="rail__node"></span></span>
            </div>
            <div className="body">
              <div className="st-head" data-reveal>
                <p className="st-idx-inline">Stage 04</p>
                <div className="st-title">
                  <svg className="ic ic--lg" aria-hidden="true"><use href="#i-crit" /></svg>
                  <h2 id="h-critique">Critique</h2>
                </div>
                <p className="st-cost">
                  <span className="st-cost__n">{formatUsd(critic.spendUsd)}</span>
                  <span className="st-cost__l">critic · {formatCount(critic.calls)} reviews</span>
                </p>
              </div>
              <p className="st-lede" data-reveal data-d="1">
                Every finding is pass, warning, or fail. Creative variation is not the same thing as a
                defect.
              </p>
              <p className="st-body" data-reveal data-d="2">
                Below is one review of one take, unedited, exactly as the critic wrote it into{" "}
                <strong>qc_findings</strong>. Watching and critiquing are the same component:{" "}
                {formatCount(critic.calls)} reviews, {formatUsd(critic.spendUsd)}.
              </p>

              <ul className="findings" data-reveal>
                {featuredQuotes.map((finding) => (
                  <Finding key={findingKey(finding)} finding={finding} />
                ))}
              </ul>

              <p className="st-body" data-reveal>
                Pass, warning and fail on the same take is the point. A binary filter would have thrown
                this shot away or waved it through; a dailies note tells you which axis broke.
              </p>

              <div className="axes" data-reveal>
                <h3 className="kicker">Continuity axes the critic scores</h3>
                <ul className="axes__list">
                  {CONTINUITY_AXES.map((axis) => (
                    <li key={axis}>{axis}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* ---------- 05 REVISE ---------- */}
          <section className="wrap row station station--wide" id="revise" aria-labelledby="h-revise">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
              <span className="rail__mark"><span className="rail__idx">05</span><span className="rail__node"></span></span>
            </div>
            <div className="body">
              <div className="st-head" data-reveal>
                <p className="st-idx-inline">Stage 05</p>
                <div className="st-title">
                  <svg className="ic ic--lg" aria-hidden="true"><use href="#i-rev" /></svg>
                  <h2 id="h-revise">Revise</h2>
                </div>
                <p className="st-cost">
                  <span className="st-cost__n">{formatUsd(revision.spendUsd)}</span>
                  <span className="st-cost__l">revision_agent</span>
                </p>
              </div>
              <p className="st-lede" data-reveal data-d="1">
                A failed finding becomes a concrete regeneration instruction, not a vague retry.
              </p>

              <figure className="plate" data-reveal data-d="2">
                <Image
                  className="plate__img"
                  src="/proof/evidence-clock.jpg"
                  width={1280}
                  height={720}
                  loading="lazy"
                  alt="SH020 v003 — the same night platform, with the background station clock clearly visible in frame although the generation prompt required it excluded."
                />
                <span className="plate__scrim" aria-hidden="true"></span>
                <div className="plate__burn" aria-hidden="true">
                  <span>SH020</span><span className="sep">/</span><span>v003</span>
                  <span className="sep">/</span><span>hero_prop</span>
                </div>
                <figcaption className="plate__foot">Evidence frame — documented failure</figcaption>
              </figure>
              <p className="cap">
                <b>The station clock is in frame.</b> The generation prompt explicitly required it
                excluded. This is the evidence attached to a real, logged FAIL — not a hypothetical
                one.
              </p>

              <ul className="findings" data-reveal>
                {evidenceFailures.map((finding) => (
                  <Finding key={findingKey(finding)} finding={finding} />
                ))}
              </ul>

              <div className="panel record" data-reveal style={{ maxWidth: "720px" }}>
                <div className="panel__hd">
                  <span>What the holistic pass missed</span>
                  <span>engineering note</span>
                </div>
                <div className="record__rows">
                  <div className="record__row" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                    <p className="record__v" style={{ fontFamily: "var(--sans)", fontSize: "15px", lineHeight: 1.6, color: "var(--muted-foreground)" }}>
                      A suitcase duplicated across both hands for roughly a second. The holistic review
                      did not report it. It was caught only after the critic switched to labeled
                      frame-by-frame comparison — which is why the frame strip is labeled at all.
                      The failure mode was in the review method, not the model.
                    </p>
                  </div>
                </div>
              </div>

              <p className="st-body" data-reveal>
                {formatUsd(revision.spendUsd)} of revision against {formatUsd(generation.spendUsd)} of generation. The instruction goes back with the
                finding attached and the locked references re-supplied, so the next take is corrected
                rather than re-rolled.
              </p>
            </div>
          </section>

          {/* ---------- loop-back edge ---------- */}
          <div className="wrap row row--back">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
            </div>
            <div className="body">
              <div className="loopback" data-reveal>
                <svg className="ic ic--lg" aria-hidden="true"><use href="#i-loop" /></svg>
                <div>
                  <p className="loopback__t">Back to Generate · maximum 4 rounds</p>
                  <p className="loopback__d">
                    While a hard failure is still open, the run returns to Generate with the finding
                    attached. The system caps revision rounds at four and escalates to{" "}
                    <strong>needs_human</strong> rather than looping forever or auto-approving.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* ---------- 06 APPROVE ---------- */}
          <section className="wrap row station" id="approve" aria-labelledby="h-approve">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
              <span className="rail__mark"><span className="rail__idx">06</span><span className="rail__node"></span></span>
            </div>
            <div className="body">
              <div className="st-head" data-reveal>
                <p className="st-idx-inline">Stage 06</p>
                <div className="st-title">
                  <svg className="ic ic--lg" aria-hidden="true"><use href="#i-appr" /></svg>
                  <h2 id="h-approve">Approve</h2>
                </div>
                <p className="st-cost">
                  <span className="st-cost__n">{formatUsd(approval.spendUsd)}</span>
                  <span className="st-cost__l">approval_gate</span>
                </p>
              </div>
              <p className="st-lede" data-reveal data-d="1">
                Only when every hard failure clears. Warnings are logged, never hidden.
              </p>
              <p className="st-body" data-reveal data-d="2">
                The gate is deterministic, not agentic. No model votes on approval — a shot passes
                when every hard-fail category passes, and not before. That is why this stage costs
                nothing.
              </p>

              <div className="rules" data-reveal>
                <div className="rule">
                  <p className="rule__t">Every hard-fail category clear
                    <span>The shot agrees with its neighbours and the locked references. Handoff package written.</span>
                  </p>
                  <span className="pill pill--pass"><svg className="ic" aria-hidden="true"><use href="#i-check" /></svg>Approved</span>
                </div>
                <div className="rule">
                  <p className="rule__t">A hard failure still open
                    <span>The finding becomes a regeneration instruction and the run returns to Generate.</span>
                  </p>
                  <span className="pill pill--fail"><svg className="ic" aria-hidden="true"><use href="#i-fail" /></svg>Revise</span>
                </div>
                <div className="rule">
                  <p className="rule__t">Four rounds spent, failure persists
                    <span>No auto-approval, no infinite loop. The run stops and asks for a supervisor.</span>
                  </p>
                  <span className="pill pill--human"><svg className="ic" aria-hidden="true"><use href="#i-human" /></svg>needs_human</span>
                </div>
              </div>

              <p className="st-body" data-reveal>
                Warnings — like the eyebrow scar rendered on the wrong side of Maya’s face
                — stay on the record where a supervisor can see them, instead of being quietly
                absorbed into a pass.
              </p>
            </div>
          </section>

          {/* spine terminus */}
          <div className="wrap row row--close">
            <div className="rail" aria-hidden="true">
              <span className="rail__track"></span>
              <span className="rail__fill"></span>
              <span className="rail__mark"><span className="rail__idx">—</span><span className="rail__node rail__node--dot"></span></span>
            </div>
            <div className="body">
              <p className="close__line" data-reveal>
                <svg className="ic" aria-hidden="true"><use href="#i-check" /></svg>
                End of loop · handoff package written
              </p>
            </div>
          </div>
        </section>

        {/* ======================= LEDGER ======================= */}
        <section className="band" id="ledger" aria-labelledby="h-ledger">
          <div className="wrap wrap--mid">
            <div className="sec-head" data-reveal>
              <p className="kicker">Run ledger</p>
              <h2 id="h-ledger">Supervision costs about {Math.round(stats.supervisionSharePct)}% of what it protects.</h2>
              <p>
                Every agent call in this run is logged with its cost, tokens and latency. Split by
                component, the argument makes itself: the loop is cheap, the footage is not.
              </p>
            </div>

            <div className="ledger" data-reveal>
              {stats.byAgent.map((row) => (
                <div
                  key={row.agentName}
                  className={
                    row.agentName === "generation_adapter"
                      ? "ledger__row ledger__row--gen"
                      : "ledger__row"
                  }
                >
                  <p className="ledger__k">{row.agentName}<small>{LEDGER_DETAIL[row.agentName]?.(row.calls) ?? `${formatCount(row.calls)} calls`}</small></p>
                  <div className="ledger__bar" aria-hidden="true">
                    <i
                      style={{
                        "--w": `${((row.spendUsd / stats.totalSpendUsd) * 100).toFixed(3)}%`,
                      } as CSSProperties}
                    ></i>
                  </div>
                  <p className="ledger__v">{formatUsd(row.spendUsd)}</p>
                </div>
              ))}

              <div className="ledger__total">
                <span><b>{totalSpend}</b> total spend</span>
                <span><b>{totalCalls}</b> agent calls</span>
                <span><b>{formatCount(stats.runCount)}</b> runs</span>
                <span><b>{formatUsd(stats.supervisionSpendUsd)}</b> of supervision</span>
              </div>
            </div>

            <p className="ledger__note" data-reveal>
              Figures read from the run’s own <span className="mono">agent_decision_log</span> and{" "}
              <span className="mono">qc_findings</span> tables. No estimates, no projections, no rounding in
              our favour.
            </p>
          </div>
        </section>

        {/* ======================= HANDOFF ======================= */}
        <section className="wrap handoff" id="handoff" aria-labelledby="h-handoff">
          <div className="sec-head" data-reveal>
            <p className="kicker">Output</p>
            <h2 id="h-handoff">What comes out is a handoff, not a download.</h2>
          </div>

          <div className="handoff__grid">
            <div className="panel tree" data-reveal>
              <pre>
                {"handoff/"}
                {HANDOFF_TREE.map((entry) => (
                  <Fragment key={entry.note}>{`\n${entry.path}`}<span>{entry.note}</span></Fragment>
                ))}
              </pre>
            </div>
            <div data-reveal data-d="1">
              <p className="st-body" style={{ marginTop: 0 }}>
                A real VFX handoff package with <strong>full provenance</strong>: the plate, the generated
                takes, the references the shot was locked against, the metadata that says which finding
                forced which version — and a templated Nuke script so the shot opens in the comp
                department rather than in a browser tab.
              </p>
              <p className="st-body">
                Nothing on the way through is untraceable. Every prompt, every review, every verdict and
                every regeneration is written down with the version it belongs to.
              </p>
              <ul className="stack" aria-label="Stack">
                {STACK.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ======================= CTA ======================= */}
        <section className="wrap wrap--tight cta" aria-labelledby="h-cta">
          <p className="kicker" data-reveal>Next</p>
          <h2 id="h-cta" data-reveal data-d="1" style={{ marginTop: "16px" }}>A closed loop, not a slot machine.</h2>
          <p data-reveal data-d="2">
            The dashboard opens on this run: every agent call with its cost, tokens and latency, every
            finding with its verdict, every version of SH020 from v001 to v006.
          </p>
          <div className="cta__btns" data-reveal data-d="3">
            <Link className="btn btn--primary" href="/dashboard">
              See the pipeline
              <svg className="ic" aria-hidden="true"><use href="#i-arrow" /></svg>
            </Link>
            <a className="btn btn--ghost" href="#revise">Watch SH020 fail, then get fixed</a>
          </div>
        </section>
      </main>

      <footer className="site-foot">
        <div className="wrap">
          <div className="foot__grid">
            <div>
              <h3 className="foot__h">Dailies</h3>
              <p className="foot__blurb">
                An agentic GenFX supervisor. It plans, generates, watches, critiques, revises and approves
                — and only approves when the shot agrees with everything around it.
              </p>
              <p style={{ marginTop: "18px" }}>
                <Link className="btn btn--ghost btn--sm" href="/dashboard">
                  See the pipeline
                  <svg className="ic" aria-hidden="true"><use href="#i-arrow" /></svg>
                </Link>
              </p>
            </div>

            <div>
              <h3 className="foot__h">The loop</h3>
              <ul className="foot__list">
                <li><a href="#plan">{"01  Plan"}</a></li>
                <li><a href="#generate">{"02  Generate"}</a></li>
                <li><a href="#watch">{"03  Watch"}</a></li>
                <li><a href="#critique">{"04  Critique"}</a></li>
                <li><a href="#revise">{"05  Revise"}</a></li>
                <li><a href="#approve">{"06  Approve"}</a></li>
              </ul>
            </div>

            <div>
              <h3 className="foot__h">This run</h3>
              <ul className="foot__list">
                <li><b>{totalSpend}</b> total spend</li>
                <li><b>{totalCalls}</b> agent calls</li>
                <li><b>{formatCount(stats.runCount)}</b> agent runs</li>
                <li><b>{formatCount(planner.calls)}</b> planner calls</li>
                <li><b>{formatCount(critic.calls)}</b> critic reviews</li>
                <li><b>{formatCount(stats.veoGenerations)}</b> Veo 3.1 generations</li>
              </ul>
            </div>

            <div>
              <h3 className="foot__h">Continuity axes</h3>
              <ul className="foot__list">
                {CONTINUITY_AXES.map((axis) => (
                  <li key={axis}>{axis}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="foot__bar">
            <span>Dailies — agentic GenFX supervisor</span>
            <span>Next.js · FastAPI · Postgres · ClickHouse · MinIO · Gemini · Veo 3.1</span>
            <span>Every figure on this page was read from the run log.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
