import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  approvalEvents,
  sequences,
  shotVersions,
  shots,
  shows,
} from "@/db/schema";

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

  return { show, sequence, shots: shotsWithVersions };
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

  return {
    shot,
    sequence,
    versions: versions.map((version) => ({
      ...version,
      events: eventsByVersion.get(version.id) ?? [],
    })),
  };
}
