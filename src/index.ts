#!/usr/bin/env node
import { Command } from "commander";
import { buildRuntimeConfig, type RuntimeConfigOptions } from "./config";
import { runEmbed } from "./commands/embed";
import { runInit, type InitOptions } from "./commands/init";
import { runPrune } from "./commands/prune";
import { runQuery, runSearch } from "./commands/query";
import { runStatus } from "./commands/status";
import { runSummarize } from "./commands/summarize";
import { runValidate } from "./commands/validate";

const program = new Command();

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function addBaseOptions(command: Command): Command {
  return command
    .option("--config <path>", "path to .diffdocrc JSON config file")
    .option("--base-dir <path>", "DiffDoc artifact directory")
    .option("--ai-provider <provider>", "AI provider: local or cloud");
}

function addChatOptions(command: Command): Command {
  return command
    .option("--local-llm-endpoint <url>", "local OpenAI-compatible chat endpoint")
    .option("--local-chat-model <model>", "local chat model name")
    .option("--cloud-llm-endpoint <url>", "cloud OpenAI-compatible chat endpoint")
    .option("--cloud-chat-model <model>", "cloud chat model name")
    .option("--openai-api-key <key>", "OpenAI-compatible API key; falls back to OPENAI_API_KEY");
}

function addEmbeddingOptions(command: Command): Command {
  return command
    .option("--local-embed-endpoint <url>", "local OpenAI-compatible embeddings endpoint")
    .option("--local-embed-model <model>", "local embedding model name")
    .option("--cloud-embed-model <model>", "cloud embedding model name")
    .option("--embed-batch-size <count>", "number of summary documents to send per embeddings request");
}

function addCloudEndpointAndKeyOptions(command: Command): Command {
  return command
    .option("--cloud-llm-endpoint <url>", "cloud OpenAI-compatible endpoint")
    .option("--openai-api-key <key>", "OpenAI-compatible API key; falls back to OPENAI_API_KEY");
}

program
  .name("diffdoc")
  .description("Translate repository code shifts into plain-English business context")
  .version("0.6.4");

program
  .command("init")
  .description("Initialize DiffDoc configuration for this repository")
  .option("--yes", "use defaults without prompting", false)
  .option("--provider <provider>", "AI provider: local or cloud")
  .option("--config <path>", "path to .diffdocrc JSON config file")
  .option("--base-dir <path>", "DiffDoc artifact directory")
  .option("--force", "overwrite existing config file", false)
  .action(async (options: InitOptions) => {
    try {
      await runInit(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addChatOptions(addBaseOptions(program
  .command("summarize")))
  .description("Summarize repository code into a portable JSON manifest")
  .option("--path <path>", "repository or code path to scan", ".")
  .option("--out <path>", "manifest output path under --base-dir", "manifest.json")
  .option("--mode <mode>", "summarization mode: all or delta", "all")
  .option("--include-code-snapshot", "store raw code in summary assets", false)
  .option("--json", "print summarize report as JSON for CI", false)
  .option("--include-glob <pattern>", "include glob pattern (repeatable)", collectOption, [])
  .option("--exclude-glob <pattern>", "exclude glob pattern (repeatable)", collectOption, [])
  .option("--ignore-file <path>", "path to ignore pattern file relative to --path")
  .option("--summarize-concurrency <count>", "number of files to summarize concurrently")
  .option("--summary-prompt <text>", "additional instructions for summary generation")
  .option("--summary-prompt-file <path>", "path to additional summary prompt instructions")
  .option("--refresh", "regenerate summaries even when source and summary metadata are fresh", false)
  .action(async (options: RuntimeConfigOptions & {
    path: string;
    out: string;
    mode: string;
    includeCodeSnapshot: boolean;
    json: boolean;
    includeGlob: string[];
    excludeGlob: string[];
    ignoreFile?: string;
    refresh: boolean;
  }) => {
    try {
      const config = buildRuntimeConfig(options, { chat: true });
      await runSummarize({
        path: options.path,
        out: options.out,
        mode: options.mode as "all" | "delta",
        includeCodeSnapshot: options.includeCodeSnapshot,
        json: options.json,
        includeGlobs: options.includeGlob,
        excludeGlobs: options.excludeGlob,
        ignoreFile: options.ignoreFile,
        refresh: options.refresh
      }, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addEmbeddingOptions(addChatOptions(addBaseOptions(program
  .command("query"))))
  .description("Answer a question using retrieved local Vectra context")
  .argument("<message...>", "question or search text")
  .option("--top <count>", "number of matches to return", "5")
  .option("--code", "include code snapshots in results", false)
  .action(async (messageParts: string[], options: RuntimeConfigOptions & { top: string; code: boolean }) => {
    try {
      const config = buildRuntimeConfig(options, { chat: true, embeddings: true });
      await runQuery(messageParts.join(" "), options, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addCloudEndpointAndKeyOptions(addEmbeddingOptions(addBaseOptions(program
  .command("search"))))
  .description("Search the local Vectra index and print raw matches")
  .argument("<message...>", "search text")
  .option("--top <count>", "number of matches to return", "5")
  .option("--code", "include code snapshots in results", false)
  .action(async (messageParts: string[], options: RuntimeConfigOptions & { top: string; code: boolean }) => {
    try {
      const config = buildRuntimeConfig(options, { embeddings: true });
      await runSearch(messageParts.join(" "), options, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addCloudEndpointAndKeyOptions(addEmbeddingOptions(addBaseOptions(program
  .command("embed")))
)
  .description("Embed manifest summaries into a local Vectra index")
  .option("--manifest <path>", "manifest input path under --base-dir", "manifest.json")
  .option("--rebuild", "rebuild local index from scratch", false)
  .action(async (options: RuntimeConfigOptions & { manifest: string; rebuild: boolean }) => {
    try {
      const config = buildRuntimeConfig(options, { embeddings: true });
      await runEmbed({ manifest: options.manifest, rebuild: options.rebuild }, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addBaseOptions(program
  .command("status"))
  .description("Show manifest and index sync status")
  .option("--path <path>", "repository or code path to scan")
  .option("--manifest <path>", "manifest input path under --base-dir", "manifest.json")
  .option("--json", "print status as JSON for CI", false)
  .action(async (options: RuntimeConfigOptions & { path?: string; manifest: string; json: boolean }) => {
    try {
      const config = buildRuntimeConfig(options, { embeddings: false, chat: false });
      await runStatus({ path: options.path, manifest: options.manifest, json: options.json }, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addBaseOptions(program
  .command("prune"))
  .description("Remove manifest entries for deleted or excluded files")
  .option("--path <path>", "repository or code path to scan")
  .option("--manifest <path>", "manifest input path under --base-dir", "manifest.json")
  .option("--dry-run", "show what would be pruned without executing", false)
  .option("--yes", "skip confirmation prompt", false)
  .option("--json", "print prune report as JSON for CI", false)
  .action(async (options: RuntimeConfigOptions & { path?: string; manifest: string; dryRun: boolean; yes: boolean; json: boolean }) => {
    try {
      const config = buildRuntimeConfig(options, { embeddings: false, chat: false });
      await runPrune({ path: options.path, manifest: options.manifest, dryRun: options.dryRun, yes: options.yes, json: options.json }, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addBaseOptions(program
  .command("validate"))
  .description("Validate manifest and summary assets against JSON schemas")
  .option("--manifest <path>", "manifest input path under --base-dir", "manifest.json")
  .option("--json", "print validation report as JSON for CI", false)
  .action(async (options: RuntimeConfigOptions & { manifest: string; json: boolean }) => {
    try {
      const config = buildRuntimeConfig(options, { embeddings: false, chat: false });
      await runValidate({ manifest: options.manifest, json: options.json }, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
