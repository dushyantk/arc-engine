import { and, asc, count, desc, eq } from "drizzle-orm";
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

  const eventsByVersion = new Map<string, typeof events>();
  for (const event of events) {
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
