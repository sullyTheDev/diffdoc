export const MANIFEST_SCHEMA_VERSION = 2;
export const SUMMARY_ASSET_SCHEMA_VERSION = 1;

export interface RepoManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  lastSyncedCommit: string;
  files: Record<string, string>;
}

export interface SummaryAsset {
  schemaVersion: typeof SUMMARY_ASSET_SCHEMA_VERSION;
  content_hash: string;
  summary: string;
  raw_code_snapshot?: string;
}
