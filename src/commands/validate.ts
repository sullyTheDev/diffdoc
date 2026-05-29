import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config";
import { RepoManifestSchema, SummaryAssetSchema } from "../types/artifacts";
import { resolveDiffdocArtifactPath } from "../utils/paths";

export interface ValidateOptions {
  manifest: string;
  json: boolean;
}

interface ValidationIssue {
  file: string;
  path: string;
  message: string;
}

interface ValidationReport {
  valid: boolean;
  manifestPath: string;
  manifestValid: boolean;
  summaryAssetsChecked: number;
  summaryAssetsValid: number;
  issues: ValidationIssue[];
}

function getSummaryDir(manifestPath: string): string {
  return path.resolve(path.dirname(manifestPath), "summaries");
}

export async function runValidate(options: ValidateOptions, config: RuntimeConfig): Promise<void> {
  const manifestPath = resolveDiffdocArtifactPath(options.manifest, config.baseDir);
  const issues: ValidationIssue[] = [];
  let manifestValid = false;
  let summaryAssetsChecked = 0;
  let summaryAssetsValid = 0;

  // Validate manifest
  let manifestData: unknown;
  try {
    manifestData = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      issues.push({ file: manifestPath, path: "", message: "Manifest file not found." });
    } else {
      issues.push({ file: manifestPath, path: "", message: `Failed to parse JSON: ${(error as Error).message}` });
    }
    manifestData = undefined;
  }

  if (manifestData !== undefined) {
    const result = RepoManifestSchema.safeParse(manifestData);
    if (result.success) {
      manifestValid = true;

      // Validate each referenced summary asset
      const summaryDir = getSummaryDir(manifestPath);
      const hashes = new Set(Object.values(result.data.files));

      for (const hash of hashes) {
        summaryAssetsChecked += 1;
        const summaryPath = path.resolve(summaryDir, `${hash}.json`);

        let summaryRaw: unknown;
        try {
          summaryRaw = JSON.parse(await fs.readFile(summaryPath, "utf8"));
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code === "ENOENT") {
            issues.push({ file: summaryPath, path: "", message: "Summary asset file not found." });
          } else {
            issues.push({ file: summaryPath, path: "", message: `Failed to parse JSON: ${(error as Error).message}` });
          }
          continue;
        }

        const assetResult = SummaryAssetSchema.safeParse(summaryRaw);
        if (assetResult.success) {
          // Cross-check content_hash matches filename
          if (assetResult.data.content_hash !== hash) {
            issues.push({ file: summaryPath, path: "content_hash", message: `Expected "${hash}" but got "${assetResult.data.content_hash}".` });
          } else {
            summaryAssetsValid += 1;
          }
        } else {
          for (const issue of assetResult.error.issues) {
            issues.push({ file: summaryPath, path: issue.path.join("."), message: issue.message });
          }
        }
      }
    } else {
      for (const issue of result.error.issues) {
        issues.push({ file: manifestPath, path: issue.path.join("."), message: issue.message });
      }
    }
  }

  const report: ValidationReport = {
    valid: manifestValid && issues.length === 0,
    manifestPath,
    manifestValid,
    summaryAssetsChecked,
    summaryAssetsValid,
    issues
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Manifest valid: ${manifestValid ? "yes" : "NO"}`);
    console.log(`Summary assets checked: ${summaryAssetsChecked}`);
    console.log(`Summary assets valid: ${summaryAssetsValid}`);
    console.log("---");

    if (issues.length === 0) {
      console.log("All artifacts pass schema validation.");
    } else {
      console.log(`Issues (${issues.length}):`);
      for (const issue of issues) {
        const location = issue.path ? `${issue.file} -> ${issue.path}` : issue.file;
        console.log(`  - ${location}: ${issue.message}`);
      }
    }
  }

  if (!report.valid) {
    process.exitCode = 1;
  }
}
