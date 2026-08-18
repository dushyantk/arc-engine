import { asc, count, desc, eq } from "drizzle-orm";
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

export async function getRailStats(showId: string, sequenceShotCount: number) {
  const client = getClickHouseClient();
  const [referenceCount, sessionLogResult] = await Promise.all([
    db
      .select({ n: count() })
      .from(referenceAssets)
      .where(eq(referenceAssets.showId, showId)),
    client.query({
      query: "SELECT count() AS n FROM dailies.agent_decision_log",
      format: "JSONEachRow",
    }),
  ]);
  const sessionLogRows = await sessionLogResult.json<{ n: string }>();
  return {
    sequenceShotCount,
    referenceCount: referenceCount[0]?.n ?? 0,
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

export async function getSequenceOverview() {
  const [show] = await db.select().from(shows).limit(1);
  if (!show) return null;

  const [sequence] = await db
    .select()
    .from(sequences)
    .where(eq(sequences.showId, show.id))
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

  const rail = await getRailStats(show.id, shotRows.length);

  return { show, sequence, shots: shotsWithVersions, rail };
}

export async function getShotDetail(shotCode: string) {
  const [shot] = await db
    .select()
    .from(shots)
    .where(eq(shots.code, shotCode))
    .limit(1);
  if (!shot) return null;

  const [sequence] = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, shot.sequenceId))
    .limit(1);

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

  const [show] = sequence
    ? await db.select().from(shows).where(eq(shows.id, sequence.showId)).limit(1)
    : [];
  const rail = show
    ? await getRailStats(
        show.id,
        (await db.select().from(shots).where(eq(shots.sequenceId, sequence.id)))
          .length,
      )
    : null;

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
    rail,
    versions: versionsWithFindings,
  };
}
