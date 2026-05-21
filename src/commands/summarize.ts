import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import { getCurrentCommit, getGitDeltas } from "../utils/git";
import { hashFileContent } from "../utils/hashing";
import { generateFunctionalSummary } from "../utils/llm";
import { resolveDiffdocArtifactPath } from "../utils/paths";

const TARGET_EXTENSIONS = new Set([".ts", ".js", ".cs", ".py"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);
const IGNORED_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]);

export interface ManifestFileEntry {
  hash: string;
  summaryText: string;
  rawCodeSnapshot: string;
}

export interface RepoManifest {
  lastSyncedCommit: string;
  files: Record<string, ManifestFileEntry>;
}

export interface SummarizeOptions {
  path: string;
  out: string;
  mode: "all" | "delta";
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isTargetCodeFile(filePath: string): boolean {
  return TARGET_EXTENSIONS.has(path.extname(filePath)) && !IGNORED_FILES.has(path.basename(filePath));
}

async function readManifest(manifestPath: string): Promise<RepoManifest> {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8")) as RepoManifest;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return { lastSyncedCommit: "", files: {} };
    }
    throw error;
  }
}

async function writeManifest(manifestPath: string, manifest: RepoManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function walkCodeFiles(rootPath: string, currentPath = rootPath): Promise<string[]> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...await walkCodeFiles(rootPath, entryPath));
      }
      continue;
    }

    if (entry.isFile() && isTargetCodeFile(entry.name)) {
      files.push(normalizeRelativePath(path.relative(rootPath, entryPath)));
    }
  }

  return files.sort();
}

async function summarizeFile(rootPath: string, relativePath: string, config: RuntimeConfig): Promise<ManifestFileEntry> {
  const absolutePath = path.join(rootPath, relativePath);
  const rawCodeSnapshot = await fs.readFile(absolutePath, "utf8");
  return {
    hash: hashFileContent(rawCodeSnapshot),
    summaryText: await generateFunctionalSummary(relativePath, rawCodeSnapshot, config.chat),
    rawCodeSnapshot
  };
}

export async function runSummarize(options: SummarizeOptions, config: RuntimeConfig): Promise<void> {
  if (options.mode !== "all" && options.mode !== "delta") {
    throw new Error('Invalid summarize mode. Expected "all" or "delta".');
  }

  const commandCwd = process.cwd();
  const repoPath = path.resolve(commandCwd, options.path);
  const manifestPath = resolveDiffdocArtifactPath(options.out, config.baseDir);
  const manifest = options.mode === "delta" ? await readManifest(manifestPath) : { lastSyncedCommit: "", files: {} };

  if (options.mode === "all") {
    const files = await walkCodeFiles(repoPath);
    manifest.files = {};
    for (const filePath of files) {
      manifest.files[filePath] = await summarizeFile(repoPath, filePath, config);
      console.log(`Summarized ${filePath}`);
    }
  } else {
    const deltas = await getGitDeltas(repoPath, manifest.lastSyncedCommit);
    for (const deletedPath of deltas.deleted) {
      delete manifest.files[deletedPath];
      console.log(`Pruned ${deletedPath}`);
    }

    for (const filePath of deltas.modifiedOrAdded) {
      const absolutePath = path.join(repoPath, filePath);
      try {
        const rawCodeSnapshot = await fs.readFile(absolutePath, "utf8");
        const hash = hashFileContent(rawCodeSnapshot);
        if (manifest.files[filePath]?.hash === hash) continue;
        manifest.files[filePath] = {
          hash,
          summaryText: await generateFunctionalSummary(filePath, rawCodeSnapshot, config.chat),
          rawCodeSnapshot
        };
        console.log(`Updated ${filePath}`);
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === "ENOENT") {
          delete manifest.files[filePath];
          continue;
        }
        throw error;
      }
    }
  }

  manifest.lastSyncedCommit = await getCurrentCommit(repoPath);
  await writeManifest(manifestPath, manifest);
  console.log(`Wrote manifest to ${manifestPath}`);
}
