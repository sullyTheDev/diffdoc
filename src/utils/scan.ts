import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function normalizeGlobPattern(pattern: string): string {
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

export function compileGlobs(patterns: string[]): RegExp[] {
  return patterns.filter(Boolean).map(globToRegExp);
}

function matchesAny(filePath: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(filePath));
}

export function shouldIncludeFile(filePath: string, includeGlobs: RegExp[], excludeGlobs: RegExp[], ignoreMatcher: Ignore): boolean {
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

export async function readIgnoreMatcher(repoPath: string, ignoreFilePath: string): Promise<Ignore> {
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

export async function walkCodeFiles(
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
