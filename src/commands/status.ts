import fs from "node:fs/promises";
import path from "node:path";
import { LocalIndex } from "vectra";
import type { RuntimeConfig } from "../config";
import { type DiffdocVectorMetadata, getVectraIndexPath } from "./embed";
import { MANIFEST_SCHEMA_VERSION, type RepoManifest } from "../types/artifacts";
import { resolveDiffdocArtifactPath } from "../utils/paths";

export interface StatusOptions {
  manifest: string;
  json: boolean;
}

interface SummaryStats {
  summaryFileCount: number;
  orphanCount: number;
  missingFromManifestCount: number;
}

interface IndexFreshness {
  status: "fresh" | "stale" | "missing";
  missing: number;
  mismatched: number;
  extra: number;
}

interface StatusReport {
  manifestSchema: number;
  trackedFileCount: number;
  summaryFileCount: number;
  orphanCount: number;
  summaryFreshness: {
    status: "fresh" | "stale";
    missing: number;
  };
  indexFreshness: IndexFreshness;
}

function getSummaryDir(manifestPath: string): string {
  return path.resolve(path.dirname(manifestPath), "summaries");
}

async function readManifest(manifestPath: string): Promise<RepoManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(`Manifest not found: ${manifestPath}. Run \"diffdoc summarize\" first.`);
    }
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid manifest JSON in ${manifestPath}. Expected an object.`);
  }

  const manifest = parsed as Partial<RepoManifest>;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported manifest schema in ${manifestPath}. Expected schemaVersion ${MANIFEST_SCHEMA_VERSION}.`);
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    lastSyncedCommit: typeof manifest.lastSyncedCommit === "string" ? manifest.lastSyncedCommit : "",
    files: manifest.files && typeof manifest.files === "object" ? manifest.files : {}
  };
}

async function getSummaryStats(manifestPath: string, manifest: RepoManifest): Promise<SummaryStats> {
  const summaryDir = getSummaryDir(manifestPath);
  let entries: string[] = [];

  try {
    entries = await fs.readdir(summaryDir);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const summaryHashes = new Set(entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -5)));
  const manifestHashes = new Set(Object.values(manifest.files));

  let orphanCount = 0;
  for (const hash of summaryHashes) {
    if (!manifestHashes.has(hash)) {
      orphanCount += 1;
    }
  }

  let missingFromManifestCount = 0;
  for (const hash of manifestHashes) {
    if (!summaryHashes.has(hash)) {
      missingFromManifestCount += 1;
    }
  }

  return {
    summaryFileCount: summaryHashes.size,
    orphanCount,
    missingFromManifestCount
  };
}

async function getIndexFreshness(manifest: RepoManifest, config: RuntimeConfig): Promise<IndexFreshness> {
  const indexPath = getVectraIndexPath(config);
  const index = new LocalIndex<DiffdocVectorMetadata>(indexPath);
  const exists = await index.isIndexCreated();

  if (!exists) {
    return {
      status: "missing",
      missing: 0,
      mismatched: 0,
      extra: 0
    };
  }

  const items = await index.listItems<DiffdocVectorMetadata>();
  const indexHashesByPath = new Map<string, string>();

  for (const item of items) {
    if (!item.id || typeof item.id !== "string") {
      continue;
    }
    const hash = item.metadata && typeof item.metadata.hash === "string"
      ? item.metadata.hash
      : "";
    indexHashesByPath.set(item.id, hash);
  }

  let missing = 0;
  let mismatched = 0;

  for (const [filePath, manifestHash] of Object.entries(manifest.files)) {
    const indexedHash = indexHashesByPath.get(filePath);
    if (indexedHash === undefined) {
      missing += 1;
      continue;
    }
    if (indexedHash !== manifestHash) {
      mismatched += 1;
    }
  }

  const manifestPathSet = new Set(Object.keys(manifest.files));
  let extra = 0;
  for (const filePath of indexHashesByPath.keys()) {
    if (!manifestPathSet.has(filePath)) {
      extra += 1;
    }
  }

  return {
    status: missing === 0 && mismatched === 0 && extra === 0 ? "fresh" : "stale",
    missing,
    mismatched,
    extra
  };
}

function formatSummaryFreshness(stats: SummaryStats): string {
  if (stats.missingFromManifestCount === 0) {
    return "fresh";
  }

  return `stale (missing: ${stats.missingFromManifestCount})`;
}

function buildStatusReport(manifest: RepoManifest, summaryStats: SummaryStats, indexFreshness: IndexFreshness): StatusReport {
  return {
    manifestSchema: manifest.schemaVersion,
    trackedFileCount: Object.keys(manifest.files).length,
    summaryFileCount: summaryStats.summaryFileCount,
    orphanCount: summaryStats.orphanCount,
    summaryFreshness: {
      status: summaryStats.missingFromManifestCount === 0 ? "fresh" : "stale",
      missing: summaryStats.missingFromManifestCount
    },
    indexFreshness
  };
}

function formatIndexFreshness(freshness: IndexFreshness): string {
  if (freshness.status === "missing") {
    return "missing";
  }
  if (freshness.status === "fresh") {
    return "fresh";
  }

  return `stale (missing: ${freshness.missing}, mismatched: ${freshness.mismatched}, extra: ${freshness.extra})`;
}

export async function runStatus(options: StatusOptions, config: RuntimeConfig): Promise<void> {
  const manifestPath = resolveDiffdocArtifactPath(options.manifest, config.baseDir);
  const manifest = await readManifest(manifestPath);

  const summaryStats = await getSummaryStats(manifestPath, manifest);
  const indexFreshness = await getIndexFreshness(manifest, config);
  const report = buildStatusReport(manifest, summaryStats, indexFreshness);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`manifest schema: ${report.manifestSchema}`);
  console.log(`tracked files: ${report.trackedFileCount}`);
  console.log(`summary files: ${report.summaryFileCount}`);
  console.log(`orphans: ${report.orphanCount}`);
  console.log(`summary freshness: ${formatSummaryFreshness(summaryStats)}`);
  console.log(`index freshness: ${formatIndexFreshness(indexFreshness)}`);
}
