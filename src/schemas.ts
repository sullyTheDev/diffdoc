import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema version constants
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_VERSION = 2;
export const SUMMARY_ASSET_SCHEMA_VERSION = 2;
export const SCHEMA_DIR_VERSION = 2;

export const SCHEMA_BASE_URL = `https://raw.githubusercontent.com/sullyTheDev/diffdoc/main/schemas/v${SCHEMA_DIR_VERSION}`;

// ---------------------------------------------------------------------------
// Configuration schema (.diffdocrc)
// ---------------------------------------------------------------------------

export const DiffdocConfigSchema = z.object({
  $schema: z.string().optional(),
  baseDir: z.string().optional(),
  repoPath: z.string().optional(),
  aiProvider: z.enum(["local", "cloud"]).optional(),
  localLlmEndpoint: z.string().optional(),
  localEmbedEndpoint: z.string().optional(),
  localChatModel: z.string().optional(),
  localEmbedModel: z.string().optional(),
  cloudLlmEndpoint: z.string().optional(),
  cloudChatModel: z.string().optional(),
  cloudEmbedModel: z.string().optional(),
  embedBatchSize: z.union([z.number().int().positive(), z.string()]).optional(),
  summarizeConcurrency: z.union([z.number().int().positive(), z.string()]).optional(),
  openaiApiKey: z.string().optional(),
  includeGlobs: z.union([z.array(z.string()), z.string()]).optional(),
  excludeGlobs: z.union([z.array(z.string()), z.string()]).optional(),
  ignoreFile: z.string().optional(),
  summaryPrompt: z.string().optional(),
  summaryPromptFile: z.string().optional()
}).strict();

export type DiffdocConfig = z.infer<typeof DiffdocConfigSchema>;

// ---------------------------------------------------------------------------
// Repository manifest schema
// ---------------------------------------------------------------------------

export const RepoManifestSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  lastSyncedCommit: z.string(),
  files: z.record(z.string(), z.string())
});

export type RepoManifest = z.infer<typeof RepoManifestSchema>;

// ---------------------------------------------------------------------------
// Summary metadata schema (nested within summary assets)
// ---------------------------------------------------------------------------

export const SummaryMetadataSchema = z.object({
  file_path: z.string(),
  file_name: z.string(),
  extension: z.string(),
  line_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
  content_hash: z.string(),
  generated_at: z.string(),
  generator: z.object({
    provider: z.string(),
    model: z.string()
  }),
  prompt_version: z.number().int(),
  summary_format: z.string(),
  custom_prompt_hash: z.string().optional(),
  custom_prompt_source: z.string().optional()
});

export type SummaryMetadata = z.infer<typeof SummaryMetadataSchema>;

// ---------------------------------------------------------------------------
// Summary asset schema (individual hash-named JSON files)
// ---------------------------------------------------------------------------

export const SummaryAssetSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(SUMMARY_ASSET_SCHEMA_VERSION),
  content_hash: z.string(),
  metadata: SummaryMetadataSchema.optional(),
  summary: z.string(),
  raw_code_snapshot: z.string().optional()
});

export type SummaryAsset = z.infer<typeof SummaryAssetSchema>;
