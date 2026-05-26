import type { RuntimeConfig } from "../config";
import { answerFromIndex, parseTopK, searchIndex, trimForDisplay } from "../services/retrieval";

export interface QueryOptions {
  top: string;
  code: boolean;
}

export interface SearchOptions {
  top: string;
  code: boolean;
}

export async function runQuery(message: string, options: QueryOptions, config: RuntimeConfig): Promise<void> {
  const topK = parseTopK(options.top);
  const answerResult = await answerFromIndex(message, topK, config);
  console.log(answerResult.answer);

  if (answerResult.sources.length === 0) {
    return;
  }

  console.log("\nSources:");
  for (const [indexPosition, source] of answerResult.sources.entries()) {
    console.log(`${indexPosition + 1}. ${source.filePath} (${source.score.toFixed(4)})`);
  }

  if (!options.code) {
    return;
  }

  for (const [indexPosition, result] of answerResult.results.entries()) {
    console.log(`\n#${indexPosition + 1} ${result.filePath}`);
    console.log(`Score: ${result.score.toFixed(4)}`);
    console.log(`Hash: ${result.hash}`);
    console.log("Summary:");
    console.log(trimForDisplay(result.summaryText, 1200));

    if (options.code) {
      console.log("Code Snapshot:");
      console.log(trimForDisplay(result.rawCodeSnapshot || "(not stored)", 2000));
    }
  }
}

export async function runSearch(message: string, options: SearchOptions, config: RuntimeConfig): Promise<void> {
  const topK = parseTopK(options.top);
  const results = await searchIndex(message, topK, config);

  if (results.length === 0) {
    console.log("No matching embedded summaries found.");
    return;
  }

  for (const [indexPosition, result] of results.entries()) {
    console.log(`\n#${indexPosition + 1} ${result.filePath}`);
    console.log(`Score: ${result.score.toFixed(4)}`);
    console.log(`Hash: ${result.hash}`);
    console.log("Summary:");
    console.log(trimForDisplay(result.summaryText, 1200));

    if (options.code) {
      console.log("Code Snapshot:");
      console.log(trimForDisplay(result.rawCodeSnapshot || "(not stored)", 2000));
    }
  }
}
