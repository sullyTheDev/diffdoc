# DiffDoc

Your codebase already knows how the product works. DiffDoc turns that implementation into a living, portable knowledgebase that humans and agents can search, question, and reuse.

It generates plain-English summaries from source files, records them in a manifest-first artifact model, and keeps the resulting context close to the repository. Use it to give developers, agents, reviewers, and stakeholders implementation-grounded answers without asking them to read every file first.

## Guiding Principles

- The codebase is the source of truth. Requirements documents, tickets, wikis, and tribal knowledge can drift, but product behavior is ultimately defined by the code that ships.
- Summaries should describe implemented behavior, not imagined intent. DiffDoc focuses on what the current files do so product questions are answered from the implementation first.
- The knowledgebase should evolve with the product. When files change, DiffDoc refreshes affected summaries and manifest entries so generated context does not become a stale snapshot.
- The manifest is the durable contract. DiffDoc is intentionally manifest-first: the manifest is the source of truth for generated summaries, and downstream tools should be able to consume the manifest and summary assets without depending on DiffDoc's built-in embedding workflow.
- Retrieval is optional infrastructure. The built-in `embed` command, local Vectra index, `search`, `query`, and MCP server are convenience features for teams that want an end-to-end local workflow, but consumers should be free to use their own embedding provider, vector store, search system, or documentation pipeline.
- Useful context should serve humans and agents. The generated knowledgebase is intended for product questions, onboarding, code review, agent workflows, audits, and long-term maintenance.

## Requirements

- Node.js `>=22`
- An OpenAI-compatible chat model for `summarize` and `query`
- An OpenAI-compatible embedding model for `embed`, `search`, and `query`
- A local model server such as Ollama, LM Studio, or vLLM, or a cloud OpenAI-compatible endpoint

## Install

Run DiffDoc without adding it to your project:

```bash
npx diffdoc --help
```

Install it as a project dev dependency:

```bash
npm install --save-dev diffdoc
```

Recommended package scripts:

```json
{
  "scripts": {
    "diffdoc:init": "diffdoc init",
    "diffdoc:summarize": "diffdoc summarize",
    "diffdoc:embed": "diffdoc embed",
    "diffdoc:search": "diffdoc search",
    "diffdoc:query": "diffdoc query",
    "diffdoc:status": "diffdoc status",
    "diffdoc:mcp": "diffdoc-mcp"
  }
}
```

## Quick Start

Initialize DiffDoc in your repository:

```bash
npx diffdoc init
```

For a non-interactive setup using defaults:

```bash
npx diffdoc init --yes
```

Create summaries:

```bash
npx diffdoc summarize --path . --mode all
```

Build the local search index:

```bash
npx diffdoc embed
```

Search raw matches:

```bash
npx diffdoc search "How does authentication work?"
```

Ask a question using retrieved project context:

```bash
npx diffdoc query "What business behavior does this repository implement?"
```

After the first full run, refresh changed files with delta mode:

```bash
npx diffdoc summarize --path . --mode delta
npx diffdoc embed
```

## What Init Creates

`diffdoc init` creates or updates repository-local setup files:

- `.diffdocrc`: local DiffDoc configuration
- `.diffdocignore`: gitignore-style file selection rules for summarization
- `.gitignore`: entries for local/generated DiffDoc files when needed

It does not summarize or embed anything. Run `summarize` and `embed` after initialization.

## Configuration

DiffDoc reads settings in this order:

1. CLI flags
2. `.diffdocrc` or the file passed with `--config <path>`
3. Environment variables
4. Built-in defaults

Example `.diffdocrc` for local models:

```json
{
  "baseDir": "./.diffdoc",
  "aiProvider": "local",
  "localLlmEndpoint": "http://localhost:11434/v1",
  "localEmbedEndpoint": "http://localhost:11434/v1/embeddings",
  "localChatModel": "qwen2.5-coder:7b",
  "localEmbedModel": "nomic-embed-code",
  "embedBatchSize": 25,
  "includeGlobs": [],
  "excludeGlobs": [],
  "ignoreFile": ".diffdocignore"
}
```

Example `.diffdocrc` for a cloud OpenAI-compatible endpoint:

```json
{
  "baseDir": "./.diffdoc",
  "aiProvider": "cloud",
  "cloudLlmEndpoint": "https://api.openai.com/v1",
  "cloudChatModel": "gpt-4o-mini",
  "cloudEmbedModel": "text-embedding-3-small",
  "embedBatchSize": 25,
  "includeGlobs": [],
  "excludeGlobs": [],
  "ignoreFile": ".diffdocignore"
}
```

Set `OPENAI_API_KEY` for cloud providers instead of committing API keys:

```bash
OPENAI_API_KEY="..." npx diffdoc summarize --path . --mode all
```

Supported environment variables:

```text
AI_PROVIDER
DIFFDOC_BASE_DIR
DIFFDOC_EMBED_BATCH_SIZE
DIFFDOC_INCLUDE_GLOBS
DIFFDOC_EXCLUDE_GLOBS
DIFFDOC_IGNORE_FILE
LOCAL_LLM_ENDPOINT
LOCAL_CHAT_MODEL
LOCAL_EMBED_ENDPOINT
LOCAL_EMBED_MODEL
CLOUD_LLM_ENDPOINT
CLOUD_CHAT_MODEL
CLOUD_EMBED_MODEL
OPENAI_API_KEY
```

## File Selection

`.diffdocignore` uses `.gitignore`-style syntax. This is the main way to keep generated files, dependencies, secrets, binaries, and local artifacts out of summaries.

Example `.diffdocignore`:

```gitignore
.git/
.diffdoc/
node_modules/
dist/
coverage/
.env
*.log
```

Precedence is intentionally conservative:

1. `.diffdocignore` skips files first
2. `excludeGlobs` skip files second
3. `includeGlobs` narrow whatever remains

An included file is still skipped if it matches `.diffdocignore` or `excludeGlobs`.

Use include and exclude filters from config:

```json
{
  "includeGlobs": ["src/**/*.ts"],
  "excludeGlobs": ["**/*.test.ts"]
}
```

Or pass them at runtime:

```bash
npx diffdoc summarize --path . --mode all --include-glob "src/**/*.ts" --exclude-glob "**/*.test.ts"
```

## Commands

Initialize setup files:

```bash
npx diffdoc init
npx diffdoc init --yes
npx diffdoc init --provider cloud --force
```

Summarize files into `.diffdoc/manifest.json` and `.diffdoc/summaries/*.json`:

```bash
npx diffdoc summarize --path . --mode all
npx diffdoc summarize --path . --mode delta
npx diffdoc summarize --path . --mode delta --json
```

Store raw code snapshots in summary assets when you want retrieved results to include source text:

```bash
npx diffdoc summarize --path . --mode all --include-code-snapshot
```

Check manifest and index freshness:

```bash
npx diffdoc status
npx diffdoc status --json
```

Embed summaries into the local Vectra index:

```bash
npx diffdoc embed
npx diffdoc embed --rebuild
npx diffdoc embed --embed-batch-size 20
```

Search indexed summaries:

```bash
npx diffdoc search "How does this project process changed files?"
npx diffdoc search "How does embedding work?" --top 3 --code
```

Ask questions with retrieval-augmented answers:

```bash
npx diffdoc query "How does this project process changed files?"
npx diffdoc query "How does embedding work?" --top 3 --code
```

Use a custom config or artifact directory:

```bash
npx diffdoc query "How does embedding work?" --config ./config/diffdoc.local.json
npx diffdoc embed --config ./.diffdocrc --base-dir ./tmp-diffdoc
```

## Artifacts

DiffDoc keeps generated project context under `baseDir`, which defaults to `./.diffdoc`:

```text
.diffdoc/
  manifest.json
  summaries/
    <content-hash>.json
  vectra/
```

The manifest maps repository-relative file paths to content hashes:

```json
{
  "schemaVersion": 2,
  "lastSyncedCommit": "string-hash",
  "files": {
    "src/example.ts": "md5-string"
  }
}
```

Each summary asset is portable JSON:

```json
{
  "schemaVersion": 1,
  "content_hash": "md5-string",
  "summary": "Plain-English explanation text here.",
  "raw_code_snapshot": "Optional code text when --include-code-snapshot is enabled"
}
```

Commit `.diffdoc/manifest.json` and `.diffdoc/summaries/*.json` if you want summaries shared across machines or CI runs. Keep `.diffdoc/vectra/` local unless you have a specific reason to commit the generated vector index.

The manifest and summary assets are the stable handoff point for consumers. The local Vectra index produced by `diffdoc embed` is optional and can be replaced by any embedding model and storage backend that fits your environment.

## MCP Server

DiffDoc ships an MCP stdio server as `diffdoc-mcp`. Run `summarize` and `embed` before using it so the MCP tools have a local index to query.

Run the server manually:

```bash
npx diffdoc-mcp --config ./.diffdocrc
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "diffdoc": {
      "command": "npx",
      "args": ["diffdoc-mcp", "--config", "./.diffdocrc"]
    }
  }
}
```

Available MCP tools:

- `diffdoc_search`: search the local index and return matching files, summaries, scores, hashes, and optional code snapshots
- `diffdoc_answer`: retrieve relevant context and ask the configured chat model to answer a question
- `diffdoc_index_stats`: return index path, existence status, and indexed item count

## CI

For CI, prefer environment variables or a generated config file instead of committing local credentials.

Typical CI flow:

```bash
npm ci
npx diffdoc summarize --path . --mode delta --json
npx diffdoc embed
```

Use `summarize --json` and `status --json` when a workflow needs machine-readable output.

Commit the manifest and summary assets from CI if you want DiffDoc state to advance with the branch. Ignore `.diffdoc/vectra/` unless your workflow intentionally persists the local index.

## Notes

- `summarize` requires a configured chat model.
- `embed` and `search` require a configured embedding model.
- `query` requires both chat and embedding configuration.
- `status` does not require chat or embedding configuration.
- Delta summarization uses Git changes plus the existing manifest state.
- Manifest schema is currently `schemaVersion: 2`; older manifest shapes are not auto-migrated.
- For code-oriented embedding models such as `nomic-embed-code`, DiffDoc prefixes query embeddings with `Represent this query for searching relevant code:`.
