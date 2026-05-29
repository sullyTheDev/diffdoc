// Re-export all schema definitions and types from the canonical source.
// This file exists for backwards-compatible import paths.

export {
  MANIFEST_SCHEMA_VERSION,
  SUMMARY_ASSET_SCHEMA_VERSION,
  SCHEMA_DIR_VERSION,
  SCHEMA_BASE_URL,
  RepoManifestSchema,
  SummaryMetadataSchema,
  SummaryAssetSchema,
  DiffdocConfigSchema
} from "../schemas";

export type {
  RepoManifest,
  SummaryMetadata,
  SummaryAsset,
  DiffdocConfig
} from "../schemas";
