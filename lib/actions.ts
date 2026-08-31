"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import {
  approvalEvents,
  referenceAssets,
  scripts,
  sequences,
  shotVersions,
  shots,
  shows,
} from "@/db/schema";
import { callRuntime } from "@/lib/runtime";
import { resolveShotStatus } from "@/lib/data";
import { getMinioClient, MINIO_BUCKET } from "@/lib/minio";

// Creation is scoped to the parent context, strictly: a show is created
// only from the shows-list root, a sequence only from inside a show page,
// a shot only from inside a sequence page. There is no create form at the
// version level - a version is only ever produced by a run (see the
// run-control build-plan item), never inserted directly.

const createShowSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
});

export async function createShow(formData: FormData) {
  const parsed = createShowSchema.parse({ name: formData.get("name") });
  const [show] = await db.insert(shows).values({ name: parsed.name }).returning();
  revalidatePath("/dashboard");
  redirect(`/dashboard/${show.id}`);
}

const createSequenceSchema = z.object({
  code: z.string().trim().min(1, "Code is required").max(50),
  description: z.string().trim().max(2000).optional(),
});

export async function createSequence(showId: string, formData: FormData) {
  const parsed = createSequenceSchema.parse({
    code: formData.get("code"),
    description: formData.get("description") || undefined,
  });
  const [sequence] = await db
    .insert(sequences)
    .values({
      showId,
      code: parsed.code,
      description: parsed.description ?? null,
    })
    .returning();
  revalidatePath(`/dashboard/${showId}`);
  redirect(`/dashboard/${showId}/${sequence.code}`);
}

const createShotSchema = z.object({
  code: z.string().trim().min(1, "Code is required").max(50),
  orderIndex: z.coerce.number().int().min(0),
  screenDirection: z.enum(["L_TO_R", "R_TO_L"]).optional(),
});

export async function createShot(
  showId: string,
  sequenceId: string,
  sequenceCode: string,
  formData: FormData,
) {
  const parsed = createShotSchema.parse({
    code: formData.get("code"),
    orderIndex: formData.get("orderIndex"),
    screenDirection: formData.get("screenDirection") || undefined,
  });
  await db.insert(shots).values({
    sequenceId,
    code: parsed.code,
    orderIndex: parsed.orderIndex,
    screenDirection: parsed.screenDirection ?? null,
  });
  revalidatePath(`/dashboard/${showId}/${sequenceCode}`);
  redirect(`/dashboard/${showId}/${sequenceCode}`);
}

// The scene goal a run plans against. Previously only ever existed as a
// CLI --goal argument - a real lineage hole in a product whose pitch is
// full lineage, since the human intent behind every generation was never
// in the system at all. server/run_session.py reads/writes this same
// column, so authoring from here or from --goal keep one source of truth.
const updateShotBriefSchema = z.object({
  brief: z.string().trim().max(4000),
});

export async function updateShotBrief(
  showId: string,
  sequenceCode: string,
  shotCode: string,
  shotId: string,
  formData: FormData,
) {
  const parsed = updateShotBriefSchema.parse({
    brief: formData.get("brief"),
  });
  await db
    .update(shots)
    .set({ brief: parsed.brief || null })
    .where(eq(shots.id, shotId));
  const path = `/dashboard/${showId}/${sequenceCode}/${shotCode}`;
  revalidatePath(path);
  redirect(path);
}

// Human approve/reject at version level - the "human-in-the-loop where
// production risk requires it" the architecture promises, and not just a
// needs_human resolution path: a human can veto an agent's own "approved"
// call too, which is exactly why this exists (see the critic
// non-determinism documented in generations/LEDGER.md - the same video
// has genuinely gotten different verdicts on independent passes). Writes
// a real approval_events row with actor='human' rather than silently
// mutating status with no record of who decided or why.
const humanApprovalSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().max(2000).optional(),
  })
  .refine((data) => data.decision === "approved" || !!data.reason, {
    message: "A reason is required when rejecting.",
    path: ["reason"],
  });

export async function submitHumanApproval(
  showId: string,
  sequenceCode: string,
  shotCode: string,
  shotId: string,
  shotVersionId: string,
  versionNumber: number,
  showName: string,
  formData: FormData,
) {
  const parsed = humanApprovalSchema.parse({
    decision: formData.get("decision"),
    reason: formData.get("reason") || undefined,
  });

  const versionStatus = parsed.decision === "approved" ? "approved" : "failed";

  await db
    .update(shotVersions)
    .set({ status: versionStatus })
    .where(eq(shotVersions.id, shotVersionId));

  // Read *after* the version write above, so a veto that just cleared this
  // version's approval is already reflected - that is how a human rejection
  // revokes an approval without a special case, while a later failed take
  // leaves an earlier approval standing. A veto with nothing else approved
  // lands on revise rather than needs_human: it was already reviewed by a
  // human, which is the point.
  const approvedElsewhere = await db
    .select({ id: shotVersions.id })
    .from(shotVersions)
    .where(and(eq(shotVersions.shotId, shotId), eq(shotVersions.status, "approved")))
    .limit(1);
  const shotStatus = resolveShotStatus("revise", {
    shotHasApprovedVersion: approvedElsewhere.length > 0,
  });

  await db.update(shots).set({ status: shotStatus }).where(eq(shots.id, shotId));
  await db.insert(approvalEvents).values({
    subjectType: "shot_version",
    shotId,
    shotVersionId,
    actor: "human",
    decision: parsed.decision,
    reason: parsed.reason ?? null,
  });

  // A human approval is a real approval, same as an agent one - it should
  // feed the same production memory (continuity_fingerprints) an agent
  // approval does. This is a pure Postgres write with no Gemini call of
  // its own to piggyback the extraction onto, so it calls out to the
  // agent runtime for it. Best-effort: a fingerprint-extraction hiccup
  // shouldn't block the approval decision itself from landing.
  if (parsed.decision === "approved") {
    try {
      await callRuntime("/runs/extract-fingerprint", {
        method: "POST",
        body: JSON.stringify({
          shot_code: shotCode,
          version_number: versionNumber,
          show_name: showName,
        }),
      });
    } catch {
      // Logged nowhere yet beyond this - real gap, not worth blocking the
      // approval write over. Same "best effort" as the rest of this
      // enrichment step.
    }
  }

  const path = `/dashboard/${showId}/${sequenceCode}/${shotCode}`;
  revalidatePath(path);
  redirect(path);
}

// ---------------------------------------------------------------------------
// Reference control.
//
// A locked reference is canon: get_reference_assets() in server/db/postgres.py
// selects `WHERE locked_at IS NOT NULL`, so the planner and the generation
// adapter only ever see locked ones. Unlocking is therefore a real operator
// verb with a real consequence - the agent stops conditioning on that image -
// and not a display flag. The UI has to say so, because an unlocked reference
// failing silently is exactly the kind of hidden state this product exists to
// argue against.
//
// Key layout mirrors _key() in server/reference_ingestion.py, the programmatic
// path: refs/{showId}/{slug}.{ext}. Upload locks immediately, matching that
// path's insert_reference_asset(), so the two cannot disagree about whether a
// freshly ingested reference is usable.

const REFERENCE_MAX_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const uploadReferenceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  type: z.enum(["character", "prop", "environment", "palette"]),
});

export async function uploadReferenceAsset(showId: string, formData: FormData) {
  const parsed = uploadReferenceSchema.parse({
    name: formData.get("name"),
    type: formData.get("type"),
  });

  const file = formData.get("image");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Choose an image to upload.");
  }
  const extension = EXTENSION_BY_TYPE[file.type];
  if (!extension) {
    throw new Error(
      `Unsupported image type ${file.type || "(unknown)"}. Use PNG, JPEG or WebP.`,
    );
  }
  if (file.size > REFERENCE_MAX_BYTES) {
    throw new Error(
      `Image is ${(file.size / 1024 / 1024).toFixed(1)}MB; the limit is ${REFERENCE_MAX_BYTES / 1024 / 1024}MB.`,
    );
  }

  const slug = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const key = `refs/${showId}/${slug}.${extension}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  await getMinioClient().putObject(MINIO_BUCKET, key, bytes, bytes.length, {
    "Content-Type": file.type,
  });

  await db.insert(referenceAssets).values({
    showId,
    type: parsed.type,
    name: parsed.name,
    imageUrl: key,
    lockedAt: new Date(),
    approvedBy: "operator",
  });

  revalidatePath(`/dashboard/${showId}`);
}

export async function setReferenceLock(
  showId: string,
  referenceId: string,
  formData: FormData,
) {
  const locked = formData.get("locked") === "true";
  await db
    .update(referenceAssets)
    .set({
      lockedAt: locked ? new Date() : null,
      approvedBy: locked ? "operator" : null,
    })
    .where(eq(referenceAssets.id, referenceId));
  revalidatePath(`/dashboard/${showId}`);
}

// ---------------------------------------------------------------------------
// Script control: the first stage of top-down planning.
//
// Writing a script is cheap and ungated - text only, cents - so a director can
// iterate on a premise freely. The gate is approval, because that is what
// everything expensive is planned from.

const draftScriptSchema = z.object({
  idea: z.string().trim().min(1, "Describe the idea to write from").max(4000),
});

export async function draftScript(showId: string, formData: FormData) {
  const parsed = draftScriptSchema.parse({ idea: formData.get("idea") });

  const { status, body } = await callRuntime("/scripts/draft", {
    method: "POST",
    body: JSON.stringify({ show_id: showId, idea: parsed.idea }),
  });

  if (status < 200 || status >= 300) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : "The agent runtime could not write a script.";
    throw new Error(detail);
  }

  revalidatePath(`/dashboard/${showId}/script`);
}

const scriptApprovalSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().max(2000).optional(),
  })
  .refine((data) => data.decision === "approved" || !!data.reason, {
    message: "A reason is required when rejecting.",
    path: ["reason"],
  });

export async function submitScriptApproval(
  showId: string,
  scriptId: string,
  formData: FormData,
) {
  const parsed = scriptApprovalSchema.parse({
    decision: formData.get("decision"),
    reason: formData.get("reason") || undefined,
  });

  if (parsed.decision === "approved") {
    // One approved script per show at a time: approving this one supersedes
    // whatever was approved before, rather than leaving two live scripts and
    // no way to say which a breakdown should be made from.
    await db
      .update(scripts)
      .set({ status: "superseded" })
      .where(and(eq(scripts.showId, showId), eq(scripts.status, "approved")));
    await db.update(scripts).set({ status: "approved" }).where(eq(scripts.id, scriptId));
  } else {
    // A rejected draft is out of the running, but kept - the reason is on the
    // record and the text stays readable.
    await db.update(scripts).set({ status: "superseded" }).where(eq(scripts.id, scriptId));
  }

  await db.insert(approvalEvents).values({
    subjectType: "script",
    scriptId,
    actor: "human",
    decision: parsed.decision,
    reason: parsed.reason ?? null,
  });

  revalidatePath(`/dashboard/${showId}/script`);
  redirect(`/dashboard/${showId}/script`);
}
