import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
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
  // Which breakdown proposed this shot, when one did. Null for shots created by
  // hand, which stays the supported path - a shot's existence gets the same
  // provenance its footage already has. set null, not cascade: deleting the
  // proposal must not delete real work that came out of it.
  createdFromBreakdownId: uuid("created_from_breakdown_id").references(
    (): AnyPgColumn => breakdowns.id,
    { onDelete: "set null" },
  ),
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

export const referenceAssetSource = pgEnum("reference_asset_source", [
  "uploaded",
  "generated",
]);

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
  // Where the image came from. Defaults to 'uploaded' so the existing rows,
  // which were all uploaded by hand, are classified correctly in place - and so
  // a caller that forgets cannot silently pass a generated image off as one a
  // human supplied.
  source: referenceAssetSource("source").notNull().default("uploaded"),
  // A generated sheet must be as traceable as generated footage: which breakdown
  // asked for it, and the exact prompt that produced it. Null for uploads, where
  // neither exists. set null on delete, like shots - binning a proposal must not
  // bin the reference somebody has since locked as canon.
  generatedFromBreakdownId: uuid("generated_from_breakdown_id").references(
    (): AnyPgColumn => breakdowns.id,
    { onDelete: "set null" },
  ),
  generationPrompt: text("generation_prompt"),
  generationModel: text("generation_model"),
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

export const breakdownStatus = pgEnum("breakdown_status", [
  "draft",
  "approved",
  "materialised",
  "superseded",
]);

// The breakdown kept as its own artifact, not only as its effects. Once it has
// been materialised the sequences and shots exist on their own and nothing
// downstream reads this row - but "why does this shot exist" needs an answer
// that outlives the run, and a proposal a human rejected has to stay readable
// next to the one they took.
export const breakdowns = pgTable("breakdowns", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  scriptId: uuid("script_id")
    .notNull()
    .references(() => scripts.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  // The agent's SceneBreakdown verbatim. Stored whole rather than shredded into
  // columns because it is a proposal, not state: it is read back for review and
  // for provenance, never queried across.
  payload: jsonb("payload").notNull(),
  status: breakdownStatus("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  materialisedAt: timestamp("materialised_at", { withTimezone: true }),
});

// What an approval is *about*. Shot versions were the only subject; scripts are
// not shots, which is why this table had to stop requiring one on every row.
//
// Widened rather than given a second table on purpose: one audit trail and one
// human-veto path is the product's own claim, and two tables would mean any
// "every decision on record" view has to stitch them together.
export const approvalSubject = pgEnum("approval_subject", [
  "shot_version",
  "script",
  "breakdown",
]);

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
    breakdownId: uuid("breakdown_id").references(() => breakdowns.id, { onDelete: "cascade" }),
    actor: approvalActor("actor").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Exactly the columns its subject requires, enforced by the database rather
    // than by every caller remembering. Extend this alongside the enum every
    // time a new kind of thing becomes approvable.
    check(
      "approval_events_subject_target",
      sql`(${table.subjectType} <> 'shot_version'
           OR (${table.shotId} IS NOT NULL AND ${table.shotVersionId} IS NOT NULL))
          AND (${table.subjectType} <> 'script' OR ${table.scriptId} IS NOT NULL)
          AND (${table.subjectType} <> 'breakdown' OR ${table.breakdownId} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Auth. Better Auth owns these four tables; the column names are its contract,
// not ours, so they stay camelCase-mapped exactly as it expects.
//
// This is single-operator by design (see CLAUDE.md): there is no public signup,
// no roles and no tenancy. The point is that a hosted instance cannot have its
// billed endpoints driven by anyone who finds the URL - not to build an account
// system nobody asked for.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()).notNull(),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()).notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  // Cascade matters here: deleting an operator must take their sessions with
  // it, or a deleted user keeps a cookie that passes the fast middleware check
  // and fails the real one - the exact disagreement that caused a redirect loop
  // in an earlier project. See app/dashboard/layout.tsx.
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  // Required by Better Auth 1.7's account model. Missing it does not fail at
  // startup - it fails when a credential is written or read, which is the worst
  // time to find out. Verified against ctx.tables.account rather than assumed.
  issuer: text("issuer").notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at").$defaultFn(() => new Date()),
});
