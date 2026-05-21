# DiffDoc

DiffDoc is a CLI-first codebase comprehension pipeline. It summarizes source files into a portable manifest, embeds those summaries into a local Vectra index, and answers questions using the indexed context.

## Installation

Run from this repository:

```bash
npm install
npm run build
node dist/index.js --help
```

Run as a package after publishing:

```bash
npx diffdoc --help
```

Use as a project dev dependency:

```bash
npm install --save-dev diffdoc
npx diffdoc --help
```

You can also add package scripts:

```json
{
  "scripts": {
    "diffdoc:summarize": "diffdoc summarize",
    "diffdoc:embed": "diffdoc embed",
    "diffdoc:query": "diffdoc query"
  }
}
```

## Configuration

DiffDoc accepts runtime flags on every command. It can also load a JSON `.diffdocrc` file from the current working directory, or from a custom path using `--config <path>`.

Precedence:

1. CLI flags
2. `.diffdocrc`
3. Environment variable fallbacks

Copy the example config:

```bash
cp .diffdocrc.example .diffdocrc
```

Example local config:

```json
{
  "baseDir": "./.diffdoc",
  "aiProvider": "local",
  "localLlmEndpoint": "http://10.69.1.191:8080/v1",
  "localEmbedEndpoint": "http://10.69.1.191:8080/v1/embeddings",
  "localChatModel": "Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf",
  "localEmbedModel": "nomic-embed-code.Q8_0.gguf",
  "cloudLlmEndpoint": "https://api.openai.com/v1",
  "cloudChatModel": "gpt-4o-mini",
  "cloudEmbedModel": "text-embedding-3-small",
  "openaiApiKey": ""
}
```

## Commands

Summarize a repo into `./.diffdoc/manifest.json`:

```bash
diffdoc summarize --path . --mode all
```

Embed the manifest into a local Vectra index at `./.diffdoc/vectra`:

```bash
diffdoc embed
```

Ask a question using retrieved embedded context:

```bash
diffdoc query "How does this project process changed files?"
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

## Notes

- Node.js `>=22` is required because Vectra requires it.
- `.diffdoc/` and `.diffdocrc` are ignored by git by default.
- For local OpenAI-compatible embedding models such as `nomic-embed-code`, DiffDoc prefixes query embeddings with `Represent this query for searching relevant code:`.
