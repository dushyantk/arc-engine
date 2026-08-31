import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
} from "drizzle-orm/pg-core";

// Mirrors ARCHITECTURE.md section 4. Postgres holds the transactional state:
// a shot cannot be `approved` while its latest version is `failed`, and this
// is where that invariant lives. Production memory (continuity fingerprints,
// QC history, agent decisions) lives in ClickHouse — see server/clickhouse/.

export const shotStatus = pgEnum("shot_status", [
  "pending",
  "generating",
  "reviewing",
  "revise",
  "approved",
  "needs_human",
]);

export const shotVersionStatus = pgEnum("shot_version_status", [
  "candidate",
  "failed",
  "approved",
]);

export const referenceAssetType = pgEnum("reference_asset_type", [
  "character",
  "prop",
  "environment",
  "palette",
]);

export const approvalActor = pgEnum("approval_actor", ["agent", "human"]);

// A sequence is approved only when every shot in it is approved AND a final
// cross-shot continuity pass agrees they belong together (ARCHITECTURE.md
// section 1) - this is that verdict, not just a rollup of shot statuses.
export const sequenceStatus = pgEnum("sequence_status", [
  "pending",
  "approved",
  "needs_human",
]);

export const shows = pgTable("shows", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sequences = pgTable("sequences", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  showId: uuid("show_id")
    .notNull()
    .references(() => shows.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  description: text("description"),
  status: sequenceStatus("status").notNull().default("pending"),
  // The continuity agent's own written verdict - which axes it checked
  // across the approved shots and what it found, not just pass/fail.
  continuityNotes: text("continuity_notes"),
  continuityCheckedAt: timestamp("continuity_checked_at", { withTimezone: true }),
});

export const shots = pgTable("shots", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sequenceId: uuid("sequence_id")
    .notNull()
    .references(() => sequences.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  orderIndex: integer("order_index").notNull(),
  screenDirection: text("screen_direction"),
  status: shotStatus("status").notNull().default("pending"),
  // The human-authored scene goal a run plans against - previously only
  // ever existed as a CLI --goal argument, never persisted. See
  // docs/BUILD_PLAN.md "Operator control plane" audit item.
  brief: text("brief"),
});

export const shotVersions = pgTable("shot_versions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  shotId: uuid("shot_id")
    .notNull()
    .references(() => shots.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  generationPrompt: text("generation_prompt").notNull(),
  generationSettings: jsonb("generation_settings"),
  videoAssetUrl: text("video_asset_url"),
  // A real still pulled out of this version's own footage, so a shot card can
  // show what the take looks like without the browser downloading the video to
  // render a thumbnail. Stored rather than derived from videoAssetUrl by
  // convention: a version can have footage and no poster (anything generated
  // before posters existed, until the backfill runs), and that difference has
  // to be legible instead of a 404 behind a guessed key.
  posterAssetUrl: text("poster_asset_url"),
  status: shotVersionStatus("status").notNull().default("candidate"),
  // A stamp of shots.brief at the moment this version was generated - the
  // brief can be edited later, so this is what actually drove this
  // specific version, not what the shot's brief happens to read now.
  briefUsed: text("brief_used"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const referenceAssets = pgTable("reference_assets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  showId: uuid("show_id")
    .notNull()
    .references(() => shows.id, { onDelete: "cascade" }),
  type: referenceAssetType("type").notNull(),
  name: text("name").notNull(),
  imageUrl: text("image_url").notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
});

export const scriptStatus = pgEnum("script_status", ["draft", "approved", "superseded"]);

// The written work a show is planned from. Versioned like shot_versions: a
// second pass is a new row, never an edit, so the script a breakdown was made
// from stays readable after the script moves on.
export const scripts = pgTable("scripts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  showId: uuid("show_id")
    .notNull()
    .references(() => shows.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  // The operator's own words. Kept separate from the generated text so the
  // human intent behind a script is recoverable, the same way brief_used
  // stamps what actually drove a generation.
  sourcePrompt: text("source_prompt").notNull(),
  logline: text("logline").notNull(),
  synopsis: text("synopsis").notNull(),
  body: text("body").notNull(),
  status: scriptStatus("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// What an approval is *about*. Shot versions were the only subject; scripts are
// not shots, which is why this table had to stop requiring one on every row.
//
// Widened rather than given a second table on purpose: one audit trail and one
// human-veto path is the product's own claim, and two tables would mean any
// "every decision on record" view has to stitch them together.
export const approvalSubject = pgEnum("approval_subject", ["shot_version", "script"]);

export const approvalEvents = pgTable(
  "approval_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // The default exists so the existing rows could be classified in place; it
    // is not licence to omit it. A new subject type that forgets to set this
    // gets 'shot_version' with no shot attached, and the check below rejects
    // the row rather than filing it under the wrong thing.
    subjectType: approvalSubject("subject_type").notNull().default("shot_version"),
    // Nullable now, but still real foreign keys with real cascades - an
    // exclusive arc rather than an untyped (subject_type, subject_id) pair, so
    // deleting a shot still takes its approvals with it and nothing can point
    // at a row that does not exist.
    shotId: uuid("shot_id").references(() => shots.id, { onDelete: "cascade" }),
    shotVersionId: uuid("shot_version_id").references(() => shotVersions.id, {
      onDelete: "cascade",
    }),
    scriptId: uuid("script_id").references(() => scripts.id, { onDelete: "cascade" }),
    actor: approvalActor("actor").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Exactly the columns its subject requires, enforced by the database rather
    // than by every caller remembering. Extend this alongside the enum when
    // scripts and breakdowns become subjects.
    check(
      "approval_events_subject_target",
      sql`(${table.subjectType} <> 'shot_version'
           OR (${table.shotId} IS NOT NULL AND ${table.shotVersionId} IS NOT NULL))
          AND (${table.subjectType} <> 'script' OR ${table.scriptId} IS NOT NULL)`,
    ),
  ],
);
