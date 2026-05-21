# DiffDoc

## Project Description

DiffDoc turns source code into searchable, plain-English project context. It scans repository files, asks an OpenAI-compatible chat model to summarize the business behavior in each file, stores those summaries in a portable JSON manifest, embeds the manifest into a local Vectra index, and answers questions using the indexed results as retrieval context.

The project is designed for teams that need fast codebase comprehension without requiring every stakeholder to read implementation details. It can run against local model servers such as Ollama, LM Studio, or vLLM, or against cloud OpenAI-compatible APIs.

## Installation

Run from this repository:

```bash
npm install
npm run build
node dist/index.js --help
```

Run after publishing:

```bash
npx diffdoc --help
```

Use as a project dev dependency:

```bash
npm install --save-dev diffdoc
npx diffdoc --help
```

Package scripts can call the installed binary:

```json
{
  "scripts": {
    "diffdoc:summarize": "diffdoc summarize",
    "diffdoc:embed": "diffdoc embed",
    "diffdoc:search": "diffdoc search",
    "diffdoc:query": "diffdoc query"
  }
}
```

## Configuration

DiffDoc accepts runtime flags on each command. It also loads a JSON `.diffdocrc` file from the current working directory when present, or from a custom path with `--config <path>`.

Precedence:

1. CLI flags
2. `.diffdocrc`
3. Environment variable fallbacks

Create a local config from the example:

```bash
cp .diffdocrc.example .diffdocrc
```

Example config with all supported keys:

```json
{
  "baseDir": "./.diffdoc",
  "aiProvider": "local",
  "localLlmEndpoint": "http://localhost:11434/v1",
  "localEmbedEndpoint": "http://localhost:11434/v1/embeddings",
  "localChatModel": "qwen2.5-coder:7b",
  "localEmbedModel": "nomic-embed-code",
  "cloudLlmEndpoint": "https://api.openai.com/v1",
  "cloudChatModel": "gpt-4o-mini",
  "cloudEmbedModel": "text-embedding-3-small",
  "openaiApiKey": ""
}
```

Supported environment fallbacks use the uppercase names for the same settings, including `AI_PROVIDER`, `DIFFDOC_BASE_DIR`, `LOCAL_LLM_ENDPOINT`, `LOCAL_EMBED_ENDPOINT`, `LOCAL_CHAT_MODEL`, `LOCAL_EMBED_MODEL`, `CLOUD_LLM_ENDPOINT`, `CLOUD_CHAT_MODEL`, `CLOUD_EMBED_MODEL`, and `OPENAI_API_KEY`.

## Manifest-First Design

DiffDoc separates summarization from embedding. The `summarize` command writes all generated file summaries to `manifest.json` under `baseDir`, usually `./.diffdoc/manifest.json`.

The manifest is plain JSON and contains one entry per tracked file:

```json
{
  "lastSyncedCommit": "string-hash",
  "files": {
    "src/example.ts": {
      "hash": "md5-string",
      "summaryText": "Plain-English explanation text here.",
      "rawCodeSnapshot": "Full code text here..."
    }
  }
}
```

Because the summaries are stored independently, users do not have to embed immediately. They can review, archive, transform, or embed the manifest later using their preferred vectorization model and storage solution.

DiffDoc includes `diffdoc embed` as a built-in convenience path for creating a local Vectra index, but the manifest can also be consumed by other tools such as custom OpenAI-compatible embedding pipelines, hosted vector databases, local search systems, or internal documentation workflows.

## Commands

Summarize a repository into `./.diffdoc/manifest.json`:

```bash
diffdoc summarize --path . --mode all
```

Summarize only changed Git files using the existing manifest state:

```bash
diffdoc summarize --path . --mode delta
```

Embed the manifest into a local Vectra index at `./.diffdoc/vectra`:

```bash
diffdoc embed
```

Search the local Vectra index and print raw matches:

```bash
diffdoc search "How does this project process changed files?"
```

Include retrieved code snapshots in search results:

```bash
diffdoc search "How does embedding work?" --top 3 --code
```

Ask a question and have the configured chat model answer using retrieved embedded context:

```bash
diffdoc query "How does this project process changed files?"
```

Include retrieved code snapshots after the generated answer:

```bash
diffdoc query "How does embedding work?" --top 3 --code
```

Prompt the configured chat model directly:

```bash
diffdoc prompt "Confirm the configured model is reachable."
```

Use a custom config file:

```bash
diffdoc query "How does embedding work?" --config ./config/diffdoc.local.json
```

Override a config value at runtime:

```bash
diffdoc embed --config ./.diffdocrc --base-dir ./tmp-diffdoc
```

## Workflow

Typical usage is:

```bash
diffdoc summarize --path . --mode all
diffdoc embed
diffdoc search "What files explain the summarization flow?"
diffdoc query "What business behavior does this repository implement?"
```

After the initial run, use delta mode to refresh changed files:

```bash
diffdoc summarize --path . --mode delta
diffdoc embed
```

## Notes

- Node.js `>=22` is required because Vectra requires it.
- This repository ignores `.diffdoc/vectra` and `.diffdocrc`; add similar entries to your project's `.gitignore` if you do not want generated indexes or local config committed. The manifest at `.diffdoc/manifest.json` is not ignored by this repository.
- Commit `.diffdoc/manifest.json` when using delta workflows. Delta summarization reads the previous manifest state to decide which changed files need fresh summaries.
- `summarize` requires a configured chat model.
- `embed` requires a configured embedding model.
- `search` requires a configured embedding model and returns raw retrieval results without calling the chat model.
- `query` requires both a configured chat model and embedding model.
- For code-oriented embedding models such as `nomic-embed-code`, DiffDoc prefixes query embeddings with `Represent this query for searching relevant code:`.
