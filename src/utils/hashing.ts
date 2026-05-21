import { createHash } from "node:crypto";

const HASH_ALGORITHM = "md5";

export function hashFileContent(fileContent: string): string {
  return createHash(HASH_ALGORITHM).update(fileContent, "utf8").digest("hex");
}
