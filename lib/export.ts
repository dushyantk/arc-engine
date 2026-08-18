import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { approvalEvents, referenceAssets, sequences, shotVersions, shots, shows } from "@/db/schema";
import { getMinioClient, MINIO_BUCKET } from "@/lib/minio";
import {
  getQcFindings,
  getVersionProvenance,
  type DecisionLogEvent,
  type QcFinding,
} from "@/lib/data";

export type ExportReferenceAsset = {
  type: string;
  name: string;
  imageUrl: string;
  hasImageBytes: boolean;
};

export type ExportApprovalEvent = {
  actor: string;
  decision: string;
  reason: string | null;
  createdAt: Date;
};

export type ExportPackage = {
  show: { name: string };
  sequence: { code: string; description: string | null };
  shot: { code: string; screenDirection: string | null; status: string };
  approvedVersion: {
    versionNumber: number;
    generationPrompt: string;
    generationSettings: unknown;
    videoAssetUrl: string | null;
    hasVideoBytes: boolean;
    createdAt: Date;
  } | null;
  referenceAssets: ExportReferenceAsset[];
  qcFindings: QcFinding[];
  approvalEvents: ExportApprovalEvent[];
  provenance: { runId: string | null; events: DecisionLogEvent[] };
};

async function objectExists(key: string): Promise<boolean> {
  try {
    await getMinioClient().statObject(MINIO_BUCKET, key);
    return true;
  } catch {
    return false;
  }
}

// Everything a VFX package needs, assembled from real rows only - a shot
// with no approved version, or an approved version with no stored video,
// produces a package that honestly says so rather than one that's missing
// files with no explanation.
export async function getExportPackage(shotCode: string): Promise<ExportPackage | null> {
  const [shot] = await db.select().from(shots).where(eq(shots.code, shotCode)).limit(1);
  if (!shot) return null;

  const [sequence] = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, shot.sequenceId))
    .limit(1);
  const [show] = sequence
    ? await db.select().from(shows).where(eq(shows.id, sequence.showId)).limit(1)
    : [];

  const [approvedVersionRow] = await db
    .select()
    .from(shotVersions)
    .where(and(eq(shotVersions.shotId, shot.id), eq(shotVersions.status, "approved")))
    .orderBy(desc(shotVersions.versionNumber))
    .limit(1);

  const approvedVersion = approvedVersionRow
    ? {
        versionNumber: approvedVersionRow.versionNumber,
        generationPrompt: approvedVersionRow.generationPrompt,
        generationSettings: approvedVersionRow.generationSettings,
        videoAssetUrl: approvedVersionRow.videoAssetUrl,
        hasVideoBytes: approvedVersionRow.videoAssetUrl
          ? await objectExists(approvedVersionRow.videoAssetUrl)
          : false,
        createdAt: approvedVersionRow.createdAt,
      }
    : null;

  const refRows = show
    ? await db.select().from(referenceAssets).where(eq(referenceAssets.showId, show.id))
    : [];
  const referenceAssetsWithStatus = await Promise.all(
    refRows.map(async (ref) => ({
      type: ref.type,
      name: ref.name,
      imageUrl: ref.imageUrl,
      hasImageBytes: await objectExists(ref.imageUrl),
    })),
  );

  const qcFindings = approvedVersion
    ? await getQcFindings(shot.id, approvedVersion.versionNumber)
    : [];

  const events = await db
    .select()
    .from(approvalEvents)
    .where(eq(approvalEvents.shotId, shot.id))
    .orderBy(desc(approvalEvents.createdAt));

  const provenance = approvedVersion
    ? await getVersionProvenance(shotCode, approvedVersion.versionNumber)
    : { runId: null, events: [] };

  return {
    show: { name: show?.name ?? "Unknown" },
    sequence: {
      code: sequence?.code ?? "Unknown",
      description: sequence?.description ?? null,
    },
    shot: { code: shot.code, screenDirection: shot.screenDirection, status: shot.status },
    approvedVersion,
    referenceAssets: referenceAssetsWithStatus,
    qcFindings,
    approvalEvents: events.map((e) => ({
      actor: e.actor,
      decision: e.decision,
      reason: e.reason,
      createdAt: e.createdAt,
    })),
    provenance,
  };
}
