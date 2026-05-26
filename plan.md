# DiffDoc Refactor Plan (Scalable Per-File Summaries)

## 1. Objective

Refactor DiffDoc to scale across large codebases by:

- Generating and storing summaries as independent per-hash JSON files.
- Keeping summarization fully decoupled from embedding/indexing.
- Updating state incrementally and crash-safely, one file at a time.
- Preserving current CLI naming (`embed`) while changing internal data model.

This is a **breaking schema change** and does **not** include migration from the old manifest format.

---

## 2. Final Decisions (Locked)

1. Breaking schema change is acceptable; no migration path required.
2. Manifest maps `source_file -> content_hash`; summary files are hash-addressed.
3. Raw code snapshot storage is optional, default off.
4. Atomic write strategy is required.
5. Continue on per-file summarize errors; fail command at end if any failures.
6. No lockfile/concurrency control for now.
7. Embed/indexing should be incremental by default, with prune and optional rebuild.
8. Orphan summary cleanup happens immediately during summarize.
9. Add configurable include/exclude filtering plus `.diffdocignore`.
10. No binary/size safeguards for now (process everything).
11. Keep `embed` command name (no rename to `index`).

---

## 3. Target Artifact Architecture

All artifacts live under `.diffdoc/` in the target repo.

```text
target-repo/
└── .diffdoc/
    ├── manifest.json
    └── summaries/
        ├── <hash-a>.json
        └── <hash-b>.json
```

### 3.1 Manifest Schema (`.diffdoc/manifest.json`)

```json
{
  "schemaVersion": 2,
  "lastSyncedCommit": "optional-commit-sha-or-empty",
  "files": {
    "src/services/auth.ts": "a1b2c3d4e5f6...",
    "src/services/payment.ts": "f9e8d7c6b5a4..."
  }
}
```

### 3.2 Summary Asset Schema (`.diffdoc/summaries/<hash>.json`)

```json
{
  "schemaVersion": 1,
  "content_hash": "a1b2c3d4e5f6...",
  "summary": "Plain-English functional summary...",
  "raw_code_snapshot": "optional raw source text when enabled"
}
```

Notes:

- `raw_code_snapshot` is omitted unless `--include-code-snapshot` is enabled.
- Summary files are canonical by hash and do not own file-path mapping.

---

## 4. Command Behavior

### 4.1 `summarize`

Command:

```bash
diffdoc summarize --path . --mode all|delta [--include-code-snapshot]
```

Core behavior:

1. Load/create manifest v2.
2. Discover target files using default filters + configured include/exclude + `.diffdocignore`.
3. For each candidate file:
   - Read content
   - Hash content
   - Compare with manifest hash for that path
   - Skip unchanged
   - Summarize changed/new files
   - Write `.diffdoc/summaries/<newHash>.json` atomically
   - Update `manifest.files[path] = newHash`
   - Write manifest atomically immediately
4. In `delta` mode:
   - Remove deleted paths from manifest
   - Perform orphan cleanup for unreferenced old hashes
5. Track per-file failures; continue processing.
6. Exit non-zero if any failures occurred.

### 4.2 `embed`

Command:

```bash
diffdoc embed [--manifest manifest.json] [--rebuild]
```

Core behavior:

1. Load manifest v2.
2. If `--rebuild`, recreate index from scratch.
3. Otherwise:
   - Incrementally upsert current manifest paths using summary files.
   - Prune vectors for paths no longer present in manifest.
4. Keep query/search metadata compatibility.
5. Handle missing optional snapshot gracefully.

---

## 5. Filtering Strategy

Add support for:

- Default built-in filters (existing ignored dirs/files/extensions).
- `.diffdocignore` file (repo-local ignore patterns).
- Configurable include/exclude patterns (from CLI/config).

Resolution order:

1. Candidate from directory walk
2. Must match include rules (if provided)
3. Must not match exclude rules
4. Must not match `.diffdocignore`

---

## 6. Crash Safety and Error Handling

### Atomic Writes

Use temp-file + rename for:

- Manifest writes
- Summary asset writes

### Failure Policy

- Per-file summarize errors are collected and reported.
- Processing continues across remaining files.
- Command exits with non-zero status if any file failed.

---

## 7. Orphan Cleanup Rules

When a file path changes hash or is deleted:

- Old hash summary is deleted immediately **only if no remaining manifest path references that hash**.
- Must account for duplicate-content files (multiple paths sharing same hash).

---

## 8. Out of Scope (For Now)

- Backward compatibility/migration from old manifest schema.
- Locking/concurrency control for multiple summarize runs.
- Binary detection and max file-size/token guardrails.
- Command rename from `embed` to `index`.

---

## 9. Implementation Sequence

1. Introduce new artifact types and schemas (manifest v2 + summary assets).
2. Add CLI/config flags:
   - `summarize --include-code-snapshot`
   - `embed --rebuild`
   - include/exclude + ignore-file settings
3. Implement filtering pipeline with `.diffdocignore`.
4. Rewrite summarize flow to per-file summary assets + immediate manifest updates.
5. Add atomic write utilities and wire into summarize persistence.
6. Add per-file failure collection + final non-zero exit behavior.
7. Implement immediate orphan cleanup with hash reference checks.
8. Refactor embed for incremental upsert + prune + optional rebuild.
9. Update retrieval/query handling for optional snapshot metadata.
10. Update README/docs to match new breaking architecture.

---

## 10. Verification Checklist

- Fresh run creates manifest and per-hash summary files.
- No-change rerun skips unchanged files.
- Single-file change updates only that path/hash summary.
- File deletion removes manifest entry and deletes orphan summary when unreferenced.
- Duplicate-content paths do not delete shared hash prematurely.
- Embed default run updates incrementally and prunes removed paths.
- `embed --rebuild` performs full reindex.
- Summarize continues through file errors and exits non-zero if any failures exist.
