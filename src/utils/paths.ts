import path from "node:path";

export function getDiffdocBaseDir(baseDir: string): string {
  return path.resolve(process.cwd(), baseDir);
}

export function resolveDiffdocArtifactPath(filePath: string, baseDir: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(getDiffdocBaseDir(baseDir), filePath);
}
