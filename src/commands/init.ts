import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type InitProvider = "local" | "cloud";

export interface InitOptions {
  yes: boolean;
  provider?: string;
  config?: string;
  baseDir?: string;
  force: boolean;
}

interface DiffdocRc {
  baseDir: string;
  aiProvider: InitProvider;
  localLlmEndpoint: string;
  localEmbedEndpoint: string;
  localChatModel: string;
  localEmbedModel: string;
  cloudLlmEndpoint: string;
  cloudChatModel: string;
  cloudEmbedModel: string;
  openaiApiKey: string;
  summarizeConcurrency: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  ignoreFile: string;
}

interface InitSummary {
  created: string[];
  updated: string[];
  skipped: string[];
  warnings: string[];
}

const DEFAULT_CONFIG: DiffdocRc = {
  baseDir: "./.diffdoc",
  aiProvider: "local",
  localLlmEndpoint: "http://localhost:11434/v1",
  localEmbedEndpoint: "http://localhost:11434/v1/embeddings",
  localChatModel: "qwen2.5-coder:7b",
  localEmbedModel: "nomic-embed-code",
  cloudLlmEndpoint: "https://api.openai.com/v1",
  cloudChatModel: "gpt-4o-mini",
  cloudEmbedModel: "text-embedding-3-small",
  openaiApiKey: "",
  summarizeConcurrency: 2,
  includeGlobs: [],
  excludeGlobs: [],
  ignoreFile: ".diffdocignore"
};

function parseProvider(value: string | undefined, fallback: InitProvider): InitProvider {
  const provider = value || fallback;
  if (provider !== "local" && provider !== "cloud") {
    throw new Error('Invalid init provider. Expected "local" or "cloud".');
  }
  return provider;
}

function parseCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function toDisplayPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function resolveRepoPath(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}

function relativeToRepo(absolutePath: string): string {
  const relative = path.relative(process.cwd(), absolutePath) || ".";
  return toDisplayPath(relative);
}

function normalizeRepoPattern(value: string): string {
  return toDisplayPath(value.trim())
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readExistingConfig(configPath: string): Promise<Partial<DiffdocRc>> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<DiffdocRc>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function promptText(rl: ReturnType<typeof createInterface>, question: string, fallback: string): Promise<string> {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function promptBoolean(rl: ReturnType<typeof createInterface>, question: string, fallback: boolean): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} (${suffix}): `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

async function buildInteractiveConfig(options: InitOptions, existing: Partial<DiffdocRc>): Promise<DiffdocRc> {
  const rl = createInterface({ input, output });
  try {
    const fallbackProvider = parseProvider(existing.aiProvider, "local");
    const provider = parseProvider(
      options.provider || await promptText(rl, "AI provider: local or cloud", fallbackProvider),
      fallbackProvider
    );
    const baseDir = options.baseDir || await promptText(rl, "DiffDoc artifact directory", existing.baseDir || DEFAULT_CONFIG.baseDir);
    const ignoreFile = await promptText(rl, "Ignore file path", existing.ignoreFile || DEFAULT_CONFIG.ignoreFile);
    const includeGlobs = parseCsv(await promptText(rl, "Include globs, comma-separated", (existing.includeGlobs || []).join(",")));
    const excludeGlobs = parseCsv(await promptText(rl, "Exclude globs, comma-separated", (existing.excludeGlobs || []).join(",")));

    const config: DiffdocRc = {
      ...DEFAULT_CONFIG,
      ...existing,
      baseDir,
      aiProvider: provider,
      ignoreFile,
      includeGlobs,
      excludeGlobs
    };

    if (provider === "local") {
      config.localLlmEndpoint = await promptText(rl, "Local chat endpoint", config.localLlmEndpoint || DEFAULT_CONFIG.localLlmEndpoint);
      config.localChatModel = await promptText(rl, "Local chat model", config.localChatModel || DEFAULT_CONFIG.localChatModel);
      config.localEmbedEndpoint = await promptText(rl, "Local embedding endpoint", config.localEmbedEndpoint || DEFAULT_CONFIG.localEmbedEndpoint);
      config.localEmbedModel = await promptText(rl, "Local embedding model", config.localEmbedModel || DEFAULT_CONFIG.localEmbedModel);
    } else {
      config.cloudLlmEndpoint = await promptText(rl, "Cloud OpenAI-compatible endpoint", config.cloudLlmEndpoint || DEFAULT_CONFIG.cloudLlmEndpoint);
      config.cloudChatModel = await promptText(rl, "Cloud chat model", config.cloudChatModel || DEFAULT_CONFIG.cloudChatModel);
      config.cloudEmbedModel = await promptText(rl, "Cloud embedding model", config.cloudEmbedModel || DEFAULT_CONFIG.cloudEmbedModel);
      if (await promptBoolean(rl, "Store OPENAI_API_KEY in config file", false)) {
        config.openaiApiKey = await promptText(rl, "OpenAI-compatible API key", config.openaiApiKey || "");
      } else {
        config.openaiApiKey = "";
      }
    }

    return config;
  } finally {
    rl.close();
  }
}

function buildYesConfig(options: InitOptions, existing: Partial<DiffdocRc>): DiffdocRc {
  return {
    ...DEFAULT_CONFIG,
    ...existing,
    baseDir: options.baseDir || existing.baseDir || DEFAULT_CONFIG.baseDir,
    aiProvider: parseProvider(options.provider || existing.aiProvider, "local"),
    openaiApiKey: ""
  };
}

async function writeJsonFile(filePath: string, value: unknown, summary: InitSummary, force: boolean): Promise<void> {
  const exists = await fileExists(filePath);
  if (exists && !force) {
    summary.skipped.push(relativeToRepo(filePath));
    summary.warnings.push(`${relativeToRepo(filePath)} already exists; pass --force to overwrite.`);
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  (exists ? summary.updated : summary.created).push(relativeToRepo(filePath));
}

function buildStarterIgnore(baseDir: string): string {
  const normalizedBaseDir = normalizeRepoPattern(baseDir);
  return [
    "# DiffDoc ignore patterns",
    "node_modules/**",
    ".git/**",
    `${normalizedBaseDir}/**`,
    "dist/**",
    ""
  ].join("\n");
}

async function createIgnoreFile(ignorePath: string, config: DiffdocRc, summary: InitSummary): Promise<void> {
  if (await fileExists(ignorePath)) {
    summary.skipped.push(relativeToRepo(ignorePath));
    return;
  }

  await fs.writeFile(ignorePath, buildStarterIgnore(config.baseDir), "utf8");
  summary.created.push(relativeToRepo(ignorePath));
}

function buildGitignoreEntries(configPath: string, config: DiffdocRc): string[] {
  const configRelative = normalizeRepoPattern(relativeToRepo(configPath));
  const baseDir = normalizeRepoPattern(config.baseDir);
  return [`${baseDir}/vectra/`, configRelative];
}

async function updateGitignore(configPath: string, config: DiffdocRc, summary: InitSummary): Promise<void> {
  const gitignorePath = resolveRepoPath(".gitignore");
  const entries = buildGitignoreEntries(configPath, config);
  let existing = "";
  let exists = false;
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
    exists = true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;
  }

  const existingLines = new Set(existing.split(/\r?\n/).map(normalizeRepoPattern).filter(Boolean));
  const missing = entries.filter((entry) => !existingLines.has(normalizeRepoPattern(entry)));
  if (missing.length === 0) {
    summary.skipped.push(".gitignore");
    return;
  }

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignorePath, `${existing}${prefix}${missing.join("\n")}\n`, "utf8");
  (exists ? summary.updated : summary.created).push(".gitignore");
}

function printList(label: string, values: string[]): void {
  console.log(`${label}: ${values.length > 0 ? values.join(", ") : "none"}`);
}

export async function runInit(options: InitOptions): Promise<void> {
  const summary: InitSummary = { created: [], updated: [], skipped: [], warnings: [] };
  const configPath = resolveRepoPath(options.config || ".diffdocrc");
  const existingConfig = await readExistingConfig(configPath);
  const config = options.yes
    ? buildYesConfig(options, existingConfig)
    : await buildInteractiveConfig(options, existingConfig);
  const ignorePath = resolveRepoPath(config.ignoreFile || ".diffdocignore");

  await writeJsonFile(configPath, config, summary, options.force);
  await createIgnoreFile(ignorePath, config, summary);
  await updateGitignore(configPath, config, summary);

  console.log("DiffDoc init complete.");
  console.log("");
  console.log("Init changes:");
  printList("Created", summary.created);
  printList("Updated", summary.updated);
  printList("Skipped", summary.skipped);
  printList("Warnings", summary.warnings);
  console.log("");
  console.log("Next commands:");
  console.log("1. diffdoc summarize --path . --mode all");
  console.log("2. diffdoc embed");
  console.log("3. diffdoc status");
}
