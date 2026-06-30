# Design Doc: File-Based Agent Memory

| Field  | Value          |
|--------|----------------|
| Status | Proposed       |
| Date   | June 12, 2026  |
| Issue  | TBD            |
| Scope  | TypeScript SDK |

---

## Context

The Strands SDK has no local memory store. The existing store implementation, `BedrockKnowledgeBaseStore`, requires provisioned AWS infrastructure (Bedrock Knowledge Base, credentials, optional S3). This is well-suited for production and enterprise deployments where teams already have AWS infrastructure, but developers who want to prototype, run integration tests, or experiment with agent memory in non-production environments have no option that works without standing up a managed service. `FileMemoryStore` fills this gap: a local store that requires zero external infrastructure, just a filesystem.

Separately, any long-lived memory system needs a maintenance mechanism. As memory accumulates over extended interactions, quality degrades — redundancy grows, contradictions go unresolved, and retrieval becomes less reliable. Managed stores like `BedrockKnowledgeBaseStore` handle this server-side — deduplication, indexing, and retrieval quality are responsibilities of the backend service. This works because the infrastructure runs outside the agent loop: it can process knowledge asynchronously, build embeddings, and serve semantic search without adding latency to agent sessions. A local store needs an equivalent offline step to prevent quality from degrading over time.

`FileMemoryStore` addresses both needs. It organizes knowledge as a structured file hierarchy that the agent can navigate directly, and exposes consolidation as an offline maintenance step — analogous to how managed backends process knowledge asynchronously. By running offline, this step can also build local indexes, enabling semantic search without a managed vector service. Because it operates through a `FileStorage` interface, the backend can be extended to git-based storage, S3, or any other persistence layer without changing the core memory model.

---

## Decision

This proposal introduces **`FileMemoryStore`**, which implements the `MemoryStore` interface (for `MemoryManager`, L2). It handles knowledge: extracted facts, learned skills, progressive disclosure, search, and consolidation.

For L1 (session persistence), the existing `FileStorage` from the context manager already implements the `Storage` interface and provides file operations (`read`, `write`, `list`, `delete`). It is passed directly to `ContextManager` — no additional wrapper class is needed.

`FileMemoryStore` uses a `FileStorage` instance for its file operations.

Both L1 and L2 can share the same `FileStorage` instance pointed at the same root directory, giving a unified, inspectable filesystem containing everything an agent has learned and experienced — without conflating L1 and L2 into a single construct.

The existing Strands API remains unchanged. `MemoryManager` still owns L1 → L2 extraction. What changes is the physical storage: instead of separate, disconnected backends for each layer, both write to the same file hierarchy — `FileStorage` writes to `sessions/` for L1 and `FileMemoryStore` writes to `knowledge/` for L2.

### File Hierarchy

`FileStorage` and `FileMemoryStore` can share the same root directory. They are isolated by path: `FileStorage` (via `ContextManager`) writes to `sessions/`, while `FileMemoryStore` writes to `knowledge/`. Consolidation metadata lives in `consolidation/`.

```
agent_memory/
├── sessions/                        # L1 - ContextManager writes here
│   ├── current.md
│   └── history/
│       ├── 2026-06-10-session-a.md
│       └── 2026-06-11-session-b.md
├── knowledge/                       # L2 - MemoryStore writes here (called by MemoryManager)
│   ├── system/                      # always loaded in full every turn
│   │   └── user-preferences.md
│   ├── facts/                       # visible by name + description; loaded on demand
│   │   ├── testing-philosophy.md
│   │   └── project-context.md
│   └── skills/
│       ├── debugging.md
│       └── code-review.md
└── consolidation/
    └── changelog.md                 # human-readable log of consolidation
```

---

## Progressive Disclosure

Not everything loads into context every turn. The agent retrieves relevant knowledge on demand by navigating the file hierarchy directly. LLMs are precise and accurate at scoped filesystem calls (listing directories, grepping for keywords, reading specific files), and progressive disclosure leverages this skill as the primary retrieval mechanism.

### Relationship to MemoryManager Retrieval

`MemoryManager` provides two retrieval mechanisms: automatic injection (searches stores every turn, injects results into model input) and the `search_memory` tool (agent-initiated). Both call `store.search()` on the store. Progressive disclosure is a *third*, independent retrieval path. The agent navigates the file hierarchy using tools (`readFile`, `grep`) registered by `FileMemoryStore` via `getTools()`.

These are not mutually exclusive, and the user controls which are active:

| Mechanism | Controlled by | How it works with `FileMemoryStore` |
|-----------|---------------|-------------------------------------|
| Injection | `MemoryManager` config (`injection: true`) | Calls `FileMemoryStore.search()` (keyword matching) → injects results as `<memory>` XML |
| `search_memory` tool | Agent-initiated | Same — calls `FileMemoryStore.search()` |
| Progressive disclosure | Agent-initiated | Agent sees file tree in system prompt, navigates with `readFile`/`grep` tools |

When `FileMemoryStore` is the only store, **progressive disclosure is the recommended primary retrieval path** — the agent's judgment over filenames and descriptions is a better retrieval engine than keyword matching for a filesystem store. `MemoryManager` injection is redundant in this case and can be disabled (`injection: false`). The `search_memory` tool remains available as a fallback — it searches inside file content, so it can surface relevant knowledge when filenames and descriptions alone aren't enough to identify the right file.

### How It Works

`FileMemoryStore` registers two things on the agent at initialization (via `getTools()` for the navigation tools, and via the `MemoryManager` injection mechanism with a custom format callback for the file tree):

**1. The file tree (always in the system prompt)**

The full directory listing of `knowledge/` with each file's `description` frontmatter is injected into the agent's system prompt every turn via `MemoryManager`'s injection config — using a custom `format` callback that renders the tree instead of search results. The agent always knows what knowledge exists without loading the content:

```
knowledge/
├── system/                          [loaded in full]
│   └── user-preferences.md         — "Core preferences: editor, language, testing style"
├── facts/
│   ├── testing-philosophy.md       — "Integration-first, mock at boundaries"
│   ├── deploy-process.md           — "Team's deployment pipeline and rollback procedures"
│   └── project-architecture.md     — "Service boundaries and data flow"
└── skills/
    └── code-review.md              — "Patterns for reviewing PRs: what to flag, what to skip"
```


### Context Loading

Files in `knowledge/system/` are always loaded in full into the system prompt. This is where core context lives (persona, key preferences, critical project facts). Everything outside `system/` is visible by filename + description only, loaded when the agent reads it.

**Who manages `system/`:** Developers seed `system/` at repo creation with anything the agent always needs (persona, core preferences). The consolidation agent promotes and demotes files during offline maintenance, analyzing cross-session patterns to move broadly relevant files into `system/` and overly specific ones out. The main agent never writes to `system/` during a session.

### Retrieval in Practice

The agent uses the file tree to judge relevance by filename and description, then loads specific files with `readFile` or searches across files with `grep` — both registered by `FileMemoryStore` via `getTools()`. For a targeted question, it reads a single matching file. For a broader query, it greps across `knowledge/`, then reads the best matches. See [Appendix A](#appendix-a-retrieval-worked-examples) for worked examples.

### File Format

Knowledge files are markdown with YAML frontmatter containing one field — `description`. The description is always visible in the file tree, letting the agent judge relevance without reading every file:

```markdown
---
description: "How the user approaches testing: integration-first, mock at boundaries"
---

- Prefers integration tests over unit tests for API layers
- Uses VS Code with vim keybindings
- Mocks external services at the HTTP boundary, not at the module level
```

---

### Architecture

#### FileMemoryStore

`FileMemoryStore` implements the `MemoryStore` interface (called by `MemoryManager`). It handles L2 — knowledge storage, progressive disclosure, search, and consolidation. It operates on `knowledge/` through a `FileStorage` instance for file operations.

```typescript
interface FileMemoryStoreConfig {
  // Required
  name: string;
  storage: FileStorage;

  // Optional (MemoryStore interface)
  description?: string;
  maxSearchResults?: number;
  extraction?: ExtractionConfig;

  // Optional with defaults
  retrieval?: { maxTokens?: number }; // default: 2000
}

interface ConsolidateConfig {
  model: Model;
  operations: ("deduplicate" | "resolve-contradictions" | "derive-insights" | "prune" | "reorganize")[];
  scope: "since-last" | "all";
}

class FileMemoryStore implements MemoryStore {
  constructor(config: FileMemoryStoreConfig)

  // --- MemoryStore (MemoryManager L2) ---
  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
  async add(content: string, metadata?: Record<string, JSONValue>): Promise<void>

  // --- Consolidation ---
  async consolidate(config: ConsolidateConfig): Promise<void>
}
```

### Method Behavior

#### FileMemoryStore

**`add(content, metadata?)`**

Writes a new markdown file to `knowledge/facts/`. No model call.

- **Filename:** `metadata.title` if present, otherwise first few words of the content plus a timestamp (e.g., `testing-preferences.md` or `user-prefers-dark-mode-1718234.md`)
- **Frontmatter `description`:** `metadata.description` if present, otherwise first sentence of the content

The `metadata` fields come from the `ModelExtractor` when automatic extraction is configured — its system prompt instructs it to produce a title and description for each extracted fact (see [Appendix B](#appendix-b-extraction-configuration) for the configuration example). When the agent uses the `store_memory` tool instead (explicit write), no extractor is involved — `add()` receives raw content with no metadata and falls back to deriving both from the content.

**`search(query, options?)`**

Required by the `MemoryStore` interface. The default implementation performs keyword matching against filenames, `description` frontmatter, and file content, excluding `knowledge/system/` (already loaded in full). Returns the top matches as `MemoryEntry[]`, ranked by term frequency. No model call, no embeddings.

Progressive disclosure (see [Progressive Disclosure](#progressive-disclosure)) is the primary retrieval mechanism for `FileMemoryStore` — the agent sees the file tree in its system prompt and navigates knowledge directly using filesystem tools. The [`search_memory` tool](https://github.com/strands-agents/docs/blob/main/designs/0011-memory-manager.md) serves as a fallback: it retrieves actual content in a single tool call, preventing hallucination in cases where the agent might respond based on filenames/descriptions alone without reading the underlying files.

---
## Alternative to Progressive Disclosure: Semantic Search via Offline Indexing

Rather than relying on keyword matching for `search()`, consolidation can also build a local embedding index — the same approach managed stores like `BedrockKnowledgeBaseStore` use server-side, but run locally during the offline maintenance step. This ensures `search()` performs real semantic retrieval (handling synonyms, paraphrasing, and conceptual matches) rather than a simple keyword scan.

During `consolidate()`, an embedding model computes vectors for each knowledge file and writes them to a local index (e.g., `consolidation/embeddings.json`). At runtime, `search()` embeds the query and performs cosine similarity against the index — no model call, no tokens spent per turn. This is analogous to how Bedrock Knowledge Bases indexes documents on ingest and serves semantic search via its `RetrieveCommand`, but without the managed infrastructure.

With semantic search in place, `FileMemoryStore` works through the existing `MemoryManager` retrieval mechanisms (injection and `search_memory`) without depending on the agent's judgment to navigate files. The tradeoff: progressive disclosure costs tokens every turn (file tree in system prompt + tool calls for navigation), while semantic search costs tokens only during offline consolidation and is free at runtime.

### Integration with Existing Features

L1 and L2 share the same `FileStorage` instance:

```typescript
import { Agent, MemoryManager } from "@strands-agents/sdk";
import { ContextManager } from "@strands-agents/sdk/context";
import { FileStorage } from "@strands-agents/sdk/storage";
import { FileMemoryStore } from "@strands-agents/sdk/memory";

const fileStorage = new FileStorage({ rootPath: "./.agent-memory" });
const memoryStore = new FileMemoryStore({
    name: "agent-memory",
    storage: fileStorage,
});

const agent = new Agent({
    model,
    contextManager: new ContextManager({ storage: fileStorage }),
    memoryManager: new MemoryManager({
        stores: [memoryStore],
    }),
});
```

---

## Consolidation

Consolidation improves memory quality after facts accumulate. It is a developer-invoked Strands agent exposed as a method on `FileMemoryStore`. It reads stored knowledge, reasons across files, and writes changes through `FileStorage`.

All extracted facts land in `knowledge/facts/` by default — `FileMemoryStore.add()` writes there unconditionally for simplicity and to avoid a classification model call on every extraction. Consolidation is therefore responsible for reorganizing files into appropriate subdirectories (`skills/`, `system/`, etc.) during offline maintenance, when it has full cross-file context to make informed categorization decisions.

### How It Works

```
myStore.consolidate(config)
│
├─ 1. SCOPE: determine which files to process
│     scope: "since-last" → read last consolidation timestamp from changelog.md,
│                            then list files modified after that timestamp (via mtime)
│     scope: "all"        → everything in knowledge/
│
├─ 2. CLUSTER: group eligible files by subdirectory
│     Clustering keeps each agent invocation focused on related files — a cluster of
│     testing facts can be deduplicated, but mixing testing facts with deploy procedures
│     would force the agent to reason across unrelated topics in a single pass.
│
│     cluster 1 (facts/): [dark-mode.md, editor-preferences.md, deploy-process.md]
│     cluster 2 (skills/): [debugging.md, code-review.md]
│
├─ 3. EXECUTE: for each cluster, invoke a Strands agent
│     Each agent invocation receives:
│     - model:         the LLM passed in config (does the reasoning)
│     - system prompt: built from config.operations (e.g. "deduplicate", "prune")
│     - tools:         readFile, writeFile, deleteFile (thin wrappers around FileStorage)
│     - context:       the list of modified files for this cluster (from step 1)
│
│     The agent reads the cluster's files, applies the requested operations, and writes
│     changes back through FileStorage.
│
└─ 4. RECORD: append timestamp + summary to consolidation/changelog.md
       This serves as both an audit log and the cursor for the next "since-last" run.
```

### Operations

The `operations` config controls which directives go into the agent's system prompt. They are prompt instructions — the LLM decides how to apply them using the file content and change history available in its context.

| Operation | Agent behavior | Example |
|-----------|---------------|---------|
| `deduplicate` | Merge files expressing the same fact | "User prefers dark mode" + "Theme preference: dark" → one file |
| `resolve-contradictions` | Keep the more recent fact (per change history), delete the other | "Uses tabs" (April) vs "Uses spaces" (June) → keeps spaces |
| `derive-insights` | Combine related facts into a higher-level pattern | 3 testing facts → "Testing philosophy: high-fidelity, boundary-mocked" |
| `prune` | Delete entries whose content is fully covered by a newer file | `old-deploy-process.md` superseded by `deploy-process.md` → deleted |
| `reorganize` | Move files to appropriate subdirectories based on content | Fact about debugging patterns in `facts/` → moved to `skills/debugging.md` |

### Usage

Since Strands is a client-side SDK with no server process, consolidation needs an external trigger:

```typescript
await myStore.consolidate({
  model,
  operations: ["deduplicate", "resolve-contradictions"],
  scope: "since-last",
});
```

Scheduling frequency is controlled by the developer — e.g., after each session for incremental cleanup, or weekly for a deep clean. See [Appendix D](#appendix-d-consolidation-examples) for the nightly vs. weekly patterns for option 2, and [Appendix E](#appendix-e-github-action-yaml) for an example GitHub Action trigger.

---

## Alternatives Considered

### 1. Branching: Separate branch per session

Each session writes to its own branch, merges back to `main` on close.

**Why rejected:** Path-based isolation (`sessions/{id}.md`) achieves the same separation without branch management overhead or merge conflicts.

### 2. Consolidation: Inline during agent sessions

Trigger consolidation within the agent loop (e.g., every N turns) instead of externally.

**Why rejected:** Consolidation reads many files and calls a model — running it mid-session adds latency to agent responses. Since Strands is a client-side SDK with no background process, there's no way to run it asynchronously without blocking the user. External invocation (GitHub Action, CLI) keeps the agent loop fast and gives developers cost control.

### 3. Consolidation: Deterministic rules instead of LLM

Hard-coded deduplication rules (e.g., cosine similarity > 0.95 → merge).

**Why rejected:** Rules miss semantic duplicates ("User prefers dark mode" vs. "Theme preference: dark") and can't derive insights from combining related facts. LLM judgment handles nuance. Non-determinism is mitigated by every change being versioned and reversible.

### 4. File placement: Classify at extraction time

Have `FileMemoryStore.add()` call a model to categorize each fact (e.g., preference, skill, project fact) and write it directly to the appropriate subdirectory (`skills/`, `system/`, etc.).

**Why rejected:** Adds a classification model call to every extraction, increasing latency and token cost during agent sessions. The classifier also only sees a single fact in isolation, leading to worse categorization than the consolidation agent, which sees all files together and can make informed cross-file decisions. Writing everything to `facts/` by default keeps `add()` fast and simple, and lets consolidation handle reorganization with full context during offline maintenance.

### 5. Retrieval: Heuristic scoring with metadata

Score files using frontmatter metadata (tags, recency, access frequency) and load top-K within a token budget. No agent involvement in retrieval.

**Why rejected:** Requires building metadata infrastructure (tag extraction, scoring weights, access counters). Vector store backends like Bedrock Knowledge Bases have embeddings and similarity scoring server-side, making programmatic scoring natural. For a filesystem store there is no equivalent infrastructure — the agent's own judgment (navigating via filenames and descriptions) is the better retrieval engine.

---

## Consequences

### What Becomes Easier

- No ongoing infrastructure costs for storage and retrieval — everything runs locally. Only LLM calls (extraction, consolidation) cost tokens, and those are controlled by the developer.
- Cross-session knowledge with zero external infrastructure (no vector DB, no managed service)
- Developer debugging — inspect the file hierarchy directly; changes are diffable
- Portability — memory directory can be copied, shared, or used to seed other agents with a knowledge base

### What Becomes Harder

- Scaling beyond ~1,000 knowledge files — file listing and search may slow down with very large trees
- Concurrent writes from multiple agent instances — simultaneous writes require coordination (file locking or single-writer constraint)
- Retrieval quality depends on model judgment — the agent must recognize when to search and what to read; if it doesn't look, relevant memories stay hidden
- Consolidation cost and non-determinism — each run calls a model, costs tokens, and may produce different results on re-runs
- Storage growth — sessions accumulate indefinitely; may need a retention policy for old session files



---

## Security Model

`FileMemoryStore` assumes single-tenant compute — one instance per user/agent. `FileStorage` is identity-unaware; it takes a path and performs I/O without knowledge of who is asking. It is not a multi-tenancy boundary. Deployments serving multiple users must isolate at the container or credential layer (e.g., separate containers per tenant), not within a shared `FileStorage` instance. Path validation is defense-in-depth against bugs, not an access control mechanism.

---

## Willingness to Implement

Yes.


---
<details>
  <summary><b>Appendix A: Retrieval Worked Examples</b></summary>

```
User asks: "how should I structure these tests?"

Agent sees file tree → spots "testing-philosophy.md" (description: "Integration-first, mock at boundaries")
Agent calls: readFile("knowledge/facts/testing-philosophy.md")
→ full content loaded into context, agent answers using the loaded knowledge
```

For broader queries:

```
User asks: "what do you know about our deploy process?"

Agent sees file tree → spots "deploy-process.md" (description: "Team's deployment pipeline and rollback procedures")
Agent also sees "project-architecture.md" (description: "Service boundaries and data flow")
Agent calls: readFile("knowledge/facts/deploy-process.md")
→ full content loaded into context, agent answers from it
```

Fallback — when filenames and descriptions aren't enough:

```
User asks: "what was that thing about retrying failed requests?"

Agent sees file tree → no filename or description obviously matches "retrying failed requests"
Agent calls: search_memory("retry failed requests")
→ FileMemoryStore.search() keyword-matches against file content, returns relevant entries
→ agent gets content directly without guessing which file to read
```

</details>

<details>
  <summary><b>Appendix B: Extraction Configuration</b></summary>

```typescript
const myStore = new FileMemoryStore({
  name: "agent-memory",
  storage: new FileStorage({ rootPath: "./.agent-memory" }),
  extraction: {
    triggers: [new InvocationTrigger()],
    extractor: new ModelExtractor({
      model,
      systemPrompt: `Extract discrete facts from the conversation. For each fact, return:
- content: the fact itself
- metadata.title: a 2-4 word slug (e.g., "testing-preferences")
- metadata.description: a one-line summary for discoverability`,
    }),
  },
});
```

</details>

<details>
  <summary><b>Appendix C: Versioning and Rollback (Nice to Have)</b></summary>

The core `FileMemoryStore` operates on `FileStorage` alone — no versioning required. For developers who want rollback support and richer change tracking (e.g., undoing bad consolidation), `FileStorage` implementations can optionally expose versioning methods. This is a nice-to-have extension, not a requirement for the initial implementation.

### Versioning Extension

Backends that support versioning can additionally implement `changesSince()` and `rollback()`:

```typescript
interface VersionedFileStorage extends FileStorage {
  changesSince(timestamp: number): Promise<FileChange[]>;
  rollback(path: string, timestamp: number): Promise<void>;
}

interface FileChange {
  path: string;
  timestamp: number;
  operation: "write" | "delete";
}
```

**`changesSince(timestamp)`** returns all writes and deletes after the given timestamp — used by consolidation for precise `"since-last"` scoping (instead of falling back to mtime). **`rollback(path, timestamp)`** restores a file to its state at the given timestamp — used to undo bad consolidation.

| Implementation | How it versions |
|---------------|----------------|
| Local `FileStorage` | Copies previous content to `.versions/{path}/{timestamp}` before overwriting; maintains a `.journal` file for `changesSince()` |
| `S3Storage` | S3 object versioning — managed by the service |
| `GithubStorage` | Git commits — `changesSince` maps to commit history, `rollback` restores from a prior commit |

### Git-Based Example

```typescript
class GithubStorage implements VersionedFileStorage {
  // FileStorage methods
  async read(path: string) { /* GitHub Contents API GET */ }
  async write(path: string, content: string) { /* GitHub Contents API PUT (creates commit) */ }
  async delete(path: string) { /* GitHub Contents API DELETE */ }
  async list(prefix?: string) { /* GitHub Trees API */ }

  // Versioning methods
  async changesSince(timestamp: number) { /* git log --since via Commits API */ }
  async rollback(path: string, timestamp: number) { /* restore file content from prior commit */ }
}
```

### Call Flow

When the agent extracts a fact, `FileMemoryStore.add()` writes through its `FileStorage` instance:

```
agent extracts "user prefers dark mode"
  → FileMemoryStore.add(content, { title: "dark-mode" })
    → FileStorage.write("knowledge/facts/dark-mode.md", content)
      → fs.writeFile(".agent-memory/knowledge/facts/dark-mode.md", content)  // local
      → s3.PutObject(...)                                                    // S3
      → github.createOrUpdateFileContents(...)                               // GitHub
```

When consolidation runs with `scope: "since-last"` and the storage supports versioning:

```
myStore.consolidate({ model, operations: ["deduplicate"], scope: "since-last" })
  → storage.changesSince(lastTimestamp)  // precise scoping via version history
  → consolidation agent reads/writes files via FileStorage
```

When the storage does not implement versioning, `since-last` falls back to mtime-based scoping from `list()`.

### Usage

```typescript
const storage = new GithubStorage({ owner: "myorg", repo: "agent-memory", branch: "main" });

const memoryStore = new FileMemoryStore({
    name: "agent-memory",
    storage,
});

const agent = new Agent({
    model,
    memoryManager: new MemoryManager({ stores: [memoryStore] }),
});
`

</details>

<details>
  <summary><b>Appendix D: Consolidation Examples</b></summary>

### Full Usage Script

```typescript
// consolidate.ts — run via cron, GitHub Action, or manually
import { FileMemoryStore } from "@strands-agents/sdk/memory";
import { FileStorage } from "@strands-agents/sdk/storage";

const myStore = new FileMemoryStore({
  name: "agent-memory",
  storage: new FileStorage({ rootPath: "./.agent-memory" }),
});

// Nightly incremental (cheap — only processes new files)
await myStore.consolidate({
  model,
  operations: ["deduplicate", "resolve-contradictions"],
  scope: "since-last",
});

// Weekly deep clean (expensive — processes everything)
await myStore.consolidate({
  model,
  operations: ["deduplicate", "resolve-contradictions", "derive-insights", "prune"],
  scope: "all",
});
```

### Example Output

Each operation is recorded in `consolidation/changelog.md` (serves as both audit log and cursor for `scope: "since-last"`):

```markdown
## 2026-06-15 02:00 (nightly)
- Consolidate(deduplicate): merged `facts/dark-mode.md` into `facts/editor-preferences.md`
- Consolidate(resolve): kept "uses spaces" over "uses tabs" (recency: June vs April)
- Consolidate(derive): synthesized `facts/testing-philosophy.md` from 3 entries
- Consolidate(prune): deleted `facts/old-deploy-process.md` (last written 2026-03-01, superseded by `facts/deploy-process.md`)
```

</details>

<details>
  <summary><b>Appendix E: GitHub Action YAML</b></summary>

```yaml
# .github/workflows/consolidate.yml
name: Memory Consolidation

on:
  schedule:
    - cron: "0 2 * * *" # nightly
  workflow_dispatch: # manual trigger

jobs:
  consolidate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx strands-memory consolidate --path ./.agent-memory
      - run: |
          git config user.name "strands-consolidation[bot]"
          git config user.email "consolidation@users.noreply.github.com"
      - run: git diff --quiet || (git add . && git commit -m "Consolidate: nightly maintenance" && git push)
```

</details>

<details>
  <summary><b>Appendix F: Benchmarks To Test</b></summary>

### Deep Memory Retrieval (DMR)

Have the agent accumulate knowledge across sessions stored in `FileMemoryStore`, then test whether it can recall facts from session 1 after 10+ sessions have passed. Compare recall accuracy with vs. without consolidation to measure consolidation's impact on long-horizon retrieval quality.

### File-Hierarchy Retrieval vs. Embeddings

Compare progressive disclosure (file tree + agent navigation) against embedding-based retrieval. Letta's research found that their filesystem approach scored 74.0% on the LoCoMo benchmark by storing conversational histories in files — beating specialized memory tool libraries. Evaluate `FileMemoryStore` against the same or similar benchmarks.

### Consolidation Frequency

Measure the relationship between consolidation frequency and token cost vs. retrieval quality. Research suggests diminishing returns — find the optimal cadence that preserves retrieval quality without excessive token usage.

</details>

<details>
  <summary><b>Appendix G: Success Criteria</b></summary>

### Required

| Criterion | Measure |
|-----------|---------|
| SDK integration | A working `FileMemoryStore` that plugs into `memoryManager.stores`, with both L1 and L2 sharing a `FileStorage` instance — passing integration tests with the existing SDK |
| Auditable history | `consolidation/changelog.md` tells a coherent story of what the agent learned and when — a developer can trace how memory evolved over time without inspecting individual file diffs |
| Consolidation quality | Benchmark showing how consolidation changes retrieval quality (e.g., DMR recall before/after consolidation runs) |
| Progressive disclosure efficiency | Benchmark measuring how progressive disclosure changes tokens loaded per turn and retrieval accuracy vs. full-context injection |
| Inspectable | A developer can browse the memory directory and diff file changes directly — the file hierarchy is human-readable and diffable |

### Stretch Goals / Nice to Have

| Criterion | Measure |
|-----------|---------|
| Versioning extension | A `VersionedFileStorage` interface extending `FileStorage` with `changesSince()` and `rollback()` for precise change tracking and undo support — see [Appendix C](#appendix-c-versioning-and-rollback-nice-to-have) |
| `GithubStorage` | A `FileStorage` implementation backed by GitHub repos (Contents API for read/write/delete, Trees API for list). Gives git-native versioning for free — every `write()` is a commit, `changesSince()` maps to commit history, and `rollback()` restores from a prior commit SHA. Enables shared, collaborative agent memory across teams via standard git workflows (PRs for consolidation review, branch protection for `system/`, `.github/workflows/` for scheduled consolidation). |
| Comparative benchmarks | Benchmark comparison against managed alternatives (`BedrockKnowledgeBaseStore`) and in-memory baselines showing where a local file store adds value and where it doesn't |
| End-to-end deployed example | A deployed Strands agent (code review, coding assistant, or similar) that uses `FileMemoryStore` for memory accumulation across sessions, with scheduled consolidation via GitHub Actions. Deployed for an internal team use case (e.g., a code review agent that remembers codebase patterns, or an onboarding agent that accumulates project knowledge) AND publishable as a labs/devtools sample demonstrating the full lifecycle: agent learns → memory accumulates → consolidation improves → agent gets better over time |

</details>