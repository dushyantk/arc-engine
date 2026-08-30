import JSZip from "jszip";
import type { ExportPackage } from "@/lib/export";
import { generateNukeScript } from "@/lib/nuke-script";
import { getObjectBytes } from "@/lib/minio";

// RULE: every export route builds its tree through addShotFolder(). Do not
// assemble the folders inline. The per-shot and sequence-level downloads must
// produce byte-identical trees for the same shot - a package that differs
// depending on which button produced it is exactly the kind of untraceable
// difference this product exists to rule out.

/**
 * Writes one shot's complete VFX handoff tree into `zip` under `SHOTCODE/`,
 * and returns the folder name used.
 */
export async function addShotFolder(zip: JSZip, pkg: ExportPackage): Promise<string> {
  const shotCode = pkg.shot.code;
  const root = zip.folder(shotCode)!;
  root.folder("plate"); // no live-action plate ingested - see the .nk comment
  const gen = root.folder("gen")!;
  const refs = root.folder("refs")!;
  const metadata = root.folder("metadata")!;

  if (pkg.approvedVersion?.hasVideoBytes && pkg.approvedVersion.videoAssetUrl) {
    const versionLabel = String(pkg.approvedVersion.versionNumber).padStart(3, "0");
    const videoBytes = await getObjectBytes(pkg.approvedVersion.videoAssetUrl);
    gen.file(`${shotCode}_gen_v${versionLabel}.mov`, videoBytes);
  }

  for (const ref of pkg.referenceAssets) {
    if (!ref.hasImageBytes) continue;
    const bytes = await getObjectBytes(ref.imageUrl);
    const filename = ref.imageUrl.split("/").pop() ?? `${ref.name}.png`;
    refs.file(filename, bytes);
  }

  const manifest = {
    shot: pkg.shot.code,
    sequence: pkg.sequence.code,
    show: pkg.show.name,
    exportedAt: new Date().toISOString(),
    contents: {
      plate: "empty - no live-action plate ingested for this shot",
      gen: pkg.approvedVersion?.hasVideoBytes
        ? [`${shotCode}_gen_v${String(pkg.approvedVersion.versionNumber).padStart(3, "0")}.mov`]
        : [],
      refs: pkg.referenceAssets
        .filter((r) => r.hasImageBytes)
        .map((r) => r.imageUrl.split("/").pop()),
      metadata: ["manifest.json", "generation.json", "provenance.json", "qc.json", "notes.json"],
      nukeScript: `${shotCode}_comp.nk`,
    },
  };

  const generation = pkg.approvedVersion
    ? {
        version: pkg.approvedVersion.versionNumber,
        briefUsed: pkg.approvedVersion.briefUsed,
        prompt: pkg.approvedVersion.generationPrompt,
        settings: pkg.approvedVersion.generationSettings,
        hasStoredVideo: pkg.approvedVersion.hasVideoBytes,
        generatedAt: pkg.approvedVersion.createdAt,
      }
    : { note: "No approved version for this shot yet." };

  const provenance = {
    runId: pkg.provenance.runId,
    note: pkg.provenance.runId
      ? "Full agent_decision_log trail for the run that approved this version."
      : "No approval_gate run found for this version - provenance unavailable.",
    steps: pkg.provenance.events.map((e) => ({
      agent: e.agentName,
      step: e.step,
      model: e.model,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
      costUsd: e.costUsd,
      latencyMs: e.latencyMs,
      createdAt: e.createdAt,
    })),
  };

  const qc = {
    findings: pkg.qcFindings,
    note:
      pkg.qcFindings.length === 0
        ? "No structured per-finding QC data stored for this version - see notes.json for the critic's prose findings instead."
        : undefined,
  };

  const notes = { approvalEvents: pkg.approvalEvents };

  metadata.file("manifest.json", JSON.stringify(manifest, null, 2));
  metadata.file("generation.json", JSON.stringify(generation, null, 2));
  metadata.file("provenance.json", JSON.stringify(provenance, null, 2));
  metadata.file("qc.json", JSON.stringify(qc, null, 2));
  metadata.file("notes.json", JSON.stringify(notes, null, 2));

  root.file(`${shotCode}_comp.nk`, generateNukeScript(pkg));

  return shotCode;
}

/** Serialises a zip into a Response with the right download headers. */
export async function zipResponse(zip: JSZip, filename: string): Promise<Response> {
  const bytes = await zip.generateAsync({ type: "uint8array" });
  // Response's BodyInit type wants a plain ArrayBuffer, not the
  // ArrayBufferLike | SharedArrayBuffer union JSZip's Uint8Array carries -
  // copy into a fresh one rather than fighting the type with a cast.
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);

  return new Response(arrayBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
