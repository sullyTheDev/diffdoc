import fs from "node:fs/promises";
import path from "node:path";
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
  includeGlobs?: string[];
  excludeGlobs?: string[];
  ignoreFile?: string;
}

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

function shouldIncludeFile(filePath: string, includeGlobs: RegExp[], excludeGlobs: RegExp[], ignoreGlobs: RegExp[]): boolean {
  if (includeGlobs.length > 0 && !matchesAny(filePath, includeGlobs)) {
    return false;
  }

  if (excludeGlobs.length > 0 && matchesAny(filePath, excludeGlobs)) {
    return false;
  }

  if (ignoreGlobs.length > 0 && matchesAny(filePath, ignoreGlobs)) {
    return false;
  }

  return true;
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

async function readIgnorePatterns(repoPath: string, ignoreFilePath: string): Promise<string[]> {
  const absolutePath = path.isAbsolute(ignoreFilePath)
    ? ignoreFilePath
    : path.resolve(repoPath, ignoreFilePath);
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map(normalizeGlobPattern);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function walkCodeFiles(
  rootPath: string,
  includeGlobs: RegExp[],
  excludeGlobs: RegExp[],
  ignoreGlobs: RegExp[],
  currentPath = rootPath
): Promise<string[]> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkCodeFiles(rootPath, includeGlobs, excludeGlobs, ignoreGlobs, entryPath));
      continue;
    }

    if (entry.isFile()) {
      const relativePath = normalizeRelativePath(path.relative(rootPath, entryPath));
      if (shouldIncludeFile(relativePath, includeGlobs, excludeGlobs, ignoreGlobs)) {
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
): Promise<void> {
  const previousHash = manifest.files[filePath];
  if (previousHash === newHash) {
    return;
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
}

async function removeManifestPath(
  filePath: string,
  manifest: RepoManifest,
  manifestPath: string,
  summaryDir: string,
  refs: Map<string, number>
): Promise<void> {
  const previousHash = manifest.files[filePath];
  if (!previousHash) {
    return;
  }

  delete manifest.files[filePath];
  refs.set(previousHash, Math.max((refs.get(previousHash) || 1) - 1, 0));
  await writeManifest(manifestPath, manifest);
  await deleteSummaryIfUnreferenced(summaryDir, previousHash, refs);
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
  const ignorePatterns = compileGlobs(await readIgnorePatterns(repoPath, ignoreFile));

  const failures: Array<{ filePath: string; message: string }> = [];

  if (options.mode === "all") {
    manifest.files = {};
    refs.clear();
    await writeManifest(manifestPath, manifest);

    const files = await walkCodeFiles(repoPath, includePatterns, excludePatterns, ignorePatterns);
    for (const filePath of files) {
      try {
        const absolutePath = path.join(repoPath, filePath);
        const rawCodeSnapshot = await fs.readFile(absolutePath, "utf8");
        const hash = hashFileContent(rawCodeSnapshot);
        const summaryPath = getSummaryPath(summaryDir, hash);
        if (!await fileExists(summaryPath)) {
          const summaryText = await generateFunctionalSummary(filePath, rawCodeSnapshot, config.chat);
          await ensureSummaryAsset(summaryDir, hash, summaryText, rawCodeSnapshot, options.includeCodeSnapshot);
        }
        manifest.files[filePath] = hash;
        refs.set(hash, (refs.get(hash) || 0) + 1);
        await writeManifest(manifestPath, manifest);
        console.log(`Summarized ${filePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ filePath, message });
        console.error(`Failed ${filePath}: ${message}`);
      }
    }
  } else {
    const deltas = await getGitDeltas(repoPath, manifest.lastSyncedCommit);

    for (const deletedPath of deltas.deleted) {
      await removeManifestPath(deletedPath, manifest, manifestPath, summaryDir, refs);
      console.log(`Pruned ${deletedPath}`);
    }

    for (const filePath of deltas.modifiedOrAdded) {
      try {
        if (!shouldIncludeFile(filePath, includePatterns, excludePatterns, ignorePatterns)) {
          await removeManifestPath(filePath, manifest, manifestPath, summaryDir, refs);
          continue;
        }

        const previousHash = manifest.files[filePath];
        const absolutePath = path.join(repoPath, filePath);
        const rawCodeSnapshot = await fs.readFile(absolutePath, "utf8");
        const hash = hashFileContent(rawCodeSnapshot);
        if (previousHash === hash) {
          continue;
        }

        const summaryPath = getSummaryPath(summaryDir, hash);
        if (!await fileExists(summaryPath)) {
          const summaryText = await generateFunctionalSummary(filePath, rawCodeSnapshot, config.chat);
          await ensureSummaryAsset(summaryDir, hash, summaryText, rawCodeSnapshot, options.includeCodeSnapshot);
        }

        await setManifestPathHash(filePath, hash, manifest, manifestPath, summaryDir, refs);
        console.log(`Updated ${filePath}`);
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === "ENOENT") {
          await removeManifestPath(filePath, manifest, manifestPath, summaryDir, refs);
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        failures.push({ filePath, message });
        console.error(`Failed ${filePath}: ${message}`);
      }
    }
  }

  manifest.lastSyncedCommit = await getCurrentCommit(repoPath);
  await writeManifest(manifestPath, manifest);
  await pruneOrphanedSummaries(summaryDir, manifest);
  console.log(`Wrote manifest to ${manifestPath}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} file(s) failed during summarization:`);
    for (const failure of failures) {
      console.error(`- ${failure.filePath}: ${failure.message}`);
    }
    throw new Error("Summarization completed with failures.");
  }
}
