#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildRuntimeConfig, type RuntimeConfigNeeds, type RuntimeConfigOptions } from "./config";
import { answerFromIndex, getIndexStats, parseTopK, searchIndex } from "./services/retrieval";

const MCP_SERVER_VERSION = "0.1.1";

function readCliOptions(argv: string[]): RuntimeConfigOptions {
  const options: RuntimeConfigOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const nextValue = argv[i + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    i += 1;

    switch (key) {
      case "config":
        options.config = nextValue;
        break;
      case "base-dir":
        options.baseDir = nextValue;
        break;
      case "ai-provider":
        options.aiProvider = nextValue;
        break;
      case "local-llm-endpoint":
        options.localLlmEndpoint = nextValue;
        break;
      case "local-chat-model":
        options.localChatModel = nextValue;
        break;
      case "local-embed-endpoint":
        options.localEmbedEndpoint = nextValue;
        break;
      case "local-embed-model":
        options.localEmbedModel = nextValue;
        break;
      case "cloud-llm-endpoint":
        options.cloudLlmEndpoint = nextValue;
        break;
      case "cloud-chat-model":
        options.cloudChatModel = nextValue;
        break;
      case "cloud-embed-model":
        options.cloudEmbedModel = nextValue;
        break;
      case "openai-api-key":
        options.openaiApiKey = nextValue;
        break;
      default:
        throw new Error(`Unknown MCP option: --${key}.`);
    }
  }

  return options;
}

function buildConfig(options: RuntimeConfigOptions, needs: RuntimeConfigNeeds) {
  return buildRuntimeConfig(options, needs);
}

function jsonText(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

async function main(): Promise<void> {
  const runtimeOptions = readCliOptions(process.argv.slice(2));
  const server = new McpServer({
    name: "diffdoc",
    version: MCP_SERVER_VERSION
  });
  const toolServer = server as unknown as {
    registerTool: (name: string, config: unknown, cb: (args: Record<string, unknown>) => Promise<ReturnType<typeof jsonText>>) => void;
  };

  toolServer.registerTool("diffdoc_search", {
    title: "Search DiffDoc Index",
    description: "Search the local DiffDoc Vectra index and return raw matching files, summaries, and optional code snapshots.",
    inputSchema: {
      query: z.string().min(1).describe("Natural-language search query."),
      top: z.number().int().positive().optional().describe("Number of matches to return."),
      includeCode: z.boolean().optional().describe("Include raw code snapshots in the returned results.")
    }
  }, async ({ query, top = 5, includeCode = false }) => {
    const config = buildConfig(runtimeOptions, { embeddings: true });
    const results = await searchIndex(String(query), parseTopK(top as string | number), config);
    return jsonText({
      results: results.map((result) => ({
        filePath: result.filePath,
        score: result.score,
        hash: result.hash,
        summaryText: result.summaryText,
        rawCodeSnapshot: Boolean(includeCode) ? result.rawCodeSnapshot : undefined
      }))
    });
  });

  toolServer.registerTool("diffdoc_answer", {
    title: "Answer From DiffDoc Index",
    description: "Answer a question using retrieved DiffDoc index context and the configured chat model.",
    inputSchema: {
      question: z.string().min(1).describe("Question to answer using indexed DiffDoc context."),
      top: z.number().int().positive().optional().describe("Number of matches to retrieve before answering."),
      includeResults: z.boolean().optional().describe("Include full retrieved results in addition to answer and sources.")
    }
  }, async ({ question, top = 5, includeResults = false }) => {
    const config = buildConfig(runtimeOptions, { chat: true, embeddings: true });
    const answer = await answerFromIndex(String(question), parseTopK(top as string | number), config);
    return jsonText({
      answer: answer.answer,
      sources: answer.sources,
      results: Boolean(includeResults) ? answer.results : undefined
    });
  });

  toolServer.registerTool("diffdoc_index_stats", {
    title: "DiffDoc Index Stats",
    description: "Return the local DiffDoc Vectra index path, existence status, and indexed item count.",
    inputSchema: {}
  }, async () => {
    const config = buildConfig(runtimeOptions, { embeddings: false, chat: false });
    return jsonText(await getIndexStats(config));
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
