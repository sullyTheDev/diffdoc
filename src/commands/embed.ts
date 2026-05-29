import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import { LocalIndex, type MetadataTypes } from "vectra";
import { RepoManifestSchema, SummaryAssetSchema, type RepoManifest, type SummaryAsset } from "../types/artifacts";
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
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
  const result = RepoManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid manifest in ${manifestPath}:\n${issues}`);
  }
  return result.data;
}

async function readSummaryAsset(summaryPath: string): Promise<SummaryAsset> {
  const raw = JSON.parse(await fs.readFile(summaryPath, "utf8")) as unknown;
  const result = SummaryAssetSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid summary asset in ${summaryPath}:\n${issues}`);
  }
  return result.data;
}

function buildDocument(summaryAsset: SummaryAsset): string {
  return summaryAsset.summary;
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
      document: buildDocument(summaryAsset)
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
