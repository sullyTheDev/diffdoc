import { createHash } from "node:crypto";

export function hashFileContent(fileContent: string): string {
  return createHash("md5").update(fileContent, "utf8").digest("hex");
}
