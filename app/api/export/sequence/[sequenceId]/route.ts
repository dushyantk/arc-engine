import JSZip from "jszip";
import { NextRequest } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { sequences, shots } from "@/db/schema";
import { getExportPackage } from "@/lib/export";
import { addShotFolder, zipResponse } from "@/lib/export-zip";

export const dynamic = "force-dynamic";

// Every approved shot in a sequence, in shot order, each as the same tree the
// per-shot download produces (addShotFolder is shared, so the two cannot drift).
//
// Gated on shots.status, matching playback and the per-shot export: a shot that
// merely has an approved version somewhere is not an approved shot.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sequenceId: string }> },
) {
  const { sequenceId } = await params;

  const [sequence] = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, sequenceId))
    .limit(1);
  if (!sequence) {
    return new Response("Sequence not found", { status: 404 });
  }

  const approvedShots = await db
    .select({ id: shots.id })
    .from(shots)
    .where(and(eq(shots.sequenceId, sequenceId), eq(shots.status, "approved")))
    .orderBy(asc(shots.orderIndex));

  if (approvedShots.length === 0) {
    // A 409 rather than an empty zip: handing back a valid-looking package with
    // nothing in it is how a downstream artist ends up compositing nothing.
    return new Response(
      `No approved shots in ${sequence.code}. A shot joins this bundle once it is approved.`,
      { status: 409 },
    );
  }

  const zip = new JSZip();
  const included: string[] = [];
  for (const shot of approvedShots) {
    const pkg = await getExportPackage(shot.id);
    if (!pkg) continue;
    included.push(await addShotFolder(zip, pkg));
  }

  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        sequence: sequence.code,
        description: sequence.description,
        exportedAt: new Date().toISOString(),
        shots: included,
        note: "One folder per approved shot, each identical to that shot's own export.",
      },
      null,
      2,
    ),
  );

  return zipResponse(zip, `${sequence.code}_export.zip`);
}
