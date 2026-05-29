import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { RuntimeConfig } from "../config";
import { RepoManifestSchema, type RepoManifest } from "../types/artifacts";
import { resolveDiffdocArtifactPath } from "../utils/paths";
import { normalizeGlobPattern, compileGlobs, readIgnoreMatcher, walkCodeFiles } from "../utils/scan";

export interface PruneOptions {
  path?: string;
  manifest: string;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
}

interface PrunedEntry {
  filePath: string;
  reason: "deleted" | "excluded";
}

interface PruneReport {
  scannedFileCount: number;
  manifestFileCount: number;
  pruned: PrunedEntry[];
  manifestEntriesRemoved: number;
  summaryAssetsDeleted: number;
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

async function writeManifest(manifestPath: string, manifest: RepoManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function countHashRefs(files: Record<string, string>): Map<string, number> {
  const refs = new Map<string, number>();
  for (const hash of Object.values(files)) {
    refs.set(hash, (refs.get(hash) || 0) + 1);
  }
  return refs;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function promptConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} (y/N): `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export async function runPrune(options: PruneOptions, config: RuntimeConfig): Promise<void> {
  const commandCwd = process.cwd();
  const repoPath = path.resolve(commandCwd, options.path || config.repoPath);
  const manifestPath = resolveDiffdocArtifactPath(options.manifest, config.baseDir);
  const summaryDir = getSummaryDir(manifestPath);

  const manifest = await readManifest(manifestPath);
  const manifestFilePaths = Object.keys(manifest.files);

  // Scan eligible files
  const includePatterns = compileGlobs(config.summarize.includeGlobs.map(normalizeGlobPattern));
  const excludePatterns = compileGlobs(config.summarize.excludeGlobs.map(normalizeGlobPattern));
  const ignoreMatcher = await readIgnoreMatcher(repoPath, config.summarize.ignoreFile);
  const scannedFiles = await walkCodeFiles(repoPath, includePatterns, excludePatterns, ignoreMatcher);
  const scannedFileSet = new Set(scannedFiles);

  // Identify entries to prune
  const toPrune: PrunedEntry[] = [];
  for (const filePath of manifestFilePaths) {
    if (scannedFileSet.has(filePath)) {
      continue;
    }

    // Check if the file is deleted from disk or just excluded by rules
    const absolutePath = path.resolve(repoPath, filePath);
    const exists = await fileExists(absolutePath);
    toPrune.push({
      filePath,
      reason: exists ? "excluded" : "deleted"
    });
  }

  if (toPrune.length === 0) {
    if (options.json) {
      const report: PruneReport = {
        scannedFileCount: scannedFiles.length,
        manifestFileCount: manifestFilePaths.length,
        pruned: [],
        manifestEntriesRemoved: 0,
        summaryAssetsDeleted: 0
      };
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Scanned files: ${scannedFiles.length}`);
      console.log(`Manifest files: ${manifestFilePaths.length}`);
      console.log("Nothing to prune.");
    }
    return;
  }

  // Dry run: report and exit
  if (options.dryRun) {
    if (options.json) {
      const report: PruneReport = {
        scannedFileCount: scannedFiles.length,
        manifestFileCount: manifestFilePaths.length,
        pruned: toPrune,
        manifestEntriesRemoved: toPrune.length,
        summaryAssetsDeleted: 0 // unknown until actual execution
      };
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Scanned files: ${scannedFiles.length}`);
      console.log(`Manifest files: ${manifestFilePaths.length}`);
      console.log(`Files to prune: ${toPrune.length}`);
      for (const entry of toPrune) {
        console.log(`  - ${entry.filePath} (${entry.reason})`);
      }
      console.log("");
      console.log("Dry run complete. Use without --dry-run to execute.");
    }
    return;
  }

  // Confirmation prompt
  if (!options.yes) {
    if (!options.json) {
      console.log(`Scanned files: ${scannedFiles.length}`);
      console.log(`Manifest files: ${manifestFilePaths.length}`);
      console.log(`Files to prune: ${toPrune.length}`);
      for (const entry of toPrune) {
        console.log(`  - ${entry.filePath} (${entry.reason})`);
      }
      console.log("");
    }

    const confirmed = await promptConfirm(`Remove ${toPrune.length} entries from manifest?`);
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  }

  // Execute pruning
  const refs = countHashRefs(manifest.files);
  let summaryAssetsDeleted = 0;

  for (const entry of toPrune) {
    const hash = manifest.files[entry.filePath];
    if (!hash) {
      continue;
    }

    delete manifest.files[entry.filePath];
    const newRefCount = Math.max((refs.get(hash) || 1) - 1, 0);
    refs.set(hash, newRefCount);

    // Delete summary asset if no longer referenced
    if (newRefCount === 0) {
      const summaryPath = getSummaryPath(summaryDir, hash);
      try {
        await fs.unlink(summaryPath);
        summaryAssetsDeleted += 1;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  await writeManifest(manifestPath, manifest);

  const report: PruneReport = {
    scannedFileCount: scannedFiles.length,
    manifestFileCount: manifestFilePaths.length,
    pruned: toPrune,
    manifestEntriesRemoved: toPrune.length,
    summaryAssetsDeleted
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Removed ${toPrune.length} manifest entries.`);
    console.log(`Deleted ${summaryAssetsDeleted} orphaned summary assets.`);
  }
}
