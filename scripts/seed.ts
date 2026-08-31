/**
 * Seeds the canonical demo fixture: the railway-station scene from
 * ARCHITECTURE.md / BUILD_PLAN.md — Maya, a red suitcase, three shots.
 *
 * Postgres gets full version history (every generation attempt). ClickHouse
 * gets continuity fingerprints + QC findings only for the versions that
 * matter to the demo narrative (the approved ones, and SH020's current
 * failing candidate) — not an exhaustive dossier for every superseded
 * attempt.
 *
 * Usage: pnpm db:seed
 */
import { db } from "../db/client";
import {
  shows,
  sequences,
  shots,
  shotVersions,
  referenceAssets,
  approvalEvents,
} from "../db/schema";
import type { ContinuityFingerprint, QCFinding } from "../lib/schemas";

const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST ?? "localhost";
const CLICKHOUSE_PORT = process.env.CLICKHOUSE_PORT ?? "8124";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER ?? "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? "dailies";

async function insertClickHouseRows(table: string, rows: object[]) {
  const url = new URL(`http://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}/`);
  url.searchParams.set("query", `INSERT INTO ${CLICKHOUSE_DATABASE}.${table} FORMAT JSONEachRow`);
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const auth = Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body,
  });
  if (!res.ok) {
    throw new Error(`ClickHouse insert into ${table} failed: ${res.status} ${await res.text()}`);
  }
}

const REF_BASE = "refs/platform-chase";
const GEN_BASE = "gen";

async function main() {
  // This inserts a fresh fixture; it does not reconcile with what is already
  // there. Run against the working database and you get a second "Platform
  // Chase" alongside the one carrying real generations and real spend.
  const existing = await db.select({ id: shows.id }).from(shows).limit(1);
  if (existing.length > 0 && !process.argv.includes("--force")) {
    console.error(
      "Refusing to seed: this database already has shows in it.\n" +
        "The fixture is additive, so seeding now would duplicate the hierarchy\n" +
        "alongside real runs. Use --force only against an empty or throwaway database.",
    );
    process.exit(1);
  }

  console.log("Seeding: Platform Chase (SQ010)");

  const [show] = await db.insert(shows).values({ name: "Platform Chase" }).returning();

  const [sequence] = await db
    .insert(sequences)
    .values({
      showId: show.id,
      code: "SQ010",
      description:
        "Maya runs through an abandoned railway station carrying a red suitcase. Something enormous moves behind the frosted glass ceiling.",
    })
    .returning();

  const [maya, suitcase, environment] = await db
    .insert(referenceAssets)
    .values([
      {
        showId: show.id,
        type: "character",
        name: "Maya",
        imageUrl: `${REF_BASE}/maya.png`,
        lockedAt: new Date(),
        approvedBy: "agent",
      },
      {
        showId: show.id,
        type: "prop",
        name: "Red leather suitcase",
        imageUrl: `${REF_BASE}/suitcase.png`,
        lockedAt: new Date(),
        approvedBy: "agent",
      },
      {
        showId: show.id,
        type: "environment",
        name: "Station Platform 2",
        imageUrl: `${REF_BASE}/environment.png`,
        lockedAt: new Date(),
        approvedBy: "agent",
      },
    ])
    .returning();

  const [sh010, sh020, sh030] = await db
    .insert(shots)
    .values([
      // Nothing here is seeded approved. An approval is a durable claim that a
      // real critique passed on real footage, and the fixture's video keys have
      // no bytes behind them - seeding one fabricates the exact state the
      // product exists to be trusted about, and now that shot status is
      // resolved from the approval record it would never clear on its own.
      { sequenceId: sequence.id, code: "SH010", orderIndex: 1, screenDirection: "L_TO_R", status: "pending" },
      { sequenceId: sequence.id, code: "SH020", orderIndex: 2, screenDirection: "L_TO_R", status: "revise" },
      { sequenceId: sequence.id, code: "SH030", orderIndex: 3, screenDirection: "L_TO_R", status: "pending" },
    ])
    .returning();

  // SH010 — one generation, never critiqued.
  await db.insert(shotVersions).values({
    shotId: sh010.id,
    versionNumber: 1,
    generationPrompt:
      "Maya runs across Platform 2 at night in the rain, carrying her red leather suitcase in her right hand. Key light camera-left. Wide shot, L to R.",
    generationSettings: { model: "veo-3.1", seed: 10201 },
    videoAssetUrl: `${GEN_BASE}/SH010/v001.mp4`,
    status: "candidate",
  });

  // SH020 — two generations so far, still failing. This is the shot the
  // live demo session picks up and carries to v003.
  const [sh020v1] = await db
    .insert(shotVersions)
    .values({
      shotId: sh020.id,
      versionNumber: 1,
      generationPrompt:
        "Maya stops on Platform 2, suitcase in right hand, as something moves behind the frosted glass ceiling above. Key light camera-left.",
      generationSettings: { model: "veo-3.1", seed: 10202 },
      videoAssetUrl: `${GEN_BASE}/SH020/v001.mp4`,
      status: "failed",
    })
    .returning();
  await db.insert(approvalEvents).values({
    subjectType: "shot_version",
    shotId: sh020.id,
    shotVersionId: sh020v1.id,
    actor: "agent",
    decision: "revise",
    reason: "Hero prop failed: suitcase changed red to brown. Station clock face changed time.",
  });

  const [sh020v2] = await db
    .insert(shotVersions)
    .values({
      shotId: sh020.id,
      versionNumber: 2,
      generationPrompt:
        "Maya stops on Platform 2, suitcase in right hand, as something moves behind the frosted glass ceiling above. Key light camera-left. Lock reference: approved red leather suitcase.",
      generationSettings: { model: "veo-3.1", seed: 10203, imageRefs: [suitcase.imageUrl] },
      videoAssetUrl: `${GEN_BASE}/SH020/v002.mp4`,
      status: "failed",
    })
    .returning();
  await db.insert(approvalEvents).values({
    subjectType: "shot_version",
    shotId: sh020.id,
    shotVersionId: sh020v2.id,
    actor: "agent",
    decision: "revise",
    reason: "Hero prop still fails: suitcase color drifted again. Clock numerals still legible and deforming.",
  });

  // SH030 — three generations, approved on the third.
  const [sh030v1] = await db
    .insert(shotVersions)
    .values({
      shotId: sh030.id,
      versionNumber: 1,
      generationPrompt: "Maya's suitcase vanishes as the creature's silhouette passes overhead. Key light camera-left.",
      generationSettings: { model: "veo-3.1", seed: 10301 },
      videoAssetUrl: `${GEN_BASE}/SH030/v001.mp4`,
      status: "failed",
    })
    .returning();
  await db.insert(approvalEvents).values({
    subjectType: "shot_version",
    shotId: sh030.id,
    shotVersionId: sh030v1.id,
    actor: "agent",
    decision: "revise",
    reason: "Hero prop missing: suitcase disappeared. Lighting direction reversed relative to SH020.",
  });

  const [sh030v2] = await db
    .insert(shotVersions)
    .values({
      shotId: sh030.id,
      versionNumber: 2,
      generationPrompt:
        "Maya's suitcase remains in right hand as the creature's silhouette passes overhead. Key light camera-left, matched to SH020.",
      generationSettings: { model: "veo-3.1", seed: 10302, imageRefs: [suitcase.imageUrl] },
      videoAssetUrl: `${GEN_BASE}/SH030/v002.mp4`,
      status: "failed",
    })
    .returning();
  await db.insert(approvalEvents).values({
    subjectType: "shot_version",
    shotId: sh030.id,
    shotVersionId: sh030v2.id,
    actor: "agent",
    decision: "revise",
    reason: "Creature geometry inconsistent with SH020. Maya's face drifts in the final frames.",
  });

  await db.insert(shotVersions).values({
    shotId: sh030.id,
    versionNumber: 3,
    generationPrompt:
      "Maya's suitcase remains in right hand as the creature's silhouette passes overhead. Key light camera-left, matched to SH020. Lock reference: Maya character sheet.",
    generationSettings: {
      model: "veo-3.1",
      seed: 10303,
      imageRefs: [suitcase.imageUrl, maya.imageUrl],
    },
    videoAssetUrl: `${GEN_BASE}/SH030/v003.mp4`,
    status: "candidate",
  });

  console.log("Postgres seeded: 1 show, 1 sequence, 3 shots, 3 references, 6 shot versions.");

  // --- ClickHouse: continuity fingerprints + QC findings for the shots
  // that matter to the demo narrative. ---

  const sh020v2Findings: QCFinding[] = [
    { category: "costume_continuity", verdict: "pass", description: "Costume matches locked reference.", severity: "info" },
    {
      category: "hero_prop",
      verdict: "fail",
      frameRangeStart: 82,
      frameRangeEnd: 104,
      description: "Suitcase changed red to brown.",
      severity: "critical",
    },
    { category: "screen_direction", verdict: "pass", description: "Maya travels L to R, matches SH010.", severity: "info" },
    {
      category: "temporal_stability",
      verdict: "warning",
      frameRangeStart: 82,
      frameRangeEnd: 104,
      description: "Clock numerals deform across frames.",
      severity: "warning",
    },
  ];

  await insertClickHouseRows(
    "qc_findings",
    sh020v2Findings.map((f) => ({
      shot_id: sh020.id,
      version: 2,
      category: f.category,
      verdict: f.verdict,
      frame_range_start: f.frameRangeStart ?? null,
      frame_range_end: f.frameRangeEnd ?? null,
      description: f.description,
      severity: f.severity,
    })),
  );

  const fingerprints: Array<{ shotDbId: string; row: ContinuityFingerprint }> = [
    {
      shotDbId: sh010.id,
      row: {
        show: "Platform Chase",
        sequence: "SQ010",
        shot: "SH010",
        version: 1,
        characterIdentity: "Maya: blue wool coat, wet shoulder-length hair, small cut above left eyebrow",
        costume: "Blue wool coat",
        props: "Red leather suitcase, carried right hand",
        environment: "Platform 2, nighttime, rain",
        timeOfDay: "night",
        lightingDirection: "key light camera-left",
        camera: "wide, static",
        lensLanguage: "35mm equivalent",
        screenDirection: "L_TO_R",
        palette: ["#0a0d12", "#8b1a1a", "#c7a86b"],
        approvedReferenceFrames: [maya.imageUrl, suitcase.imageUrl, environment.imageUrl],
        generationPrompt: "Maya runs across Platform 2 at night in the rain, carrying her red leather suitcase in her right hand. Key light camera-left. Wide shot, L to R.",
        generationSettings: { model: "veo-3.1", seed: 10201, imageRefs: [] },
        qcFindings: [],
        supervisorNotes: "Clean first generation. No revision needed.",
        approvalStatus: "approved",
        extractedAt: new Date().toISOString(),
      },
    },
    {
      shotDbId: sh020.id,
      row: {
        show: "Platform Chase",
        sequence: "SQ010",
        shot: "SH020",
        version: 2,
        characterIdentity: "Maya: blue wool coat, wet shoulder-length hair, small cut above left eyebrow",
        costume: "Blue wool coat",
        props: "Red leather suitcase (drifted to brown in this candidate), carried right hand",
        environment: "Platform 2, nighttime, rain, station clock visible in background",
        timeOfDay: "night",
        lightingDirection: "key light camera-left",
        camera: "medium, static",
        lensLanguage: "35mm equivalent",
        screenDirection: "L_TO_R",
        palette: ["#0a0d12", "#6b3a1a", "#c7a86b"],
        approvedReferenceFrames: [maya.imageUrl, suitcase.imageUrl, environment.imageUrl],
        generationPrompt: "Maya stops on Platform 2, suitcase in right hand, as something moves behind the frosted glass ceiling above. Key light camera-left. Lock reference: approved red leather suitcase.",
        generationSettings: { model: "veo-3.1", seed: 10203, imageRefs: [suitcase.imageUrl] },
        qcFindings: sh020v2Findings,
        supervisorNotes: "Hero prop and clock legibility still failing after one revision. Needs a third generation with a harder prop-color lock.",
        revisionReason: "Suitcase color drift, clock numerals legible and deforming.",
        approvalStatus: "revise",
        extractedAt: new Date().toISOString(),
      },
    },
    {
      shotDbId: sh030.id,
      row: {
        show: "Platform Chase",
        sequence: "SQ010",
        shot: "SH030",
        version: 3,
        characterIdentity: "Maya: blue wool coat, wet shoulder-length hair, small cut above left eyebrow",
        costume: "Blue wool coat",
        props: "Red leather suitcase, carried right hand",
        environment: "Platform 2, nighttime, rain, creature silhouette behind frosted glass",
        timeOfDay: "night",
        lightingDirection: "key light camera-left, matched to SH020",
        camera: "wide, static",
        lensLanguage: "35mm equivalent",
        screenDirection: "L_TO_R",
        palette: ["#0a0d12", "#8b1a1a", "#c7a86b"],
        approvedReferenceFrames: [maya.imageUrl, suitcase.imageUrl, environment.imageUrl],
        generationPrompt: "Maya's suitcase remains in right hand as the creature's silhouette passes overhead. Key light camera-left, matched to SH020. Lock reference: Maya character sheet.",
        generationSettings: {
          model: "veo-3.1",
          seed: 10303,
          imageRefs: [suitcase.imageUrl, maya.imageUrl],
        },
        qcFindings: [],
        supervisorNotes: "All continuity checks pass. Sequence agrees with itself end to end.",
        approvalStatus: "approved",
        extractedAt: new Date().toISOString(),
      },
    },
  ];

  await insertClickHouseRows(
    "continuity_fingerprints",
    fingerprints.map(({ row }) => ({
      show: row.show,
      sequence: row.sequence,
      shot: row.shot,
      version: row.version,
      character_identity: row.characterIdentity,
      costume: row.costume,
      props: row.props,
      environment: row.environment,
      time_of_day: row.timeOfDay,
      lighting_direction: row.lightingDirection,
      camera: row.camera,
      lens_language: row.lensLanguage,
      screen_direction: row.screenDirection,
      palette: row.palette,
      approved_reference_frames: row.approvedReferenceFrames,
      generation_prompt: row.generationPrompt,
      generation_settings: JSON.stringify(row.generationSettings),
      qc_findings: JSON.stringify(row.qcFindings),
      supervisor_notes: row.supervisorNotes,
      revision_reason: row.revisionReason ?? "",
      approval_status: row.approvalStatus,
    })),
  );

  console.log("ClickHouse seeded: 3 continuity fingerprints, 4 QC findings.");
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
