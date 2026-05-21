import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import { LocalIndex, type MetadataTypes } from "vectra";
import { generateEmbeddings } from "../utils/llm";
import { getDiffdocBaseDir, resolveDiffdocArtifactPath } from "../utils/paths";
import type { RepoManifest } from "./summarize";

const VECTRA_INDEX_DIR = "vectra";

export type DiffdocVectorMetadata = Record<string, MetadataTypes> & {
  filePath: string;
  hash: string;
  summaryText: string;
  rawCodeSnapshot: string;
};

export function getVectraIndexPath(config: RuntimeConfig): string {
  return path.resolve(getDiffdocBaseDir(config.baseDir), VECTRA_INDEX_DIR);
}

export interface EmbedOptions {
  manifest: string;
}

function buildDocument(filePath: string, summaryText: string, rawCodeSnapshot: string): string {
  return `File: ${filePath}\n` +
    `Summary: ${summaryText}\n\n` +
    `Code Snapshot:\n\`\`\`\n${rawCodeSnapshot}\n\`\`\``;
}

export async function runEmbed(options: EmbedOptions, config: RuntimeConfig): Promise<void> {
  const manifestPath = resolveDiffdocArtifactPath(options.manifest, config.baseDir);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RepoManifest;
  const entries = Object.entries(manifest.files);

  const indexPath = getVectraIndexPath(config);
  const index = new LocalIndex<DiffdocVectorMetadata>(indexPath);
  await index.createIndex({
    version: 1,
    deleteIfExists: true,
    metadata_config: {
      indexed: ["filePath", "hash"]
    }
  });

  if (entries.length === 0) {
    console.log(`Created empty Vectra index at ${indexPath}.`);
    return;
  }

  const documents = entries.map(([filePath, file]) => buildDocument(filePath, file.summaryText, file.rawCodeSnapshot));
  const embeddings = await generateEmbeddings(documents, config.embeddings);

  await index.beginUpdate();
  try {
    for (let i = 0; i < entries.length; i += 1) {
      const [filePath, file] = entries[i];
      await index.upsertItem({
        id: filePath,
        vector: embeddings[i],
        metadata: {
          filePath,
          hash: file.hash,
          summaryText: file.summaryText,
          rawCodeSnapshot: file.rawCodeSnapshot
        }
      });
    }
    await index.endUpdate();
  } catch (error) {
    index.cancelUpdate();
    throw error;
  }

  console.log(`Embedded ${entries.length} summaries into Vectra index at ${indexPath}.`);
}
