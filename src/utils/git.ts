import path from "node:path";
import simpleGit from "simple-git";

export interface GitDeltas {
  modifiedOrAdded: string[];
  deleted: string[];
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function addUnique(target: Set<string>, filePath: string): void {
  const normalized = normalizePath(filePath.trim());
  if (normalized) {
    target.add(normalized);
  }
}

export async function getGitDeltas(repoPath: string, sinceRef: string): Promise<GitDeltas> {
  const git = simpleGit(repoPath);
  const modifiedOrAdded = new Set<string>();
  const deleted = new Set<string>();

  if (sinceRef) {
    const output = await git.raw(["diff", "--name-status", `${sinceRef}..HEAD`]);
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [status, ...rest] = line.split(/\s+/);
      const filePath = rest[rest.length - 1];
      if (status.startsWith("D")) {
        addUnique(deleted, filePath);
      } else {
        addUnique(modifiedOrAdded, filePath);
      }
    }
  }

  const status = await git.status();
  for (const filePath of [...status.created, ...status.modified, ...status.renamed.map((item) => item.to)]) {
    addUnique(modifiedOrAdded, filePath);
  }
  for (const filePath of status.deleted) {
    addUnique(deleted, filePath);
  }

  return {
    modifiedOrAdded: [...modifiedOrAdded].sort(),
    deleted: [...deleted].sort()
  };
}

export async function getCurrentCommit(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  try {
    return (await git.revparse(["HEAD"])).trim();
  } catch {
    return "uncommitted";
  }
}
