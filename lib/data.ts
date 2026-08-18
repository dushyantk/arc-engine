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
