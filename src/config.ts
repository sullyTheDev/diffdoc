import fs from "node:fs";
import path from "node:path";

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
}

export interface SummarizeFilterConfig {
  includeGlobs: string[];
  excludeGlobs: string[];
  ignoreFile: string;
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
  openaiApiKey?: string;
  includeGlobs?: string[] | string;
  excludeGlobs?: string[] | string;
  ignoreFile?: string;
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

  return parsed as RuntimeConfigOptions;
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
  const includeGlobs = readListOption(mergedOptions.includeGlobs, "DIFFDOC_INCLUDE_GLOBS");
  const excludeGlobs = readListOption(mergedOptions.excludeGlobs, "DIFFDOC_EXCLUDE_GLOBS");
  const ignoreFile = readOption(mergedOptions.ignoreFile, "DIFFDOC_IGNORE_FILE", ".diffdocignore");

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
      model: embedModel
    },
    summarize: {
      includeGlobs,
      excludeGlobs,
      ignoreFile
    }
  };
}
