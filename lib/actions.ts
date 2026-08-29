"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { approvalEvents, sequences, shotVersions, shots, shows } from "@/db/schema";
import { callRuntime } from "@/lib/runtime";
import { resolveShotStatus } from "@/lib/data";

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
