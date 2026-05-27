import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { RuntimeConfig } from "../config";
import { MANIFEST_SCHEMA_VERSION, SUMMARY_ASSET_SCHEMA_VERSION, type RepoManifest, type SummaryAsset } from "../types/artifacts";
import { getCurrentCommit, getGitDeltas } from "../utils/git";
import { hashFileContent } from "../utils/hashing";
import { generateFunctionalSummary } from "../utils/llm";
import { resolveDiffdocArtifactPath } from "../utils/paths";

export interface SummarizeOptions {
  path: string;
  out: string;
  mode: "all" | "delta";
  includeCodeSnapshot: boolean;
  json: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  ignoreFile?: string;
}

interface SummarizeTotals {
  scanned: number;
  skipped: number;
  updated: number;
  failed: number;
  pruned: number;
}

interface SummarizeReport {
  mode: "all" | "delta";
  repoPath: string;
  manifestPath: string;
  summaryDir: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: SummarizeTotals;
  failures: Array<{ filePath: string; message: string }>;
}

type ManifestTask<T> = () => Promise<T>;

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function getSummaryDir(manifestPath: string): string {
  return path.resolve(path.dirname(manifestPath), "summaries");
}

function getSummaryPath(summaryDir: string, hash: string): string {
  return path.resolve(summaryDir, `${hash}.json`);
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.split(path.sep).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPattern(pattern);
  let regexBody = "";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === "*" && next === "*") {
      regexBody += ".*";
      i += 1;
      continue;
    }

    if (char === "*") {
      regexBody += "[^/]*";
      continue;
    }

    if (char === "?") {
      regexBody += "[^/]";
      continue;
    }

    regexBody += escapeRegex(char);
  }

  return new RegExp(`^${regexBody}$`);
}

function compileGlobs(patterns: string[]): RegExp[] {
  return patterns.filter(Boolean).map(globToRegExp);
}

function matchesAny(filePath: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(filePath));
}

function shouldIncludeFile(filePath: string, includeGlobs: RegExp[], excludeGlobs: RegExp[], ignoreMatcher: Ignore): boolean {
  if (ignoreMatcher.ignores(filePath)) {
    return false;
  }

  if (excludeGlobs.length > 0 && matchesAny(filePath, excludeGlobs)) {
    return false;
  }

  if (includeGlobs.length > 0 && !matchesAny(filePath, includeGlobs)) {
    return false;
  }

  return true;
}

function isIgnoredDirectory(dirPath: string, ignoreMatcher: Ignore): boolean {
  return ignoreMatcher.ignores(dirPath) || ignoreMatcher.ignores(`${dirPath}/`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteUtf8(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(tempPath, targetPath);
}

async function writeManifest(manifestPath: string, manifest: RepoManifest): Promise<void> {
  await atomicWriteUtf8(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeSummaryAsset(summaryPath: string, summary: SummaryAsset): Promise<void> {
  await atomicWriteUtf8(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

async function readManifest(manifestPath: string): Promise<RepoManifest> {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Partial<RepoManifest>;
    if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
      throw new Error(`Unsupported manifest schema in ${manifestPath}. Expected schemaVersion ${MANIFEST_SCHEMA_VERSION}.`);
    }

    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      lastSyncedCommit: typeof parsed.lastSyncedCommit === "string" ? parsed.lastSyncedCommit : "",
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {}
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        lastSyncedCommit: "",
        files: {}
      };
    }

    throw error;
  }
}

async function readIgnoreMatcher(repoPath: string, ignoreFilePath: string): Promise<Ignore> {
  const matcher = ignore();
  const absolutePath = path.isAbsolute(ignoreFilePath)
    ? ignoreFilePath
    : path.resolve(repoPath, ignoreFilePath);
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return matcher.add(raw);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return matcher;
    }
    throw error;
  }
}

async function walkCodeFiles(
  rootPath: string,
  includeGlobs: RegExp[],
  excludeGlobs: RegExp[],
  ignoreMatcher: Ignore,
  currentPath = rootPath
): Promise<string[]> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      const relativePath = normalizeRelativePath(path.relative(rootPath, entryPath));
      if (!isIgnoredDirectory(relativePath, ignoreMatcher)) {
        files.push(...await walkCodeFiles(rootPath, includeGlobs, excludeGlobs, ignoreMatcher, entryPath));
      }
      continue;
    }

    if (entry.isFile()) {
      const relativePath = normalizeRelativePath(path.relative(rootPath, entryPath));
      if (shouldIncludeFile(relativePath, includeGlobs, excludeGlobs, ignoreMatcher)) {
        files.push(relativePath);
      }
    }
  }

  return files.sort();
}

function countHashRefs(files: Record<string, string>): Map<string, number> {
  const refs = new Map<string, number>();
  for (const hash of Object.values(files)) {
    refs.set(hash, (refs.get(hash) || 0) + 1);
  }
  return refs;
}

async function deleteSummaryIfUnreferenced(summaryDir: string, hash: string, refs: Map<string, number>): Promise<void> {
  if ((refs.get(hash) || 0) > 0) {
    return;
  }

  const summaryPath = getSummaryPath(summaryDir, hash);
  try {
    await fs.unlink(summaryPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}

async function setManifestPathHash(
  filePath: string,
  newHash: string,
  manifest: RepoManifest,
  manifestPath: string,
  summaryDir: string,
  refs: Map<string, number>
): Promise<boolean> {
  const previousHash = manifest.files[filePath];
  if (previousHash === newHash) {
    return false;
  }

  if (previousHash) {
    refs.set(previousHash, Math.max((refs.get(previousHash) || 1) - 1, 0));
  }
  manifest.files[filePath] = newHash;
  refs.set(newHash, (refs.get(newHash) || 0) + 1);
  await writeManifest(manifestPath, manifest);

  if (previousHash) {
    await deleteSummaryIfUnreferenced(summaryDir, previousHash, refs);
  }
  return true;
}

async function removeManifestPath(
  filePath: string,
  manifest: RepoManifest,
  manifestPath: string,
  summaryDir: string,
  refs: Map<string, number>
): Promise<boolean> {
  const previousHash = manifest.files[filePath];
  if (!previousHash) {
    return false;
  }

  delete manifest.files[filePath];
  refs.set(previousHash, Math.max((refs.get(previousHash) || 1) - 1, 0));
  await writeManifest(manifestPath, manifest);
  await deleteSummaryIfUnreferenced(summaryDir, previousHash, refs);
  return true;
}

async function ensureSummaryAsset(
  summaryDir: string,
  hash: string,
  summaryText: string,
  rawCodeSnapshot: string,
  includeCodeSnapshot: boolean
): Promise<void> {
  const summaryPath = getSummaryPath(summaryDir, hash);
  if (await fileExists(summaryPath)) {
    return;
  }

  const summary: SummaryAsset = {
    schemaVersion: SUMMARY_ASSET_SCHEMA_VERSION,
    content_hash: hash,
    summary: summaryText,
    raw_code_snapshot: includeCodeSnapshot ? rawCodeSnapshot : undefined
  };
  await writeSummaryAsset(summaryPath, summary);
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  }));
}

function createManifestLock(): <T>(task: ManifestTask<T>) => Promise<T> {
  let queue = Promise.resolve();

  return async function withManifestLock<T>(task: ManifestTask<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
}

async function pruneOrphanedSummaries(summaryDir: string, manifest: RepoManifest): Promise<void> {
  const activeHashes = new Set(Object.values(manifest.files));

  let entries: string[] = [];
  try {
    entries = await fs.readdir(summaryDir);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const hash = entry.slice(0, -5);
    if (activeHashes.has(hash)) {
      continue;
    }

    await fs.unlink(path.resolve(summaryDir, entry));
  }
}

export async function runSummarize(options: SummarizeOptions, config: RuntimeConfig): Promise<void> {
  if (options.mode !== "all" && options.mode !== "delta") {
    throw new Error('Invalid summarize mode. Expected "all" or "delta".');
  }

  const startedAt = new Date();
  const commandCwd = process.cwd();
  const repoPath = path.resolve(commandCwd, options.path);
  const manifestPath = resolveDiffdocArtifactPath(options.out, config.baseDir);
  const summaryDir = getSummaryDir(manifestPath);
  const manifest = await readManifest(manifestPath);
  const refs = countHashRefs(manifest.files);

  const includePatterns = compileGlobs((options.includeGlobs && options.includeGlobs.length > 0)
    ? options.includeGlobs.map(normalizeGlobPattern)
    : config.summarize.includeGlobs.map(normalizeGlobPattern));
  const excludePatterns = compileGlobs((options.excludeGlobs && options.excludeGlobs.length > 0)
    ? options.excludeGlobs.map(normalizeGlobPattern)
    : config.summarize.excludeGlobs.map(normalizeGlobPattern));
  const ignoreFile = options.ignoreFile || config.summarize.ignoreFile;
  const ignoreMatcher = await readIgnoreMatcher(repoPath, ignoreFile);

  const totals: SummarizeTotals = { scanned: 0, skipped: 0, updated: 0, failed: 0, pruned: 0 };
  const failures: Array<{ filePath: string; message: string }> = [];

  const isJson = options.json;
  const concurrency = config.summarize.concurrency;
  const withManifestLock = createManifestLock();
  const summaryAssetTasks = new Map<string, Promise<void>>();

  async function ensureSummaryAssetForFile(filePath: string, hash: string, rawCodeSnapshot: string): Promise<void> {
    const summaryPath = getSummaryPath(summaryDir, hash);
    if (await fileExists(summaryPath)) {
      return;
    }

    let task = summaryAssetTasks.get(hash);
    if (!task) {
      task = (async () => {
        const summaryText = await generateFunctionalSummary(filePath, rawCodeSnapshot, config.chat);
        await ensureSummaryAsset(summaryDir, hash, summaryText, rawCodeSnapshot, options.includeCodeSnapshot);
      })().finally(() => {
        summaryAssetTasks.delete(hash);
      });
      summaryAssetTasks.set(hash, task);
    }

    await task;
  }

  if (!isJson) {
    console.log(`Starting summarize run`);
    console.log(`Mode: ${options.mode}`);
    console.log(`Repo: ${repoPath}`);
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Summaries: ${summaryDir}`);
    console.log("---");
  }

  if (options.mode === "all") {
    manifest.files = {};
    refs.clear();
    await writeManifest(manifestPath, manifest);

    const files = await walkCodeFiles(repoPath, includePatterns, excludePatterns, ignoreMatcher);
    const totalFiles = files.length;
    let completedFiles = 0;

    if (!isJson) {
      console.log(`Candidates: ${totalFiles}`);
      console.log(`Concurrency: ${concurrency}`);
    }

    await runWithConcurrency(files, concurrency, async (filePath) => {
      await withManifestLock(async () => {
        totals.scanned += 1;
      });
      try {
        const absolutePath = path.join(repoPath, filePath);
        const rawCodeSnapshot = await fs.readFile(absolutePath, "utf8");
        const hash = hashFileContent(rawCodeSnapshot);
        await ensureSummaryAssetForFile(filePath, hash, rawCodeSnapshot);
        await withManifestLock(async () => {
          manifest.files[filePath] = hash;
          refs.set(hash, (refs.get(hash) || 0) + 1);
          await writeManifest(manifestPath, manifest);
          totals.updated += 1;
          completedFiles += 1;
          if (!isJson) {
            console.log(`[${completedFiles}/${totalFiles}] summarized ${filePath}`);
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await withManifestLock(async () => {
          failures.push({ filePath, message });
          totals.failed += 1;
          completedFiles += 1;
          if (!isJson) {
            console.error(`[${completedFiles}/${totalFiles}] failed ${filePath}: ${message}`);
          }
        });
      }
    });
  } else {
    const deltas = await getGitDeltas(repoPath, manifest.lastSyncedCommit);
    const totalCandidates = deltas.modifiedOrAdded.length + deltas.deleted.length;
    let completedModified = 0;

    if (!isJson) {
      console.log(`Candidates: ${totalCandidates} (${deltas.modifiedOrAdded.length} modified/added, ${deltas.deleted.length} deleted)`);
      console.log(`Concurrency: ${concurrency}`);
    }

    for (const deletedPath of deltas.deleted) {
      const removed = await removeManifestPath(deletedPath, manifest, manifestPath, summaryDir, refs);
      if (removed) {
        totals.pruned += 1;
      }
      if (!isJson) {
        console.log(`pruned ${deletedPath}`);
      }
    }

    await runWithConcurrency(deltas.modifiedOrAdded, concurrency, async (filePath) => {
      await withManifestLock(async () => {
        totals.scanned += 1;
      });
      try {
        if (!shouldIncludeFile(filePath, includePatterns, excludePatterns, ignoreMatcher)) {
          await withManifestLock(async () => {
            const removed = await removeManifestPath(filePath, manifest, manifestPath, summaryDir, refs);
            if (removed) {
              totals.pruned += 1;
            } else {
              totals.skipped += 1;
            }
            completedModified += 1;
            if (!isJson) {
              console.log(`[${completedModified}/${deltas.modifiedOrAdded.length}] excluded ${filePath}`);
            }
          });
          return;
        }

        const previousHash = manifest.files[filePath];
        const absolutePath = path.join(repoPath, filePath);
        const rawCodeSnapshot = await fs.readFile(absolutePath, "utf8");
        const hash = hashFileContent(rawCodeSnapshot);
        if (previousHash === hash) {
          await withManifestLock(async () => {
            totals.skipped += 1;
            completedModified += 1;
            if (!isJson) {
              console.log(`[${completedModified}/${deltas.modifiedOrAdded.length}] unchanged ${filePath}`);
            }
          });
          return;
        }

        await ensureSummaryAssetForFile(filePath, hash, rawCodeSnapshot);

        await withManifestLock(async () => {
          const changed = await setManifestPathHash(filePath, hash, manifest, manifestPath, summaryDir, refs);
          if (changed) {
            totals.updated += 1;
          } else {
            totals.skipped += 1;
          }
          completedModified += 1;
          if (!isJson) {
            console.log(`[${completedModified}/${deltas.modifiedOrAdded.length}] updated ${filePath}`);
          }
        });
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === "ENOENT") {
          await withManifestLock(async () => {
            const removed = await removeManifestPath(filePath, manifest, manifestPath, summaryDir, refs);
            if (removed) {
              totals.pruned += 1;
            } else {
              totals.skipped += 1;
            }
            completedModified += 1;
            if (!isJson) {
              console.log(`[${completedModified}/${deltas.modifiedOrAdded.length}] missing ${filePath}`);
            }
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        await withManifestLock(async () => {
          failures.push({ filePath, message });
          totals.failed += 1;
          completedModified += 1;
          if (!isJson) {
            console.error(`[${completedModified}/${deltas.modifiedOrAdded.length}] failed ${filePath}: ${message}`);
          }
        });
      }
    });
  }

  manifest.lastSyncedCommit = await getCurrentCommit(repoPath);
  await writeManifest(manifestPath, manifest);
  await pruneOrphanedSummaries(summaryDir, manifest);

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  const report: SummarizeReport = {
    mode: options.mode,
    repoPath,
    manifestPath,
    summaryDir,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    totals,
    failures: failures.sort((a, b) => a.filePath.localeCompare(b.filePath))
  };

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("---");
    console.log(`Summarize complete`);
    console.log(`Scanned: ${totals.scanned}`);
    console.log(`Updated: ${totals.updated}`);
    console.log(`Skipped: ${totals.skipped}`);
    console.log(`Pruned: ${totals.pruned}`);
    console.log(`Failed: ${totals.failed}`);
    console.log(`Duration: ${(durationMs / 1000).toFixed(2)}s`);
    console.log(`Manifest: ${manifestPath}`);
  }

  if (failures.length > 0) {
    if (!isJson) {
      console.error(`\n${failures.length} file(s) failed during summarization:`);
      for (const failure of failures) {
        console.error(`- ${failure.filePath}: ${failure.message}`);
      }
    }
    throw new Error("Summarization completed with failures.");
  }
}
