#!/usr/bin/env node
import { Command } from "commander";
import { buildRuntimeConfig, type RuntimeConfigOptions } from "./config";
import { runEmbed } from "./commands/embed";
import { runQuery, runSearch } from "./commands/query";
import { runSummarize } from "./commands/summarize";
import { promptLlm } from "./utils/llm";

const program = new Command();

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
    .option("--cloud-embed-model <model>", "cloud embedding model name");
}

function addCloudEndpointAndKeyOptions(command: Command): Command {
  return command
    .option("--cloud-llm-endpoint <url>", "cloud OpenAI-compatible endpoint")
    .option("--openai-api-key <key>", "OpenAI-compatible API key; falls back to OPENAI_API_KEY");
}

program
  .name("diffdoc")
  .description("Translate repository code shifts into plain-English business context")
  .version("0.1.0");

addChatOptions(addBaseOptions(program
  .command("summarize")))
  .description("Summarize repository code into a portable JSON manifest")
  .option("--path <path>", "repository or code path to scan", ".")
  .option("--out <path>", "manifest output path under --base-dir", "manifest.json")
  .option("--mode <mode>", "summarization mode: all or delta", "all")
  .action(async (options: RuntimeConfigOptions & { path: string; out: string; mode: string }) => {
    try {
      const config = buildRuntimeConfig(options, { chat: true });
      await runSummarize({ path: options.path, out: options.out, mode: options.mode as "all" | "delta" }, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

addChatOptions(addBaseOptions(program
  .command("prompt")))
  .description("Send a plain prompt to the configured LLM")
  .argument("<message...>", "prompt text to send")
  .action(async (messageParts: string[], options: RuntimeConfigOptions) => {
    try {
      const config = buildRuntimeConfig(options, { chat: true });
      const response = await promptLlm(messageParts.join(" "), config.chat);
      console.log(response);
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
  .action(async (options: RuntimeConfigOptions & { manifest: string }) => {
    try {
      const config = buildRuntimeConfig(options, { embeddings: true });
      await runEmbed({ manifest: options.manifest }, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
