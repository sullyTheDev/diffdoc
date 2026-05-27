import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import { LocalIndex, type MetadataTypes } from "vectra";
import { MANIFEST_SCHEMA_VERSION, SUMMARY_ASSET_SCHEMA_VERSION, type RepoManifest, type SummaryAsset } from "../types/artifacts";
import { generateEmbeddings } from "../utils/llm";
import { getDiffdocBaseDir, resolveDiffdocArtifactPath } from "../utils/paths";

const VECTRA_INDEX_DIR = "vectra";

export type DiffdocVectorMetadata = Record<string, MetadataTypes> & {
  filePath: string;
  hash: string;
  summaryText: string;
  rawCodeSnapshot?: string;
};

export function getVectraIndexPath(config: RuntimeConfig): string {
  return path.resolve(getDiffdocBaseDir(config.baseDir), VECTRA_INDEX_DIR);
}

export interface EmbedOptions {
  manifest: string;
  rebuild: boolean;
}

function getSummaryDir(manifestPath: string): string {
  return path.resolve(path.dirname(manifestPath), "summaries");
}

function getSummaryPath(summaryDir: string, hash: string): string {
  return path.resolve(summaryDir, `${hash}.json`);
}

async function readManifest(manifestPath: string): Promise<RepoManifest> {
  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Partial<RepoManifest>;
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported manifest schema in ${manifestPath}. Expected schemaVersion ${MANIFEST_SCHEMA_VERSION}.`);
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    lastSyncedCommit: typeof parsed.lastSyncedCommit === "string" ? parsed.lastSyncedCommit : "",
    files: parsed.files && typeof parsed.files === "object" ? parsed.files : {}
  };
}

async function readSummaryAsset(summaryPath: string): Promise<SummaryAsset> {
  const parsed = JSON.parse(await fs.readFile(summaryPath, "utf8")) as Partial<SummaryAsset>;
  if (parsed.schemaVersion !== SUMMARY_ASSET_SCHEMA_VERSION) {
    throw new Error(`Unsupported summary schema in ${summaryPath}. Expected schemaVersion ${SUMMARY_ASSET_SCHEMA_VERSION}.`);
  }
  if (typeof parsed.content_hash !== "string") {
    throw new Error(`Invalid summary hash in ${summaryPath}.`);
  }
  if (typeof parsed.summary !== "string") {
    throw new Error(`Invalid summary text in ${summaryPath}.`);
  }

  return {
    schemaVersion: SUMMARY_ASSET_SCHEMA_VERSION,
    content_hash: parsed.content_hash,
    summary: parsed.summary,
    raw_code_snapshot: typeof parsed.raw_code_snapshot === "string" ? parsed.raw_code_snapshot : undefined
  };
}

function buildDocument(filePath: string, summaryText: string): string {
  return `File: ${filePath}\nSummary: ${summaryText}`;
}

export async function runEmbed(options: EmbedOptions, config: RuntimeConfig): Promise<void> {
  const manifestPath = resolveDiffdocArtifactPath(options.manifest, config.baseDir);
  const manifest = await readManifest(manifestPath);
  const entries = Object.entries(manifest.files);

  const summaryDir = getSummaryDir(manifestPath);
  const indexPath = getVectraIndexPath(config);
  const index = new LocalIndex<DiffdocVectorMetadata>(indexPath);

  if (options.rebuild) {
    await index.createIndex({
      version: 1,
      deleteIfExists: true,
      metadata_config: {
        indexed: ["filePath", "hash"]
      }
    });
  } else if (!await index.isIndexCreated()) {
    await index.createIndex({
      version: 1,
      deleteIfExists: false,
      metadata_config: {
        indexed: ["filePath", "hash"]
      }
    });
  }

  const existingItems = await index.listItems<DiffdocVectorMetadata>();
  const existingByPath = new Map(existingItems.map((item) => [item.id, item]));

  const toUpsert: Array<{
    filePath: string;
    hash: string;
    summaryText: string;
    rawCodeSnapshot?: string;
    document: string;
  }> = [];

  for (const [filePath, hash] of entries) {
    const existing = existingByPath.get(filePath);
    if (existing?.metadata.hash === hash) {
      continue;
    }

    const summaryPath = getSummaryPath(summaryDir, hash);
    const summaryAsset = await readSummaryAsset(summaryPath);
    if (summaryAsset.content_hash !== hash) {
      throw new Error(`Hash mismatch in summary asset ${summaryPath}.`);
    }

    toUpsert.push({
      filePath,
      hash,
      summaryText: summaryAsset.summary,
      rawCodeSnapshot: summaryAsset.raw_code_snapshot,
      document: buildDocument(filePath, summaryAsset.summary)
    });
  }

  const activePathSet = new Set(entries.map(([filePath]) => filePath));
  const toDelete = existingItems
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id) && !activePathSet.has(id));

  if (toUpsert.length === 0 && toDelete.length === 0) {
    console.log(`Index is already up to date at ${indexPath}.`);
    return;
  }

  await index.beginUpdate();
  try {
    for (let start = 0; start < toUpsert.length; start += config.embeddings.batchSize) {
      const batch = toUpsert.slice(start, start + config.embeddings.batchSize);
      const embeddings = await generateEmbeddings(batch.map((item) => item.document), config.embeddings);

      for (let i = 0; i < batch.length; i += 1) {
        const item = batch[i];
        const metadata: DiffdocVectorMetadata = item.rawCodeSnapshot
          ? {
            filePath: item.filePath,
            hash: item.hash,
            summaryText: item.summaryText,
            rawCodeSnapshot: item.rawCodeSnapshot
          }
          : {
            filePath: item.filePath,
            hash: item.hash,
            summaryText: item.summaryText
          };
        await index.upsertItem({
          id: item.filePath,
          vector: embeddings[i],
          metadata
        });
      }
    }

    for (const itemId of toDelete) {
      await index.deleteItem(itemId);
    }

    await index.endUpdate();
  } catch (error) {
    index.cancelUpdate();
    throw error;
  }

  console.log(`Embedded ${toUpsert.length} summaries and pruned ${toDelete.length} items in ${indexPath}.`);
}
