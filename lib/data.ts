import { and, asc, count, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "@/db/client";
import {
  approvalEvents,
  referenceAssets,
  sequences,
  shotVersions,
  shots,
  shows,
} from "@/db/schema";
import { getClickHouseClient } from "@/lib/clickhouse";

export type QcFinding = {
  category: string;
  verdict: "pass" | "fail" | "warning";
  frameRangeStart: number | null;
  frameRangeEnd: number | null;
  description: string;
  severity: "info" | "warning" | "critical";
};

// The critic's real runs log findings as prose (approval_events.reason,
// already surfaced on the shot detail page). Only the seed data has
// structured per-finding rows in ClickHouse dailies.qc_findings - this
// reads whatever real rows exist for a version rather than fabricating any.
export async function getQcFindings(shotId: string, version: number) {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT category, verdict, frame_range_start, frame_range_end, description, severity
      FROM dailies.qc_findings
      WHERE shot_id = {shotId:String} AND version = {version:UInt32}
      ORDER BY created_at ASC
    `,
    query_params: { shotId, version },
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    category: string;
    verdict: "pass" | "fail" | "warning";
    frame_range_start: number | null;
    frame_range_end: number | null;
    description: string;
    severity: "info" | "warning" | "critical";
  }>();
  return rows.map((row): QcFinding => ({
    category: row.category,
    verdict: row.verdict,
    frameRangeStart: row.frame_range_start,
    frameRangeEnd: row.frame_range_end,
    description: row.description,
    severity: row.severity,
  }));
}

// Global rail stats for the dashboard layout, which now spans multiple
// shows - no single show/sequence to scope counts to at that level.
export async function getGlobalRailStats() {
  const client = getClickHouseClient();
  const [showCount, sessionLogResult] = await Promise.all([
    db.select({ n: count() }).from(shows),
    client.query({
      query: "SELECT count() AS n FROM dailies.agent_decision_log",
      format: "JSONEachRow",
    }),
  ]);
  const sessionLogRows = await sessionLogResult.json<{ n: string }>();
  return {
    showCount: showCount[0]?.n ?? 0,
    sessionLogCount: Number(sessionLogRows[0]?.n ?? 0),
  };
}

export type DecisionLogEvent = {
  runId: string;
  agentName:
    | "planner"
    | "generation_adapter"
    | "critic"
    | "revision_agent"
    | "approval_gate";
  step: string;
  inputRef: string;
  outputRef: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
};

const DECISION_LOG_SELECT = `
  SELECT run_id, agent_name, step, input_ref, output_ref, model,
         tokens_in, tokens_out, cost_usd, latency_ms, toString(created_at) AS created_at
  FROM dailies.agent_decision_log
`;

type DecisionLogRow = {
  run_id: string;
  agent_name: DecisionLogEvent["agentName"];
  step: string;
  input_ref: string;
  output_ref: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  latency_ms: number;
  created_at: string;
};

function toDecisionLogEvent(row: DecisionLogRow): DecisionLogEvent {
  return {
    runId: row.run_id,
    agentName: row.agent_name,
    step: row.step,
    inputRef: row.input_ref,
    outputRef: row.output_ref,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: Number(row.cost_usd),
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

// Every real agent run this product has ever made, whoever triggered it -
// the CLI (server/run_session.py) today, a future FastAPI-triggered job
// later. Reading ClickHouse directly from Next.js (same pattern as
// getQcFindings/getRailStats) means this view doesn't care which process
// wrote the row, only that it's real.
export async function getRecentSessions(limit = 20) {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT run_id, min(created_at) AS started_at, max(created_at) AS last_event_at,
             count() AS event_count, sum(cost_usd) AS total_cost,
             groupArray(agent_name) AS agents
      FROM dailies.agent_decision_log
      GROUP BY run_id
      ORDER BY started_at DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { limit },
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    run_id: string;
    started_at: string;
    last_event_at: string;
    event_count: string;
    total_cost: string;
    agents: string[];
  }>();
  return rows.map((row) => ({
    runId: row.run_id,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    eventCount: Number(row.event_count),
    totalCost: Number(row.total_cost),
    hasGeneration: row.agents.includes("generation_adapter"),
  }));
}

export async function getSessionEvents(runId: string, sinceIso?: string) {
  const client = getClickHouseClient();
  const result = await client.query({
    query:
      DECISION_LOG_SELECT +
      (sinceIso
        ? " WHERE run_id = {runId:String} AND created_at > {since:DateTime64(3)} ORDER BY created_at ASC"
        : " WHERE run_id = {runId:String} ORDER BY created_at ASC"),
    query_params: sinceIso ? { runId, since: sinceIso } : { runId },
    format: "JSONEachRow",
  });
  const rows = await result.json<DecisionLogRow>();
  return rows.map(toDecisionLogEvent);
}

// Real provenance for one shot version: which agent run actually approved
// (or rejected) it. approval_gate logs its input_ref as "shot:{code}:v{n}"
// (server/agents/approval.py) - the one unambiguous anchor back to a
// specific version, since generation_adapter's own ref is just the shot
// code (no version exists yet at generation time). From that run_id, every
// other real step in the same run (plan, generate, critique, revise) comes
// along for free via getSessionEvents.
export async function getVersionProvenance(shotCode: string, versionNumber: number) {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT run_id FROM dailies.agent_decision_log
      WHERE agent_name = 'approval_gate' AND input_ref = {ref:String}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    query_params: { ref: `shot:${shotCode}:v${versionNumber}` },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ run_id: string }>();
  const runId = rows[0]?.run_id ?? null;
  const events = runId ? await getSessionEvents(runId) : [];
  return { runId, events };
}

// The full hierarchy is navigable now, not assumed via limit(1) - shows
// list is the dashboard root, every level below is reached by real
// foreign-key-scoped lookups. See docs/BUILD_PLAN.md's "Operator control
// plane" audit item this replaces.

export async function getShows() {
  const showRows = await db.select().from(shows).orderBy(desc(shows.createdAt));
  return Promise.all(
    showRows.map(async (show) => {
      const sequenceRows = await db
        .select()
        .from(sequences)
        .where(eq(sequences.showId, show.id));
      const shotCounts = await Promise.all(
        sequenceRows.map((sequence) =>
          db
            .select({ n: count() })
            .from(shots)
            .where(eq(shots.sequenceId, sequence.id)),
        ),
      );
      const shotCount = shotCounts.reduce((sum, rows) => sum + (rows[0]?.n ?? 0), 0);
      return { show, sequenceCount: sequenceRows.length, shotCount };
    }),
  );
}

export async function getShowDetail(showId: string) {
  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return null;

  const sequenceRows = await db
    .select()
    .from(sequences)
    .where(eq(sequences.showId, showId));

  const sequencesWithCounts = await Promise.all(
    sequenceRows.map(async (sequence) => {
      const shotRows = await db
        .select()
        .from(shots)
        .where(eq(shots.sequenceId, sequence.id));
      const approvedCount = shotRows.filter((s) => s.status === "approved").length;
      return { sequence, shotCount: shotRows.length, approvedCount };
    }),
  );

  const referenceRows = await db
    .select()
    .from(referenceAssets)
    .where(eq(referenceAssets.showId, showId));

  return { show, sequences: sequencesWithCounts, referenceAssets: referenceRows };
}

// Approved shots played back to back, in shot order. A shot's *approved*
// version isn't necessarily its latest one - SH020 is the real example:
// shots.status flipped to approved via a re-critique of v5, while v6 (the
// latest version chronologically) is still failed. Playback follows the
// same rule as the rest of the product: find the actual approved version
// row, don't assume "latest == approved."
//
// Also gates on shots.status === "approved", not just "a version somewhere
// has status=approved" - SH010 is the real example this caught: v1 (a
// seed row, never really critiqued) still carries version status
// "approved" even after v2/v3/v4 all failed for real and shots.status
// moved to needs_human. Without this gate, playback would include SH010
// as "approved footage" while the sequence view (which reads shots.status)
// correctly excludes it - two dashboard views disagreeing about the same
// real shot.
export async function getPlaybackSequence(showId: string, sequenceCode: string) {
  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return null;

  const [sequence] = await db
    .select()
    .from(sequences)
    .where(and(eq(sequences.showId, showId), eq(sequences.code, sequenceCode)))
    .limit(1);
  if (!sequence) return null;

  const shotRows = await db
    .select()
    .from(shots)
    .where(eq(shots.sequenceId, sequence.id))
    .orderBy(asc(shots.orderIndex));

  const items = await Promise.all(
    shotRows.map(async (shot) => {
      if (shot.status !== "approved") {
        return { shot, approvedVersion: null };
      }
      const [approvedVersion] = await db
        .select()
        .from(shotVersions)
        .where(
          and(
            eq(shotVersions.shotId, shot.id),
            eq(shotVersions.status, "approved"),
          ),
        )
        .orderBy(desc(shotVersions.versionNumber))
        .limit(1);
      return { shot, approvedVersion: approvedVersion ?? null };
    }),
  );

  return { show, sequence, items };
}

export async function getSequenceDetail(showId: string, sequenceCode: string) {
  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return null;

  const [sequence] = await db
    .select()
    .from(sequences)
    .where(and(eq(sequences.showId, showId), eq(sequences.code, sequenceCode)))
    .limit(1);
  if (!sequence) return null;

  const shotRows = await db
    .select()
    .from(shots)
    .where(eq(shots.sequenceId, sequence.id))
    .orderBy(asc(shots.orderIndex));

  const shotsWithVersions = await Promise.all(
    shotRows.map(async (shot) => {
      const versions = await db
        .select()
        .from(shotVersions)
        .where(eq(shotVersions.shotId, shot.id))
        .orderBy(desc(shotVersions.versionNumber));
      return { ...shot, versions, latestVersion: versions[0] ?? null };
    }),
  );

  return { show, sequence, shots: shotsWithVersions };
}

export async function getShotDetail(
  showId: string,
  sequenceCode: string,
  shotCode: string,
) {
  const [sequence] = await db
    .select()
    .from(sequences)
    .where(and(eq(sequences.showId, showId), eq(sequences.code, sequenceCode)))
    .limit(1);
  if (!sequence) return null;

  const [shot] = await db
    .select()
    .from(shots)
    .where(and(eq(shots.sequenceId, sequence.id), eq(shots.code, shotCode)))
    .limit(1);
  if (!shot) return null;

  const versions = await db
    .select()
    .from(shotVersions)
    .where(eq(shotVersions.shotId, shot.id))
    .orderBy(desc(shotVersions.versionNumber));

  const events = await db
    .select()
    .from(approvalEvents)
    .where(eq(approvalEvents.shotId, shot.id))
    .orderBy(desc(approvalEvents.createdAt));

  // shotVersionId is nullable now that approval_events can record decisions
  // about things that are not shot versions. Anything without one belongs to a
  // different subject and has no place in a per-version grouping.
  const eventsByVersion = new Map<string, typeof events>();
  for (const event of events) {
    if (!event.shotVersionId) continue;
    const existing = eventsByVersion.get(event.shotVersionId) ?? [];
    existing.push(event);
    eventsByVersion.set(event.shotVersionId, existing);
  }

  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);

  const versionsWithFindings = await Promise.all(
    versions.map(async (version) => ({
      ...version,
      events: eventsByVersion.get(version.id) ?? [],
      qcFindings: await getQcFindings(shot.id, version.versionNumber),
    })),
  );

  return {
    shot,
    sequence,
    show,
    versions: versionsWithFindings,
  };
}

// ---------------------------------------------------------------------------
// Shot state rules.

export type ShotStatusValue =
  | "pending"
  | "generating"
  | "reviewing"
  | "revise"
  | "approved"
  | "needs_human";

// RULE: every path that records a verdict on a version resolves shots.status
// through this function. Never write a version's own verdict straight onto the
// shot. Mirrors server/agents/approval.py resolve_shot_status() - the same rule
// stated twice, deliberately, like the Zod/Pydantic contracts.
//
// Latest and approved are independent axes. An approval is a durable fact about
// one version, not a claim about whichever version is newest: a later version
// may not have been evaluated yet, or may have been fired deliberately after the
// approval landed. Neither revokes it, and approving never locks the shot
// against generating more. Writing the newest verdict straight onto the shot is
// what let a re-critique of an old version silently move a shot's status.
//
// A human veto is the one thing that revokes an approval, and it does so by
// clearing that version's own status before this is called, so the answer still
// follows from the record rather than from a special case.
export function resolveShotStatus(
  versionVerdict: ShotStatusValue,
  { shotHasApprovedVersion }: { shotHasApprovedVersion: boolean },
): ShotStatusValue {
  return shotHasApprovedVersion ? "approved" : versionVerdict;
}

// ---------------------------------------------------------------------------
// Shot posters.
//
// RULE: any surface showing a still for a shot resolves it through
// pickShotPoster(). Do not reach for `latestVersion.posterAssetUrl` inline. The
// sequence grid did exactly that and every card ended up posterised from a
// failed take, because a shot's latest version is routinely not the version its
// status is about - the same "latest is not approved" trap already fixed in
// playback and export (05c90c4).

export type ShotPoster = {
  /** MinIO key, served through /api/media. */
  key: string;
  /** The version the still actually came from, which the caller must label. */
  versionNumber: number;
  /** False when the still is a stand-in because the version the status
   *  describes has no footage behind it - real state for SH010 v1 and
   *  SH030 v3, both "approved" rows pointing at bytes that were never
   *  uploaded. The card has to say so rather than imply this is the take. */
  representsShotStatus: boolean;
};

type PosterCandidate = {
  versionNumber: number;
  status: string;
  posterAssetUrl: string | null;
};

export function pickShotPoster(
  shot: { status: string },
  versions: PosterCandidate[],
): ShotPoster | null {
  const withPoster = [...versions]
    .filter((v) => Boolean(v.posterAssetUrl))
    .sort((a, b) => b.versionNumber - a.versionNumber);
  if (withPoster.length === 0) return null;

  // The version this card's status is about: the approved one when the shot is
  // approved, otherwise the most recent attempt (what an operator reviews next).
  const wanted =
    shot.status === "approved"
      ? [...versions]
          .filter((v) => v.status === "approved")
          .sort((a, b) => b.versionNumber - a.versionNumber)[0]
      : [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];

  const exact = wanted
    ? withPoster.find((v) => v.versionNumber === wanted.versionNumber)
    : undefined;
  const chosen = exact ?? withPoster[0];

  return {
    key: chosen.posterAssetUrl!,
    versionNumber: chosen.versionNumber,
    representsShotStatus: Boolean(exact),
  };
}

// ---------------------------------------------------------------------------
// Landing page. Every number on the marketing surface is read from the same
// agent_decision_log the dashboard uses, so it cannot drift the way the
// previous hardcoded STATS array did (it still claimed $13.23 / 55 calls long
// after real spend had passed $29). Nothing here is rounded up or restated
// from a doc - if a figure is on the landing page, this query produced it.

// The one aggregate that is a genuine product argument rather than a vanity
// metric: generation is almost the entire bill, and everything that plans,
// watches, critiques, revises and approves is a rounding error next to it.
const SUPERVISION_AGENTS = [
  "planner",
  "critic",
  "revision_agent",
  "approval_gate",
] as const;

export type LandingStats = {
  totalCalls: number;
  totalSpendUsd: number;
  veoGenerations: number;
  runCount: number;
  generationSpendUsd: number;
  supervisionSpendUsd: number;
  supervisionSharePct: number;
  byAgent: { agentName: string; calls: number; spendUsd: number }[];
};

export async function getLandingStats(): Promise<LandingStats> {
  const client = getClickHouseClient();
  const [totalsResult, byAgentResult] = await Promise.all([
    client.query({
      query: `
        SELECT count() AS calls,
               sum(cost_usd) AS spend,
               uniqExact(run_id) AS runs,
               countIf(agent_name = 'generation_adapter') AS generations
        FROM dailies.agent_decision_log
      `,
      format: "JSONEachRow",
    }),
    client.query({
      query: `
        SELECT agent_name, count() AS calls, sum(cost_usd) AS spend
        FROM dailies.agent_decision_log
        GROUP BY agent_name
        ORDER BY spend DESC
      `,
      format: "JSONEachRow",
    }),
  ]);

  const [totals] = await totalsResult.json<{
    calls: string;
    spend: string;
    runs: string;
    generations: string;
  }>();
  const byAgentRows = await byAgentResult.json<{
    agent_name: string;
    calls: string;
    spend: string;
  }>();

  const byAgent = byAgentRows.map((row) => ({
    agentName: row.agent_name,
    calls: Number(row.calls),
    spendUsd: Number(row.spend),
  }));

  const totalSpendUsd = Number(totals?.spend ?? 0);
  const generationSpendUsd = byAgent
    .filter((row) => row.agentName === "generation_adapter")
    .reduce((sum, row) => sum + row.spendUsd, 0);
  const supervisionSpendUsd = byAgent
    .filter((row) =>
      (SUPERVISION_AGENTS as readonly string[]).includes(row.agentName),
    )
    .reduce((sum, row) => sum + row.spendUsd, 0);

  return {
    totalCalls: Number(totals?.calls ?? 0),
    totalSpendUsd,
    veoGenerations: Number(totals?.generations ?? 0),
    runCount: Number(totals?.runs ?? 0),
    generationSpendUsd,
    supervisionSpendUsd,
    supervisionSharePct:
      totalSpendUsd > 0 ? (supervisionSpendUsd / totalSpendUsd) * 100 : 0,
    byAgent,
  };
}

// ---------------------------------------------------------------------------
// What a run could be started on.

export type RunnableShot = {
  shotId: string;
  shotCode: string;
  status: string;
  showId: string;
  showName: string;
  sequenceCode: string;
  versionCount: number;
};

// A run plans against the shot's brief, so a shot without one cannot be started
// - `run_session.py` errors out and the dashboard's Start run button is disabled.
// Listing only shots that are actually runnable means the session log can offer
// a real starting point instead of a button that leads to a dead end.
export async function getRunnableShots(): Promise<RunnableShot[]> {
  const rows = await db
    .select({
      shotId: shots.id,
      shotCode: shots.code,
      status: shots.status,
      showId: shows.id,
      showName: shows.name,
      sequenceCode: sequences.code,
    })
    .from(shots)
    .innerJoin(sequences, eq(shots.sequenceId, sequences.id))
    .innerJoin(shows, eq(sequences.showId, shows.id))
    .where(and(isNotNull(shots.brief), ne(shots.brief, "")))
    .orderBy(asc(shows.name), asc(sequences.code), asc(shots.orderIndex));

  if (rows.length === 0) return [];

  const counts = await db
    .select({ shotId: shotVersions.shotId, n: count() })
    .from(shotVersions)
    .where(
      inArray(
        shotVersions.shotId,
        rows.map((r) => r.shotId),
      ),
    )
    .groupBy(shotVersions.shotId);
  const countByShot = new Map(counts.map((c) => [c.shotId, c.n]));

  return rows.map((row) => ({ ...row, versionCount: countByShot.get(row.shotId) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Export surface: what is actually shippable right now, across every show.

export type ExportableShot = {
  shotId: string;
  shotCode: string;
  status: string;
  approvedVersionNumber: number | null;
  hasStoredFootage: boolean;
};

export type ExportableSequence = {
  showId: string;
  showName: string;
  sequenceId: string;
  sequenceCode: string;
  shots: ExportableShot[];
  approvedCount: number;
  wholeSequenceApproved: boolean;
};

// Deliberately returns every sequence, not just the ones with something to
// ship. An operator opening Export needs to see why nothing is exportable at
// least as much as they need a download button - an empty page that just says
// "nothing here" hides the gate rather than explaining it.
export async function getExportableWork(): Promise<ExportableSequence[]> {
  const rows = await db
    .select({
      showId: shows.id,
      showName: shows.name,
      sequenceId: sequences.id,
      sequenceCode: sequences.code,
      shotId: shots.id,
      shotCode: shots.code,
      shotStatus: shots.status,
      orderIndex: shots.orderIndex,
    })
    .from(sequences)
    .innerJoin(shows, eq(sequences.showId, shows.id))
    .leftJoin(shots, eq(shots.sequenceId, sequences.id))
    .orderBy(asc(shows.name), asc(sequences.code), asc(shots.orderIndex));

  const bySequence = new Map<string, ExportableSequence>();
  const approvedShotIds: string[] = [];

  for (const row of rows) {
    let entry = bySequence.get(row.sequenceId);
    if (!entry) {
      entry = {
        showId: row.showId,
        showName: row.showName,
        sequenceId: row.sequenceId,
        sequenceCode: row.sequenceCode,
        shots: [],
        approvedCount: 0,
        wholeSequenceApproved: false,
      };
      bySequence.set(row.sequenceId, entry);
    }
    if (!row.shotId || !row.shotCode || !row.shotStatus) continue;
    entry.shots.push({
      shotId: row.shotId,
      shotCode: row.shotCode,
      status: row.shotStatus,
      approvedVersionNumber: null,
      hasStoredFootage: false,
    });
    if (row.shotStatus === "approved") approvedShotIds.push(row.shotId);
  }

  // Resolve the approved version per approved shot, and whether it has bytes -
  // an approved shot whose footage was never uploaded exports a package with an
  // empty gen/ folder, and the UI has to be able to warn about that up front.
  if (approvedShotIds.length > 0) {
    const versions = await db
      .select({
        shotId: shotVersions.shotId,
        versionNumber: shotVersions.versionNumber,
        posterAssetUrl: shotVersions.posterAssetUrl,
        videoAssetUrl: shotVersions.videoAssetUrl,
      })
      .from(shotVersions)
      .where(
        and(
          inArray(shotVersions.shotId, approvedShotIds),
          eq(shotVersions.status, "approved"),
        ),
      )
      .orderBy(desc(shotVersions.versionNumber));

    const byShot = new Map<string, (typeof versions)[number]>();
    for (const version of versions) {
      if (!byShot.has(version.shotId)) byShot.set(version.shotId, version);
    }
    for (const entry of bySequence.values()) {
      for (const shot of entry.shots) {
        const version = byShot.get(shot.shotId);
        if (!version) continue;
        shot.approvedVersionNumber = version.versionNumber;
        shot.hasStoredFootage = Boolean(version.videoAssetUrl);
      }
    }
  }

  for (const entry of bySequence.values()) {
    entry.approvedCount = entry.shots.filter((s) => s.status === "approved").length;
    entry.wholeSequenceApproved =
      entry.shots.length > 0 && entry.approvedCount === entry.shots.length;
  }

  return [...bySequence.values()];
}

// ---------------------------------------------------------------------------
// Cost and latency. Same source as the landing page's figures, at the grain an
// operator needs to answer "where did the money go" and "what is slow".

export type AgentCost = {
  agentName: string;
  calls: number;
  spendUsd: number;
  tokensIn: number;
  tokensOut: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export type ModelCost = {
  model: string;
  calls: number;
  spendUsd: number;
  avgMs: number;
};

export type CostBreakdown = {
  summary: {
    totalCalls: number;
    totalSpendUsd: number;
    runs: number;
    generations: number;
    tokensIn: number;
    tokensOut: number;
    firstAt: string | null;
    lastAt: string | null;
  };
  byAgent: AgentCost[];
  byModel: ModelCost[];
};

export async function getCostBreakdown(): Promise<CostBreakdown> {
  const client = getClickHouseClient();
  const [summaryResult, agentResult, modelResult] = await Promise.all([
    client.query({
      query: `
        SELECT count() AS calls, sum(cost_usd) AS spend, uniqExact(run_id) AS runs,
               countIf(agent_name = 'generation_adapter') AS generations,
               sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out,
               toString(min(created_at)) AS first_at, toString(max(created_at)) AS last_at
        FROM dailies.agent_decision_log
      `,
      format: "JSONEachRow",
    }),
    client.query({
      query: `
        SELECT agent_name, count() AS calls, sum(cost_usd) AS spend,
               sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out,
               round(quantile(0.5)(latency_ms)) AS p50,
               round(quantile(0.95)(latency_ms)) AS p95,
               max(latency_ms) AS max_ms
        FROM dailies.agent_decision_log
        GROUP BY agent_name
        ORDER BY spend DESC, calls DESC
      `,
      format: "JSONEachRow",
    }),
    client.query({
      query: `
        SELECT model, count() AS calls, sum(cost_usd) AS spend,
               round(avg(latency_ms)) AS avg_ms
        FROM dailies.agent_decision_log
        GROUP BY model
        ORDER BY spend DESC, calls DESC
      `,
      format: "JSONEachRow",
    }),
  ]);

  const [summaryRow] = await summaryResult.json<Record<string, string>>();
  const agentRows = await agentResult.json<Record<string, string>>();
  const modelRows = await modelResult.json<Record<string, string>>();

  return {
    summary: {
      totalCalls: Number(summaryRow?.calls ?? 0),
      totalSpendUsd: Number(summaryRow?.spend ?? 0),
      runs: Number(summaryRow?.runs ?? 0),
      generations: Number(summaryRow?.generations ?? 0),
      tokensIn: Number(summaryRow?.tokens_in ?? 0),
      tokensOut: Number(summaryRow?.tokens_out ?? 0),
      firstAt: summaryRow?.first_at ?? null,
      lastAt: summaryRow?.last_at ?? null,
    },
    byAgent: agentRows.map((row) => ({
      agentName: row.agent_name,
      calls: Number(row.calls),
      spendUsd: Number(row.spend),
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      p50Ms: Number(row.p50),
      p95Ms: Number(row.p95),
      maxMs: Number(row.max_ms),
    })),
    byModel: modelRows.map((row) => ({
      model: row.model,
      calls: Number(row.calls),
      spendUsd: Number(row.spend),
      avgMs: Number(row.avg_ms),
    })),
  };
}

// Spend already logged against a shot, for the cost-consent panel: an operator
// about to authorise another billed run should see what this shot has cost so
// far, not just confirm a blank estimate.
//
// Attributed by the shot code embedded in input_ref, which is the only shot
// anchor the decision log carries - it has no show column. Shot codes are unique
// per sequence, not globally (SH010 exists in two shows today), so this is
// "spend logged against this code" rather than a per-row-exact figure. Stated
// that way in the UI rather than implied to be exact.
export async function getShotSpend(shotCode: string) {
  const client = getClickHouseClient();
  const [result, codeUses] = await Promise.all([
    client.query({
      query: `
        SELECT count() AS calls, sum(cost_usd) AS spend,
               countIf(agent_name = 'generation_adapter') AS generations
        FROM dailies.agent_decision_log
        WHERE extract(input_ref, 'SH[0-9]+') = {code:String}
      `,
      query_params: { code: shotCode },
      format: "JSONEachRow",
    }),
    // Surfaced rather than hidden: if the code is reused across shows, the
    // figure above spans all of them and the caller must say so.
    db.select({ n: count() }).from(shots).where(eq(shots.code, shotCode)),
  ]);
  const [row] = await result.json<{ calls: string; spend: string; generations: string }>();
  return {
    calls: Number(row?.calls ?? 0),
    spendUsd: Number(row?.spend ?? 0),
    generations: Number(row?.generations ?? 0),
    codeIsAmbiguous: (codeUses[0]?.n ?? 0) > 1,
  };
}

export type LandingFinding = QcFinding & {
  shotCode: string;
  version: number;
};

// The critic's own words, quoted on the landing page straight from the rows it
// wrote. Deliberately not filtered down to failures: a shot carrying pass,
// warning and fail together is the actual argument (a real review with nuance,
// not a binary filter), so the page needs the passes as much as the fails.
export async function getLandingFindings(): Promise<LandingFinding[]> {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT shot_id, version, category, verdict,
             frame_range_start, frame_range_end, description, severity
      FROM dailies.qc_findings
      ORDER BY shot_id ASC, version ASC, created_at ASC
    `,
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    shot_id: string;
    version: number;
    category: string;
    verdict: "pass" | "fail" | "warning";
    frame_range_start: number | null;
    frame_range_end: number | null;
    description: string;
    severity: "info" | "warning" | "critical";
  }>();
  if (rows.length === 0) return [];

  // shot_id is a Postgres uuid carried into ClickHouse; the readable code only
  // exists relationally, so resolve it rather than printing a uuid at a buyer.
  const shotIds = [...new Set(rows.map((row) => row.shot_id))];
  const shotRows = await db
    .select({ id: shots.id, code: shots.code })
    .from(shots)
    .where(inArray(shots.id, shotIds));
  const codeById = new Map(shotRows.map((row) => [row.id, row.code]));

  return rows.flatMap((row) => {
    const shotCode = codeById.get(row.shot_id);
    // A finding whose shot no longer exists has no honest label, so it is
    // dropped rather than shown against a placeholder code.
    if (!shotCode) return [];
    return [{
      shotCode,
      version: row.version,
      category: row.category,
      verdict: row.verdict,
      frameRangeStart: row.frame_range_start,
      frameRangeEnd: row.frame_range_end,
      description: row.description,
      severity: row.severity,
    }];
  });
}

// Best-effort deep link for a shot code, for the one place outside the
// hierarchy itself that needs to link straight to a shot: the landing
// page's real-footage callout. Shot codes are only unique within a
// sequence now that multiple shows are real - this returns the first
// match, which is fine for a marketing link, not for anything that needs
// to be unambiguous (use getShotDetail with full context for that).
export async function getShotDeepLink(shotCode: string) {
  const [row] = await db
    .select({ showId: sequences.showId, sequenceCode: sequences.code })
    .from(shots)
    .innerJoin(sequences, eq(shots.sequenceId, sequences.id))
    .where(eq(shots.code, shotCode))
    .limit(1);
  if (!row) return null;
  return `/dashboard/${row.showId}/${row.sequenceCode}/${shotCode}`;
}
