import { sql } from "drizzle-orm";
import {
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

export const approvalEvents = pgTable("approval_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  shotId: uuid("shot_id")
    .notNull()
    .references(() => shots.id, { onDelete: "cascade" }),
  shotVersionId: uuid("shot_version_id")
    .notNull()
    .references(() => shotVersions.id, { onDelete: "cascade" }),
  actor: approvalActor("actor").notNull(),
  decision: text("decision").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
