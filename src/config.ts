import fs from "node:fs";
import path from "node:path";
import { DiffdocConfigSchema } from "./schemas";

export type AiProvider = "local" | "cloud";

export interface ChatConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export interface EmbeddingConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  batchSize: number;
}

export interface SummarizeFilterConfig {
  includeGlobs: string[];
  excludeGlobs: string[];
  ignoreFile: string;
  concurrency: number;
  summaryPrompt?: string;
  summaryPromptFile?: string;
  resolvedSummaryPrompt?: string;
  summaryPromptSource?: string;
}

export interface RuntimeConfig {
  baseDir: string;
  provider: AiProvider;
  chat: ChatConfig;
  embeddings: EmbeddingConfig;
  summarize: SummarizeFilterConfig;
}

export interface RuntimeConfigOptions {
  config?: string;
  baseDir?: string;
  aiProvider?: string;
  localLlmEndpoint?: string;
  localEmbedEndpoint?: string;
  localChatModel?: string;
  localEmbedModel?: string;
  cloudLlmEndpoint?: string;
  cloudChatModel?: string;
  cloudEmbedModel?: string;
  embedBatchSize?: number | string;
  openaiApiKey?: string;
  includeGlobs?: string[] | string;
  excludeGlobs?: string[] | string;
  ignoreFile?: string;
  summarizeConcurrency?: number | string;
  summaryPrompt?: string;
  summaryPromptFile?: string;
}

export interface RuntimeConfigNeeds {
  chat?: boolean;
  embeddings?: boolean;
}

function readOption(value: string | undefined, envName: string, fallback = ""): string {
  return value || process.env[envName] || fallback;
}

function parseCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function readListOption(value: string[] | string | undefined, envName: string, fallback: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseCsv(item)).filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return parseCsv(value);
  }

  const envValue = process.env[envName];
  if (envValue && envValue.trim()) {
    return parseCsv(envValue);
  }

  return fallback;
}

function readPositiveIntegerOption(value: number | string | undefined, envName: string, fallback: number): number {
  const rawValue = value ?? process.env[envName];
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }

  const parsed = typeof rawValue === "number" ? rawValue : Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${envName}. Expected a positive integer.`);
  }

  return parsed;
}

function readPromptOption(value: string | undefined, envName: string): string | undefined {
  const option = value ?? process.env[envName];
  return option && option.trim() ? option : undefined;
}

function resolvePromptFile(promptFile: string): string {
  const resolvedPath = path.resolve(process.cwd(), promptFile);
  return fs.readFileSync(resolvedPath, "utf8");
}

function loadRcFile(configPath: string | undefined): RuntimeConfigOptions {
  const resolvedPath = path.resolve(process.cwd(), configPath || ".diffdocrc");
  if (!fs.existsSync(resolvedPath)) {
    if (configPath) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
    return {};
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${resolvedPath}`);
  }

  const result = DiffdocConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config file ${resolvedPath}:\n${issues}`);
  }

  return result.data as RuntimeConfigOptions;
}

function mergeConfigOptions(options: RuntimeConfigOptions): RuntimeConfigOptions {
  const rcOptions = loadRcFile(options.config);
  return {
    ...rcOptions,
    ...options
  };
}

function readProvider(value: string | undefined): AiProvider {
  const provider = readOption(value, "AI_PROVIDER", "local");
  if (provider !== "local" && provider !== "cloud") {
    throw new Error('Invalid AI provider. Expected "local" or "cloud".');
  }

  return provider;
}

export function buildRuntimeConfig(options: RuntimeConfigOptions, needs: RuntimeConfigNeeds = { chat: true, embeddings: true }): RuntimeConfig {
  const mergedOptions = mergeConfigOptions(options);
  const provider = readProvider(mergedOptions.aiProvider);
  const apiKey = readOption(mergedOptions.openaiApiKey, "OPENAI_API_KEY", provider === "local" ? "local-key" : "");
  const embedBatchSize = readPositiveIntegerOption(mergedOptions.embedBatchSize, "DIFFDOC_EMBED_BATCH_SIZE", 25);
  const includeGlobs = readListOption(mergedOptions.includeGlobs, "DIFFDOC_INCLUDE_GLOBS");
  const excludeGlobs = readListOption(mergedOptions.excludeGlobs, "DIFFDOC_EXCLUDE_GLOBS");
  const ignoreFile = readOption(mergedOptions.ignoreFile, "DIFFDOC_IGNORE_FILE", ".diffdocignore");
  const summarizeConcurrency = readPositiveIntegerOption(mergedOptions.summarizeConcurrency, "DIFFDOC_SUMMARIZE_CONCURRENCY", 2);
  const summaryPrompt = readPromptOption(mergedOptions.summaryPrompt, "DIFFDOC_SUMMARY_PROMPT");
  const summaryPromptFile = readPromptOption(mergedOptions.summaryPromptFile, "DIFFDOC_SUMMARY_PROMPT_FILE");

  if (summaryPrompt && summaryPromptFile) {
    throw new Error("Configure either summaryPrompt or summaryPromptFile, not both.");
  }

  const resolvedSummaryPrompt = summaryPromptFile ? resolvePromptFile(summaryPromptFile) : summaryPrompt;
  const summaryPromptSource = summaryPromptFile ? summaryPromptFile : summaryPrompt ? "inline" : undefined;

  const chatBaseURL = provider === "cloud"
    ? readOption(mergedOptions.cloudLlmEndpoint, "CLOUD_LLM_ENDPOINT", "https://api.openai.com/v1")
    : readOption(mergedOptions.localLlmEndpoint, "LOCAL_LLM_ENDPOINT");
  const chatModel = provider === "cloud"
    ? readOption(mergedOptions.cloudChatModel, "CLOUD_CHAT_MODEL", "gpt-4o-mini")
    : readOption(mergedOptions.localChatModel, "LOCAL_CHAT_MODEL");
  const embedBaseURL = provider === "cloud"
    ? readOption(mergedOptions.cloudLlmEndpoint, "CLOUD_LLM_ENDPOINT", "https://api.openai.com/v1")
    : readOption(mergedOptions.localEmbedEndpoint, "LOCAL_EMBED_ENDPOINT");
  const embedModel = provider === "cloud"
    ? readOption(mergedOptions.cloudEmbedModel, "CLOUD_EMBED_MODEL", "text-embedding-3-small")
    : readOption(mergedOptions.localEmbedModel, "LOCAL_EMBED_MODEL");

  if (needs.chat && !chatBaseURL) {
    throw new Error(`Missing ${provider === "cloud" ? "cloud" : "local"} chat endpoint. Pass the runtime option or set ${provider === "cloud" ? "CLOUD_LLM_ENDPOINT" : "LOCAL_LLM_ENDPOINT"}.`);
  }
  if (needs.chat && !chatModel) {
    throw new Error(`Missing ${provider === "cloud" ? "cloud" : "local"} chat model. Pass the runtime option or set ${provider === "cloud" ? "CLOUD_CHAT_MODEL" : "LOCAL_CHAT_MODEL"}.`);
  }
  if (needs.embeddings && !embedBaseURL) {
    throw new Error(`Missing ${provider === "cloud" ? "cloud" : "local"} embedding endpoint. Pass the runtime option or set ${provider === "cloud" ? "CLOUD_LLM_ENDPOINT" : "LOCAL_EMBED_ENDPOINT"}.`);
  }
  if (needs.embeddings && !embedModel) {
    throw new Error(`Missing ${provider === "cloud" ? "cloud" : "local"} embedding model. Pass the runtime option or set ${provider === "cloud" ? "CLOUD_EMBED_MODEL" : "LOCAL_EMBED_MODEL"}.`);
  }
  if (provider === "cloud" && (needs.chat || needs.embeddings) && !apiKey) {
    throw new Error("Missing OpenAI API key. Pass --openai-api-key or set OPENAI_API_KEY.");
  }

  return {
    baseDir: readOption(mergedOptions.baseDir, "DIFFDOC_BASE_DIR", "./.diffdoc"),
    provider,
    chat: {
      apiKey,
      baseURL: chatBaseURL,
      model: chatModel
    },
    embeddings: {
      apiKey,
      baseURL: embedBaseURL,
      model: embedModel,
      batchSize: embedBatchSize
    },
    summarize: {
      includeGlobs,
      excludeGlobs,
      ignoreFile,
      concurrency: summarizeConcurrency,
      summaryPrompt,
      summaryPromptFile,
      resolvedSummaryPrompt,
      summaryPromptSource
    }
  };
}
