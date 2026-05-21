import { LocalIndex } from "vectra";
import type { RuntimeConfig } from "../config";
import { generateEmbeddings, promptLlm } from "../utils/llm";
import { type DiffdocVectorMetadata, getVectraIndexPath } from "./embed";

const CODE_QUERY_PREFIX = "Represent this query for searching relevant code: ";

export interface QueryOptions {
  top: string;
  code: boolean;
}

export interface SearchOptions {
  top: string;
  code: boolean;
}

function parseTopK(value: string): number {
  const topK = Number.parseInt(value, 10);
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error("Invalid --top value. Expected a positive integer.");
  }

  return topK;
}

function trimForDisplay(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function buildAnswerPrompt(question: string, results: Awaited<ReturnType<LocalIndex<DiffdocVectorMetadata>["queryItems"]>>): string {
  const context = results.map((result, indexPosition) => {
    const metadata = result.item.metadata;
    return [
      `Result ${indexPosition + 1}`,
      `File: ${metadata.filePath}`,
      `Score: ${result.score}`,
      `Summary:\n${metadata.summaryText}`,
      `Code Snapshot:\n${metadata.rawCodeSnapshot}`
    ].join("\n");
  }).join("\n\n---\n\n");

  return `Answer the user's question using only the retrieved DiffDoc results below. If the results do not contain enough information, say what is missing. Prefer a direct answer first, then cite the relevant file paths. Keep the explanation appropriate to the question: summarize when asked for a summary, explain implementation details when asked how something works, and avoid unsupported claims.\n\nUser question:\n${question}\n\nRetrieved results:\n${context}`;
}

export async function runQuery(message: string, options: QueryOptions, config: RuntimeConfig): Promise<void> {
  const topK = parseTopK(options.top);
  const indexPath = getVectraIndexPath(config);
  const index = new LocalIndex<DiffdocVectorMetadata>(indexPath);

  if (!await index.isIndexCreated()) {
    throw new Error(`No Vectra index found at ${indexPath}. Run "diffdoc embed" first.`);
  }

  const [queryVector] = await generateEmbeddings([`${CODE_QUERY_PREFIX}${message}`], config.embeddings);
  const results = await index.queryItems(queryVector, message, topK);

  if (results.length === 0) {
    console.log("No matching embedded summaries found.");
    return;
  }

  const answer = await promptLlm(buildAnswerPrompt(message, results), config.chat);
  console.log(answer);

  console.log("\nSources:");
  for (const [indexPosition, result] of results.entries()) {
    const metadata = result.item.metadata;
    console.log(`${indexPosition + 1}. ${metadata.filePath} (${result.score.toFixed(4)})`);
  }

  if (!options.code) {
    return;
  }

  for (const [indexPosition, result] of results.entries()) {
    const metadata = result.item.metadata;
    console.log(`\n#${indexPosition + 1} ${metadata.filePath}`);
    console.log(`Score: ${result.score.toFixed(4)}`);
    console.log(`Hash: ${metadata.hash}`);
    console.log("Summary:");
    console.log(trimForDisplay(metadata.summaryText, 1200));

    if (options.code) {
      console.log("Code Snapshot:");
      console.log(trimForDisplay(metadata.rawCodeSnapshot, 2000));
    }
  }
}

export async function runSearch(message: string, options: SearchOptions, config: RuntimeConfig): Promise<void> {
  const topK = parseTopK(options.top);
  const indexPath = getVectraIndexPath(config);
  const index = new LocalIndex<DiffdocVectorMetadata>(indexPath);

  if (!await index.isIndexCreated()) {
    throw new Error(`No Vectra index found at ${indexPath}. Run "diffdoc embed" first.`);
  }

  const [queryVector] = await generateEmbeddings([`${CODE_QUERY_PREFIX}${message}`], config.embeddings);
  const results = await index.queryItems(queryVector, message, topK);

  if (results.length === 0) {
    console.log("No matching embedded summaries found.");
    return;
  }

  for (const [indexPosition, result] of results.entries()) {
    const metadata = result.item.metadata;
    console.log(`\n#${indexPosition + 1} ${metadata.filePath}`);
    console.log(`Score: ${result.score.toFixed(4)}`);
    console.log(`Hash: ${metadata.hash}`);
    console.log("Summary:");
    console.log(trimForDisplay(metadata.summaryText, 1200));

    if (options.code) {
      console.log("Code Snapshot:");
      console.log(trimForDisplay(metadata.rawCodeSnapshot, 2000));
    }
  }
}
