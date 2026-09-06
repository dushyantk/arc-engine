import { z } from "zod";

// Typed contracts crossing the Next.js <-> FastAPI boundary. Mirrored by hand
// in server/models/contracts.py — see ARCHITECTURE.md section 5 for why these
// are two hand-written definitions rather than one generated source.

export const shotStatusSchema = z.enum([
  "pending",
  "generating",
  "reviewing",
  "revise",
  "approved",
  "needs_human",
]);
export type ShotStatus = z.infer<typeof shotStatusSchema>;

/** not_applicable is a real verdict, not a missing one: an axis that cannot be
 *  observed in this shot must be declinable, or a framing choice becomes a
 *  phantom defect. Mirrored in server/models/contracts.py. */
export const qcVerdictSchema = z.enum(["pass", "fail", "warning", "not_applicable"]);
export type QCVerdict = z.infer<typeof qcVerdictSchema>;

export const qcSeveritySchema = z.enum(["info", "warning", "critical"]);

/** Mirrors the reference_asset_type pgEnum in db/schema.ts. */
export const referenceAssetTypeSchema = z.enum([
  "character",
  "prop",
  "environment",
  "palette",
]);
export type ReferenceAssetType = z.infer<typeof referenceAssetTypeSchema>;
export type QCSeverity = z.infer<typeof qcSeveritySchema>;

/** Veo 3.1 call parameters. An explicit shape, not a loose record — Gemini's
 *  Developer API structured-output mode rejects open-ended objects outright,
 *  and an explicit shape is the right call anyway. */
export const generationSettingsSchema = z.object({
  model: z.string(),
  seed: z.number().int().optional(),
  imageRefs: z.array(z.string()).default([]),
});
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

/** Planner output: what a shot needs to preserve and how to generate it. */
export const shotBriefSchema = z.object({
  shotCode: z.string(),
  invariants: z.array(z.string()),
  referenceAssetIds: z.array(z.string().uuid()),
  prompt: z.string(),
  generationSettings: generationSettingsSchema,
});
export type ShotBrief = z.infer<typeof shotBriefSchema>;

/** One continuity axis check on a shot version. */
export const qcFindingSchema = z.object({
  category: z.string(),
  verdict: qcVerdictSchema,
  frameRangeStart: z.number().int().nonnegative().optional(),
  frameRangeEnd: z.number().int().nonnegative().optional(),
  description: z.string(),
  severity: qcSeveritySchema,
});
export type QCFinding = z.infer<typeof qcFindingSchema>;

/** Extracted continuity state for one shot/version. Mirrors the ClickHouse
 *  continuity_fingerprints row exactly (see server/clickhouse/schema.sql). */
export const continuityFingerprintSchema = z.object({
  show: z.string(),
  sequence: z.string(),
  shot: z.string(),
  version: z.number().int().positive(),
  characterIdentity: z.string(),
  costume: z.string(),
  props: z.string(),
  environment: z.string(),
  timeOfDay: z.string(),
  lightingDirection: z.string(),
  camera: z.string(),
  lensLanguage: z.string(),
  screenDirection: z.string(),
  palette: z.array(z.string()),
  approvedReferenceFrames: z.array(z.string()),
  generationPrompt: z.string(),
  generationSettings: generationSettingsSchema,
  qcFindings: z.array(qcFindingSchema),
  supervisorNotes: z.string(),
  revisionReason: z.string().optional(),
  approvalStatus: shotStatusSchema,
  extractedAt: z.string().datetime(),
});
export type ContinuityFingerprint = z.infer<typeof continuityFingerprintSchema>;

/** Critic's FAILed findings turned into concrete regeneration instructions. */
export const revisionInstructionSchema = z.object({
  shotCode: z.string(),
  targetVersion: z.number().int().positive(),
  lockedReferenceAssetIds: z.array(z.string().uuid()),
  removeElements: z.array(z.string()),
  preserveElements: z.array(z.string()),
  revisedPrompt: z.string(),
  reason: z.string(),
});
export type RevisionInstruction = z.infer<typeof revisionInstructionSchema>;

/** Story agent output: an idea prompt expanded into something a breakdown can
 *  be made from. Deliberately small — a logline to check the premise against, a
 *  synopsis to read, and scenes carrying the action a shot list comes from. */
export const scriptSceneSchema = z.object({
  heading: z.string(),
  action: z.string(),
  beats: z.array(z.string()).default([]),
});
export type ScriptScene = z.infer<typeof scriptSceneSchema>;

export const scriptDraftSchema = z.object({
  logline: z.string(),
  synopsis: z.string(),
  scenes: z.array(scriptSceneSchema).min(1),
});
export type ScriptDraft = z.infer<typeof scriptDraftSchema>;

/** Breakdown agent output: an approved script turned into the sequences, shots
 *  and assets it implies. The shot `brief` here is the same field the existing
 *  planner already consumes — that is the seam the whole top-down chain bolts
 *  onto, so nothing downstream of a shot changes. */
export const breakdownShotSchema = z.object({
  code: z.string(),
  orderIndex: z.number().int().nonnegative(),
  screenDirection: z.string(),
  brief: z.string(),
});
export type BreakdownShot = z.infer<typeof breakdownShotSchema>;

export const breakdownSequenceSchema = z.object({
  code: z.string(),
  description: z.string(),
  shots: z.array(breakdownShotSchema).min(1),
});
export type BreakdownSequence = z.infer<typeof breakdownSequenceSchema>;

/** An asset the script needs a reference for. `whyNeeded` is not decoration —
 *  it is what a human reads when deciding whether to spend on a sheet for it. */
export const breakdownAssetSchema = z.object({
  type: referenceAssetTypeSchema,
  name: z.string(),
  description: z.string(),
  whyNeeded: z.string(),
});
export type BreakdownAsset = z.infer<typeof breakdownAssetSchema>;

export const sceneBreakdownSchema = z.object({
  sequences: z.array(breakdownSequenceSchema).min(1),
  assets: z.array(breakdownAssetSchema).default([]),
});
export type SceneBreakdown = z.infer<typeof sceneBreakdownSchema>;

/** Asset-sheet agent input: one reference sheet to generate. `views` is what
 *  makes it a *sheet* rather than a picture — a character the generator must
 *  hold to needs to be seen from more than one side. */
export const assetSheetSpecSchema = z.object({
  assetType: referenceAssetTypeSchema,
  name: z.string(),
  prompt: z.string(),
  views: z.array(z.string()).min(1),
});
export type AssetSheetSpec = z.infer<typeof assetSheetSpecSchema>;
