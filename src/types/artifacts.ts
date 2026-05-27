export const MANIFEST_SCHEMA_VERSION = 2;
export const SUMMARY_ASSET_SCHEMA_VERSION = 2;

export interface RepoManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  lastSyncedCommit: string;
  files: Record<string, string>;
}

export interface SummaryMetadata {
  file_path: string;
  file_name: string;
  extension: string;
  line_count: number;
  byte_size: number;
  content_hash: string;
  generated_at: string;
  generator: {
    provider: string;
    model: string;
  };
  prompt_version: number;
  summary_format: string;
  custom_prompt_hash?: string;
  custom_prompt_source?: string;
}

export interface SummaryAsset {
  schemaVersion: number;
  content_hash: string;
  metadata?: SummaryMetadata;
  summary: string;
  raw_code_snapshot?: string;
}
