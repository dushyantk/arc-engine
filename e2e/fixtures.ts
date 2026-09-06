import "./env";

import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, like } from "drizzle-orm";
import postgres from "postgres";
import { test as base, type Page } from "@playwright/test";
import * as schema from "@/db/schema";
import { referenceAssets, sequences, shotVersions, shots, shows, user } from "@/db/schema";
import { getMinioClient, MINIO_BUCKET } from "@/lib/minio";
import { requireEnv } from "./env";

// ---------------------------------------------------------------------------
// Safety contract for this suite. The local stack holds real work — a real
// show, real generated footage, real spend and a real approval history — so
// every test here is built to be incapable of touching it:
//
//   1. Every fixture row this suite creates hangs off a show named with the
//      E2E_SHOW_PREFIX below. Nothing else is ever written.
//   2. Teardown deletes the fixture *show*; `shows` cascades to sequences,
//      shots, versions, approval_events and reference_assets, so one delete is
//      the whole tree. MinIO objects are removed by the `refs/{showId}/`
//      prefix, which is UUID-scoped and therefore cannot reach another show's
//      objects.
//   3. `blockCostedRoutes` aborts the three browser-reachable endpoints that
//      spend money, on every page in every test.
//   4. `enforceReadOnly` exists for specs that read pre-existing production
//      data: it aborts every non-GET request, so a stray click cannot submit a
//      server action even by accident.
//
// RULE: a spec that navigates to a show this suite did not create MUST call
// enforceReadOnly(). There is no version of "just reading, carefully".
// ---------------------------------------------------------------------------

export const E2E_SHOW_PREFIX = "E2E ";

/** The suite's own operator. Never the real one - a password in a test file is a
 *  password on disk, and this account is only valid against the local stack.
 *  Created by auth.setup.ts and removed in global teardown. */
export const E2E_OPERATOR_EMAIL = "e2e-operator@dailies.test";
export const E2E_OPERATOR_PASSWORD = "e2e-only-local-password";
export const STORAGE_STATE = "e2e/.auth/state.json";

/** Removes the suite's operator. Scoped to the one address above, so it cannot
 *  reach the real account. */
export async function destroyE2EOperator(): Promise<number> {
  const removed = await testDb
    .delete(user)
    .where(eq(user.email, E2E_OPERATOR_EMAIL))
    .returning({ id: user.id });
  return removed.length;
}

/** A dedicated connection, so the suite owns its own lifecycle and can close
 *  it in global teardown instead of leaking the app singleton's socket. */
const sql = postgres(requireEnv("DATABASE_URL"));
export const testDb = drizzle(sql, { schema });

export async function closeTestDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

/** Unique per test, prefixed so a crashed run leaves greppable rows behind. */
export function uniqueShowName(label: string): string {
  const slug = label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${E2E_SHOW_PREFIX}${slug || "fixture"} ${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Request guards.

/** Endpoints that start a Veo generation or a Gemini critique. Aborted, never
 *  called — this suite must not spend money, and a UI regression that fires one
 *  of these on mount should surface as a blocked request, not a bill. */
const COSTED_ENDPOINTS = [
  "**/api/runs/generate",
  "**/api/runs/recritique",
  "**/api/runs/reuse-prompt",
];

export async function blockCostedRoutes(page: Page): Promise<void> {
  for (const pattern of COSTED_ENDPOINTS) {
    await page.route(pattern, (route) => route.abort("blockedbyclient"));
  }
}

/** Hard read-only mode: only GET leaves the browser. Next.js server actions are
 *  POSTs to the page URL, so this makes a mutation structurally impossible
 *  rather than merely unintended. */
export async function enforceReadOnly(page: Page): Promise<void> {
  await page.route("**/*", (route) =>
    route.request().method() === "GET" ? route.fallback() : route.abort("blockedbyclient"),
  );
}

// ---------------------------------------------------------------------------
// Seeding.

export type SeededShow = { showId: string; showName: string };

export type SeededShot = SeededShow & {
  sequenceId: string;
  sequenceCode: string;
  shotId: string;
  shotCode: string;
  brief: string;
  /** Path to this shot's detail page. */
  shotPath: string;
};

export type SeededVersion = { versionId: string; versionNumber: number };

export async function seedShow(showName: string): Promise<SeededShow> {
  assertE2EName(showName);
  const [show] = await testDb.insert(shows).values({ name: showName }).returning();
  return { showId: show.id, showName: show.name };
}

export async function seedSequence(
  showId: string,
  code: string,
  description?: string,
): Promise<{ sequenceId: string; sequenceCode: string }> {
  const [sequence] = await testDb
    .insert(sequences)
    .values({ showId, code, description: description ?? null })
    .returning();
  return { sequenceId: sequence.id, sequenceCode: sequence.code };
}

export async function seedShot(
  sequenceId: string,
  code: string,
  options: {
    orderIndex?: number;
    status?: (typeof shots.$inferInsert)["status"];
    screenDirection?: string;
    brief?: string;
  } = {},
): Promise<{ shotId: string; shotCode: string }> {
  const [shot] = await testDb
    .insert(shots)
    .values({
      sequenceId,
      code,
      orderIndex: options.orderIndex ?? 1,
      status: options.status ?? "pending",
      screenDirection: options.screenDirection ?? null,
      brief: options.brief ?? null,
    })
    .returning();
  return { shotId: shot.id, shotCode: shot.code };
}

/**
 * A version can only be produced by a run, and runs cost money — there is
 * deliberately no create-version form to drive. So the fixture version is
 * inserted directly and the UI is driven from there.
 *
 * Two properties are load-bearing and deliberate, not laziness:
 *   - `videoAssetUrl` stays null, so lib/export.ts reports hasVideoBytes:false
 *     and the package is assembled without any stored footage.
 *   - `generationSettings` stays null, so if the FastAPI runtime happens to be
 *     up, submitHumanApproval's best-effort /runs/extract-fingerprint call is
 *     rejected 400 by that handler *before* it reaches Gemini. The suite cannot
 *     spend money whether the runtime is running or not.
 */
export async function seedVersion(
  shotId: string,
  options: {
    versionNumber?: number;
    generationPrompt?: string;
    briefUsed?: string;
    status?: (typeof shotVersions.$inferInsert)["status"];
  } = {},
): Promise<SeededVersion> {
  const [version] = await testDb
    .insert(shotVersions)
    .values({
      shotId,
      versionNumber: options.versionNumber ?? 1,
      generationPrompt:
        options.generationPrompt ??
        "Wide dolly along the platform edge, sodium practicals, 35mm anamorphic.",
      briefUsed: options.briefUsed ?? null,
      status: options.status ?? "candidate",
      videoAssetUrl: null,
      posterAssetUrl: null,
      generationSettings: null,
    })
    .returning();
  return { versionId: version.id, versionNumber: version.versionNumber };
}

// ---------------------------------------------------------------------------
// Teardown.

function assertE2EName(name: string): void {
  if (!name.startsWith(E2E_SHOW_PREFIX)) {
    throw new Error(
      `Refusing to operate on show "${name}": e2e fixtures must be named with the ` +
        `"${E2E_SHOW_PREFIX}" prefix so teardown can identify them.`,
    );
  }
}

/** Removes every MinIO object this suite could have written for a show.
 *  `refs/{showId}/` mirrors the key layout in lib/actions.ts and
 *  server/reference_ingestion.py, and is scoped by UUID — it cannot match
 *  another show's objects. */
async function removeShowObjects(showId: string): Promise<void> {
  const client = getMinioClient();
  const keys = await new Promise<string[]>((resolve, reject) => {
    const found: string[] = [];
    const stream = client.listObjectsV2(MINIO_BUCKET, `refs/${showId}/`, true);
    stream.on("data", (object) => {
      if (object.name) found.push(object.name);
    });
    stream.on("end", () => resolve(found));
    stream.on("error", reject);
  });
  if (keys.length > 0) {
    await client.removeObjects(MINIO_BUCKET, keys);
  }
}

/** Deletes one fixture show and everything under it. */
export async function destroyE2EShow(showId: string): Promise<void> {
  const [show] = await testDb
    .select({ name: shows.name })
    .from(shows)
    .where(eq(shows.id, showId))
    .limit(1);
  if (!show) return;
  assertE2EName(show.name);
  await removeShowObjects(showId);
  await testDb.delete(shows).where(eq(shows.id, showId));
}

/** Deletes every show carrying an exact fixture name. Used per-test, and safe
 *  whether the show was created through the UI or seeded directly. */
export async function destroyE2EShowsNamed(showName: string): Promise<void> {
  assertE2EName(showName);
  const rows = await testDb
    .select({ id: shows.id })
    .from(shows)
    .where(eq(shows.name, showName));
  for (const row of rows) {
    await destroyE2EShow(row.id);
  }
}

/** Global-teardown safety net for a crashed run. Only ever matches the fixture
 *  prefix — no other show can be reached from here. */
export async function destroyAllE2EShows(): Promise<number> {
  const rows = await testDb
    .select({ id: shows.id })
    .from(shows)
    .where(like(shows.name, `${E2E_SHOW_PREFIX}%`));
  for (const row of rows) {
    await destroyE2EShow(row.id);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Read helpers for assertions against real rows.

export async function readShot(shotId: string) {
  const [row] = await testDb.select().from(shots).where(eq(shots.id, shotId)).limit(1);
  return row ?? null;
}

export async function readVersion(versionId: string) {
  const [row] = await testDb
    .select()
    .from(shotVersions)
    .where(eq(shotVersions.id, versionId))
    .limit(1);
  return row ?? null;
}

export async function readApprovalEvents(shotId: string) {
  return testDb.select().from(schema.approvalEvents).where(eq(schema.approvalEvents.shotId, shotId));
}

export async function readShowReferences(showId: string) {
  return testDb.select().from(referenceAssets).where(eq(referenceAssets.showId, showId));
}

export async function minioObjectExists(key: string): Promise<boolean> {
  try {
    await getMinioClient().statObject(MINIO_BUCKET, key);
    return true;
  } catch {
    return false;
  }
}

/** The oldest show that is not an e2e fixture and has a sequence, a shot and at
 *  least one version — i.e. real production data to navigate read-only. Resolved
 *  from the database rather than hard-coded so the assertions compare the UI
 *  against actual rows instead of against a string literal. */
export async function findNavigableProductionShot() {
  const showRows = await testDb
    .select()
    .from(shows)
    .orderBy(shows.createdAt);

  for (const show of showRows) {
    if (show.name.startsWith(E2E_SHOW_PREFIX)) continue;
    const sequenceRows = await testDb
      .select()
      .from(sequences)
      .where(eq(sequences.showId, show.id));
    for (const sequence of sequenceRows) {
      const shotRows = await testDb
        .select()
        .from(shots)
        .where(eq(shots.sequenceId, sequence.id))
        .orderBy(shots.orderIndex);
      for (const shot of shotRows) {
        const versionRows = await testDb
          .select()
          .from(shotVersions)
          .where(eq(shotVersions.shotId, shot.id))
          .orderBy(shotVersions.versionNumber);
        if (versionRows.length > 0) {
          const referenceRows = await testDb
            .select()
            .from(referenceAssets)
            .where(eq(referenceAssets.showId, show.id));
          return {
            show,
            sequence,
            sequenceCount: sequenceRows.length,
            shot,
            shots: shotRows,
            versions: versionRows,
            references: referenceRows,
          };
        }
      }
    }
  }
  return null;
}

export async function countShotsInShow(showId: string): Promise<number> {
  const rows = await testDb
    .select({ id: shots.id })
    .from(shots)
    .innerJoin(sequences, eq(sequences.id, shots.sequenceId))
    .where(eq(sequences.showId, showId));
  return rows.length;
}

export async function findSequence(showId: string, code: string) {
  const [row] = await testDb
    .select()
    .from(sequences)
    .where(and(eq(sequences.showId, showId), eq(sequences.code, code)))
    .limit(1);
  return row ?? null;
}

export async function findShot(sequenceId: string, code: string) {
  const [row] = await testDb
    .select()
    .from(shots)
    .where(and(eq(shots.sequenceId, sequenceId), eq(shots.code, code)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Playwright fixtures.

type DailiesFixtures = {
  /** A unique `E2E …` show name, torn down after the test whether the show was
   *  created through the UI or seeded directly. */
  showName: string;
  /** A fixture show with nothing under it yet. */
  seededShow: SeededShow;
  /** A fixture show → sequence → shot, ready for the UI to drive. */
  seededShot: SeededShot;
};

export const test = base.extend<DailiesFixtures>({
  page: async ({ page }, use) => {
    await blockCostedRoutes(page);
    await use(page);
  },

  showName: async ({}, use, testInfo) => {
    const name = uniqueShowName(testInfo.title);
    await use(name);
    // Runs after every fixture that depends on it, so it is the single place
    // fixture data is destroyed.
    await destroyE2EShowsNamed(name);
  },

  seededShow: async ({ showName }, use) => {
    await use(await seedShow(showName));
  },

  seededShot: async ({ seededShow }, use) => {
    const brief = "Hero clears the turnstile and breaks left down the platform.";
    const { sequenceId, sequenceCode } = await seedSequence(
      seededShow.showId,
      "SQ010",
      "Fixture sequence for the e2e suite.",
    );
    const { shotId, shotCode } = await seedShot(sequenceId, "SH010", {
      orderIndex: 1,
      status: "needs_human",
      screenDirection: "L_TO_R",
      brief,
    });
    await use({
      ...seededShow,
      sequenceId,
      sequenceCode,
      shotId,
      shotCode,
      brief,
      shotPath: `/dashboard/${seededShow.showId}/${sequenceCode}/${shotCode}`,
    });
  },
});

export { expect } from "@playwright/test";
