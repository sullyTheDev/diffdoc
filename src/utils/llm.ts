import OpenAI from "openai";
import type { ChatConfig, EmbeddingConfig } from "../config";
import type { SummaryMetadata } from "../types/artifacts";

export const SUMMARY_PROMPT_VERSION = 1;
export const SUMMARY_FORMAT = "structured-functional-v1";

const SUMMARY_SYSTEM_PROMPT = `Generate a structured DiffDoc functional summary for the provided source file.

Required headings, exactly once and in this order:
## Metadata
## Purpose
## User-Visible Behavior
## Business Rules
## Data Inputs And Outputs
## Side Effects
## Error And Edge Cases
## Dependencies
## Operational Notes

Section guidance:

## Metadata
Include file-level context useful for search and retrieval. This section is mandatory and must contain every bullet below exactly once, in this order:
- File path: {copy the provided file path exactly}
- File name: {copy the provided file name exactly}
- Extension: {copy the provided extension exactly}
- Inferred language/type: {infer from file path, file name, extension, and code content}
- Content hash: {copy the provided content hash exactly}
- Line count: {copy the provided line count exactly}
- Byte size: {copy the provided byte size exactly}
- Summary format: {copy the provided summary format exactly}
- Notable symbols/classes/functions: {infer from code, or write "None identified."}
- External dependencies: {infer from imports, packages, runtime services, external APIs, or write "None identified."}
- Internal dependencies: {infer from project imports, local modules, local artifacts, or write "None identified."}
- Public API/exports: {infer exported functions, classes, types, routes, commands, tools, or write "None identified."}

## Purpose
Explain why this file exists and the main responsibility it serves.
Examples: handles login requests, builds a vector index, loads runtime configuration.

## User-Visible Behavior
Describe behavior users, operators, developers, or API consumers would observe.
Examples: CLI output, API responses, UI behavior, created/updated/deleted files, validation errors.

## Business Rules
Describe implemented rules, constraints, decisions, and policy-like behavior.
Examples: required fields, valid modes, filtering precedence, defaults, validation rules, skip conditions.

## Data Inputs And Outputs
Describe what data enters and leaves this file's behavior.
Examples: input files, config values, environment variables, function arguments, API payloads, generated artifacts, return values.

## Side Effects
Describe changes caused outside local computation.
Examples: writes files, deletes files, calls external services, updates indexes, logs output, mutates shared state, sends network requests.

## Error And Edge Cases
Describe failure handling and unusual conditions.
Examples: missing files, invalid config, unsupported schemas, empty results, network/model failures, deleted or unchanged files.

## Dependencies
Describe important internal and external dependencies.
Examples: imported packages, runtime services, local artifacts, external APIs, models/providers, framework components, project files.

## Operational Notes
Describe details useful for running, maintaining, scaling, or debugging.
Examples: concurrency, performance, idempotency, caching/reuse, schema implications, regeneration requirements, security/privacy considerations.

Rules:
- Use every heading exactly once.
- Use headings in the required order.
- Start with ## Metadata.
- Include provided deterministic metadata values exactly.
- Do not rename, omit, reorder, or merge Metadata bullets.
- Infer the language/type from the provided file path, file name, extension, and code content. Prefer code content when extension is ambiguous. If uncertain, provide the best likely language/type and briefly note uncertainty.
- Let the code identify symbols, classes, functions, and dependencies. Include important identifiers when useful for search.
- If a section has no applicable content, write "None identified."
- Do not invent behavior, requirements, dependencies, or intent not supported by the code.
- Summarize implemented behavior only.
- Prefer specific behavior over generic descriptions.
- Use plain English.
- Provide zero conversational preamble.
- Do not include Markdown sections outside the required headings.`;

function createClient(config: ChatConfig): { client: OpenAI; model: string } {
  return {
    client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }),
    model: config.model
  };
}

function formatMetadataForPrompt(metadata: SummaryMetadata): string {
  return [
    `- File path: ${metadata.file_path}`,
    `- File name: ${metadata.file_name}`,
    `- Extension: ${metadata.extension || "None"}`,
    `- Content hash: ${metadata.content_hash}`,
    `- Line count: ${metadata.line_count}`,
    `- Byte size: ${metadata.byte_size}`,
    `- Summary format: ${metadata.summary_format}`
  ].join("\n");
}

export async function generateFunctionalSummary(
  fileName: string,
  codeContent: string,
  metadata: SummaryMetadata,
  config: ChatConfig,
  customPrompt?: string
): Promise<string> {
  const { client, model } = createClient(config);
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: SUMMARY_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: `File: ${fileName}\n\nProvided metadata:\n${formatMetadataForPrompt(metadata)}\n\nConsumer instructions:\n${customPrompt && customPrompt.trim() ? customPrompt.trim() : "None."}\n\nCode:\n${codeContent}`
      }
    ]
  });

  return response.choices[0]?.message?.content?.trim() || "No business behavior summary was returned.";
}

export async function generateAnswer(prompt: string, config: ChatConfig): Promise<string> {
  const { client, model } = createClient(config);
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return response.choices[0]?.message?.content?.trim() || "No response was returned.";
}

export async function generateEmbeddings(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  const baseURL = config.baseURL.replace(/\/embeddings\/?$/, "");
  const client = new OpenAI({ apiKey: config.apiKey, baseURL });
  const response = await client.embeddings.create({
    model: config.model,
    input: texts
  });

  return response.data.map((item) => item.embedding);
}
