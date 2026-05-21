import { LocalIndex } from "vectra";
import type { QueryResult } from "vectra";
import type { RuntimeConfig } from "../config";
import { type DiffdocVectorMetadata, getVectraIndexPath } from "../commands/embed";
import { generateEmbeddings, promptLlm } from "../utils/llm";

const CODE_QUERY_PREFIX = "Represent this query for searching relevant code: ";

export interface DiffdocSearchResult {
  filePath: string;
  score: number;
  hash: string;
  summaryText: string;
  rawCodeSnapshot: string;
}

export interface DiffdocAnswerResult {
  answer: string;
  sources: Array<{
    filePath: string;
    score: number;
  }>;
  results: DiffdocSearchResult[];
}

export interface DiffdocIndexStats {
  indexPath: string;
  exists: boolean;
  items: number;
}

export function parseTopK(value: string | number): number {
  const topK = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error("Invalid top value. Expected a positive integer.");
  }

  return topK;
}

export function trimForDisplay(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function mapSearchResult(result: QueryResult<DiffdocVectorMetadata>): DiffdocSearchResult {
  const metadata = result.item.metadata;
  return {
    filePath: metadata.filePath,
    score: result.score,
    hash: metadata.hash,
    summaryText: metadata.summaryText,
    rawCodeSnapshot: metadata.rawCodeSnapshot
  };
}

function buildAnswerPrompt(question: string, results: DiffdocSearchResult[]): string {
  const context = results.map((result, indexPosition) => {
    return [
      `Result ${indexPosition + 1}`,
      `File: ${result.filePath}`,
      `Score: ${result.score}`,
      `Summary:\n${result.summaryText}`,
      `Code Snapshot:\n${result.rawCodeSnapshot}`
    ].join("\n");
  }).join("\n\n---\n\n");

  return `Answer the user's question using only the retrieved DiffDoc results below. If the results do not contain enough information, say what is missing. Prefer a direct answer first, then cite the relevant file paths. Keep the explanation appropriate to the question: summarize when asked for a summary, explain implementation details when asked how something works, and avoid unsupported claims.\n\nUser question:\n${question}\n\nRetrieved results:\n${context}`;
}

async function getExistingIndex(config: RuntimeConfig): Promise<LocalIndex<DiffdocVectorMetadata>> {
  const indexPath = getVectraIndexPath(config);
  const index = new LocalIndex<DiffdocVectorMetadata>(indexPath);

  if (!await index.isIndexCreated()) {
    throw new Error(`No Vectra index found at ${indexPath}. Run "diffdoc embed" first.`);
  }

  return index;
}

export async function searchIndex(query: string, topK: number, config: RuntimeConfig): Promise<DiffdocSearchResult[]> {
  const index = await getExistingIndex(config);
  const [queryVector] = await generateEmbeddings([`${CODE_QUERY_PREFIX}${query}`], config.embeddings);
  const results = await index.queryItems(queryVector, query, topK);
  return results.map(mapSearchResult);
}

export async function answerFromIndex(question: string, topK: number, config: RuntimeConfig): Promise<DiffdocAnswerResult> {
  const results = await searchIndex(question, topK, config);
  if (results.length === 0) {
    return {
      answer: "No matching embedded summaries found.",
      sources: [],
      results: []
    };
  }

  const answer = await promptLlm(buildAnswerPrompt(question, results), config.chat);
  return {
    answer,
    sources: results.map((result) => ({ filePath: result.filePath, score: result.score })),
    results
  };
}

export async function getIndexStats(config: RuntimeConfig): Promise<DiffdocIndexStats> {
  const indexPath = getVectraIndexPath(config);
  const index = new LocalIndex<DiffdocVectorMetadata>(indexPath);
  const exists = await index.isIndexCreated();
  if (!exists) {
    return { indexPath, exists: false, items: 0 };
  }

  const stats = await index.getIndexStats();
  return { indexPath, exists: true, items: stats.items };
}
