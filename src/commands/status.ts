import fs from "node:fs/promises";
import path from "node:path";
import { LocalIndex } from "vectra";
import type { RuntimeConfig } from "../config";
import { type DiffdocVectorMetadata, getVectraIndexPath } from "./embed";
import { RepoManifestSchema, SummaryAssetSchema, type RepoManifest } from "../types/artifacts";
import { resolveDiffdocArtifactPath } from "../utils/paths";
import { SUMMARY_FORMAT, SUMMARY_PROMPT_VERSION } from "../utils/llm";

export interface StatusOptions {
  manifest: string;
  json: boolean;
}

interface SummaryStats {
  summaryFileCount: number;
  orphanCount: number;
  missingFromManifestCount: number;
  staleCount: number;
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
    stale: number;
  };
  indexFreshness: IndexFreshness;
  nextCommand: string | null;
  nextCommandReason: string;
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

  const result = RepoManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid manifest in ${manifestPath}:\n${issues}`);
  }

  return result.data;
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

  let staleCount = 0;
  for (const hash of manifestHashes) {
    if (!summaryHashes.has(hash)) {
      continue;
    }

    try {
      const raw = JSON.parse(await fs.readFile(path.resolve(summaryDir, `${hash}.json`), "utf8")) as unknown;
      const result = SummaryAssetSchema.safeParse(raw);
      if (!result.success) {
        staleCount += 1;
        continue;
      }
      const asset = result.data;
      if (
        asset.content_hash !== hash ||
        !asset.metadata ||
        asset.metadata.content_hash !== hash ||
        asset.metadata.prompt_version !== SUMMARY_PROMPT_VERSION ||
        asset.metadata.summary_format !== SUMMARY_FORMAT
      ) {
        staleCount += 1;
      }
    } catch {
      staleCount += 1;
    }
  }

  return {
    summaryFileCount: summaryHashes.size,
    orphanCount,
    missingFromManifestCount,
    staleCount
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
  if (stats.missingFromManifestCount === 0 && stats.staleCount === 0) {
    return "fresh";
  }

  return `stale (missing: ${stats.missingFromManifestCount}, stale: ${stats.staleCount})`;
}

function buildSummarizeCommand(manifestOption: string): string {
  const command = "diffdoc summarize --mode all --refresh";
  return manifestOption === "manifest.json" ? command : `${command} --out ${manifestOption}`;
}

function buildEmbedCommand(manifestOption: string): string {
  const command = "diffdoc embed";
  return manifestOption === "manifest.json" ? command : `${command} --manifest ${manifestOption}`;
}

function getNextCommand(manifestOption: string, summaryStats: SummaryStats, indexFreshness: IndexFreshness): { command: string | null; reason: string } {
  if (summaryStats.missingFromManifestCount > 0 || summaryStats.staleCount > 0) {
    return {
      command: buildSummarizeCommand(manifestOption),
      reason: "summary artifacts are missing or stale"
    };
  }

  if (indexFreshness.status === "missing") {
    return {
      command: buildEmbedCommand(manifestOption),
      reason: "vector index is missing"
    };
  }

  if (indexFreshness.status === "stale") {
    return {
      command: buildEmbedCommand(manifestOption),
      reason: "vector index is stale"
    };
  }

  return {
    command: null,
    reason: "summaries and index are fresh"
  };
}

function buildStatusReport(manifest: RepoManifest, summaryStats: SummaryStats, indexFreshness: IndexFreshness, manifestOption: string): StatusReport {
  const nextCommand = getNextCommand(manifestOption, summaryStats, indexFreshness);
  return {
    manifestSchema: manifest.schemaVersion,
    trackedFileCount: Object.keys(manifest.files).length,
    summaryFileCount: summaryStats.summaryFileCount,
    orphanCount: summaryStats.orphanCount,
    summaryFreshness: {
      status: summaryStats.missingFromManifestCount === 0 && summaryStats.staleCount === 0 ? "fresh" : "stale",
      missing: summaryStats.missingFromManifestCount,
      stale: summaryStats.staleCount
    },
    indexFreshness,
    nextCommand: nextCommand.command,
    nextCommandReason: nextCommand.reason
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
  const report = buildStatusReport(manifest, summaryStats, indexFreshness, options.manifest);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`manifest schema: ${report.manifestSchema}`);
  console.log(`tracked files: ${report.trackedFileCount}`);
  console.log(`summary files: ${report.summaryFileCount}`);
  console.log(`orphans: ${report.orphanCount}`);
  console.log(`stale summaries: ${report.summaryFreshness.stale}`);
  console.log(`summary freshness: ${formatSummaryFreshness(summaryStats)}`);
  console.log(`index freshness: ${formatIndexFreshness(indexFreshness)}`);
  console.log("");
  console.log(`next command: ${report.nextCommand || "none"}`);
  console.log(`reason: ${report.nextCommandReason}`);
}
