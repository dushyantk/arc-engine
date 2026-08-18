"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { sequences, shots, shows } from "@/db/schema";

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
