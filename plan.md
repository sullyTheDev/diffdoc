# Implementation Plan: DiffDoc (V1 Tracer Bullet)

DiffDoc is a modular, CLI-first codebase comprehension pipeline that bridges the gap between raw code changes and non-technical stakeholder visibility. It uses a **Summary-First RAG** architecture: it intercepts code adjustments via Git deltas, executes file-level processing, and leverages local or cloud LLMs via an OpenAI-compatible API to generate plain-English business logic snapshots. These snapshots are saved to a portable JSON manifest before being indexed into a local vector storage engine.

---

## 1. Core Architectural Constraints

* **Language & Runtime:** TypeScript compiled to CommonJS targeting Node.js (ES2022).
* **No Orchestration Frameworks:** Absolute ban on LangChain or similar libraries. Use native vendor SDKs (`openai` package, `chromadb` package) directly.
* **Decoupled Multi-Pass Pipeline:**
    * `summarize` command: Processes codebase text, interacts with LLM, updates a local JSON file snapshot.
    * `embed` command: Reads the local JSON snapshot file, calculates mathematical arrays, ingests to database rows.
* **API Agnosticism:** Must support seamless hot-swapping between public cloud models and local offline model engines (Ollama/LM Studio) via simple environment configurations.

---

## 2. Directory Layout & Workspace Design

The agent must create and maintain the following structural workspace geometry exactly:

```text
diffdoc/
├── dist/                     # Compiled JavaScript outputs (tsc target)
├── src/
│   ├── commands/
│   │   ├── summarize.ts      # Tracks file filesystem changes, handles LLM translation
│   │   └── embed.ts          # Reads manifest, updates local ChromaDB collection
│   ├── utils/
│   │   ├── git.ts            # Simple-git integration logic wrappers
│   │   ├── hashing.ts        # Fast crypto MD5 calculation for file tracking
│   │   └── llm.ts            # Abstracted OpenAI API client initialization
│   └── index.ts              # System CLI Entry point (Commander orchestration)
├── .env                      # Connection endpoints and runtime parameters
├── package.json              # Direct dependency registry
└── tsconfig.json             # TypeScript compiler properties
```

---

## 3. Configuration Blueprints

The agent should initialize the base project configuration profiles exactly as specified below:

### package.json
```json
{
  "name": "diffdoc",
  "version": "0.1.0",
  "description": "Translate repository code shifts into plain-English business context",
  "main": "dist/index.js",
  "type": "commonjs",
  "bin": {
    "diffdoc": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "tsc && node ./dist/index.js"
  },
  "dependencies": {
    "chromadb": "^1.9.0",
    "commander": "^12.0.0",
    "dotenv": "^16.4.5",
    "openai": "^4.28.0",
    "simple-git": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.3.3"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

### .env
```ini
# --- ENGINE ROUTING TOGGLE ---
# Options: "local" (Ollama, LM Studio, vLLM) or "cloud" (Official OpenAI)
AI_PROVIDER=local

# --- LOCAL OFFLINE ENGINE ARCHITECTURE ---
LOCAL_LLM_ENDPOINT=http://localhost:11434/v1
LOCAL_EMBED_ENDPOINT=http://localhost:11434/v1/embeddings
LOCAL_CHAT_MODEL=qwen2.5-coder:7b
LOCAL_EMBED_MODEL=nomic-embed-text

# --- CLOUD PRODUCTION ENGINE ARCHITECTURE ---
CLOUD_LLM_ENDPOINT=https://api.openai.com/v1
CLOUD_CHAT_MODEL=gpt-4o-mini
CLOUD_EMBED_MODEL=text-embedding-3-small
OPENAI_API_KEY=sk-proj-YourActualCloudKeyHere
```

---

## 4. Execution Step Sequence

The agent must implement the system in four progressive, incremental phases. Do not advance to the next step until all behaviors in the current step are fully verified.

### Step 1: Utility Foundations (`src/utils/`)
* **`hashing.ts`**: Create an exported function that reads a file string and calculates a standard `crypto.createHash('md5')` string.
* **`git.ts`**: Wrap the `simple-git` instance to create an async function `getGitDeltas(repoPath: string, sinceRef: string)` that returns arrays of modified/added and deleted files matching target code extensions (`.ts`, `.js`, `.cs`, `.py`).
* **`llm.ts`**: Implement the abstracted `generateFunctionalSummary(fileName: string, codeContent: string)` method using a native conditional router over the `.env` configuration keys (`AI_PROVIDER`). Ensure the system prompt enforces **plain-English, jargon-free business logic capturing with zero conversational preamble**.

### Step 2: The Command Line Interface (`src/index.ts`)
* Implement `commander` argument layouts to expose two main actions:
    1.  `summarize` with flags: `--path` (default `.`), `--out` (default `./.repo-ctx.json`), and `--mode` (`all` or `delta`).
    2.  `embed` with flags: `--manifest` (default `./.repo-ctx.json`).
* Verify that flags are properly parsed and error paths output clear log feedback.

### Step 3: `summarize` Engine Logic (`src/commands/summarize.ts`)
* If **`mode === 'all'`**: Responsibly walk the specified code path directory (ignoring binary files, `node_modules`, `dist`, and lockfiles), calculate hashes, pass code text blocks to the LLM utility, and construct the initial manifest state.
* If **`mode === 'delta'`**: 
    1. Read the existing `.repo-ctx.json` file if present.
    2. Pull Git modified/deleted arrays from the utility engine layer.
    3. Prune deleted files from the JSON memory array object.
    4. For each modified file, compare its current filesystem hash against the manifest hash. If different, trigger an LLM replacement pass.
* Save the clean tracking manifest output back to disk:
```json
{
  "lastSyncedCommit": "string-hash",
  "files": {
    "src/example.ts": {
      "hash": "md5-string",
      "summaryText": "Plain English explanation text here.",
      "rawCodeSnapshot": "Full code text here..."
    }
  }
}
```

### Step 4: `embed` Engine Logic (`src/commands/embed.ts`)
* Initialize the native `ChromaClient` targeting `http://localhost:8000`.
* Initialize Chroma's built-in `OpenAIEmbeddingFunction` instance, setting the `openai_proxy_url` string conditional to `LOCAL_EMBED_ENDPOINT` if running under the local provider setting.
* Read the text objects from `.repo-ctx.json`. Batch process and insert them into the `diffdoc_summaries` collection. Map file paths directly to document `ids`, the business explanation string to `documents`, and copy the source code snapshot into the `metadatas` map layer.

---

## 5. Verification Checks for Agent

Before considering this task complete, the agent must verify:
1.  Running `npm run build` compiles clean JS outputs inside the `./dist` folder with no compiler errors.
2.  Executing the tool generates a perfectly formatted `.repo-ctx.json` manifest file without crashing.
3.  Toggling `AI_PROVIDER=local` successfully redirects the API requests to the local network port settings without requiring changes to the core code logic.
```