# Design Doc: File-Based Agent Memory

| Field  | Value          |
|--------|----------------|
| Status | Proposed       |
| Date   | June 12, 2026  |
| Issue  | TBD            |
| Scope  | TypeScript SDK |

---

## Context

LLM-powered agents struggle with maintaining and managing long-term memory effectively. As memory accumulates over extended interactions, memory quality degrades. In the Strands SDK, there is no built-in maintenance mechanism that can combine, deduplicate, resolve contradictions, or restructure isolated facts. Over long-horizon use, memory files accumulate redundancy and lose coherent structure, making retrieval less reliable and context windows less efficient.

The existing `BedrockKnowledgeBaseStore` addresses retrieval via managed vector search, but requires provisioned AWS infrastructure (Bedrock Knowledge Base, credentials, optional S3). This is well-suited for production and enterprise deployments where teams already have AWS infrastructure. `FileMemoryStore` targets the other end: individual developers, prototyping, and environments where standing up a managed service is unnecessary overhead. It requires zero external infrastructure, just a filesystem.

Managed stores like `BedrockKnowledgeBaseStore` handle memory maintenance server-side — deduplication, indexing, and retrieval quality are responsibilities of the backend service. This works because the infrastructure runs outside the agent loop: it can process knowledge asynchronously, build embeddings, and serve semantic search without adding latency to agent sessions.

There is no local equivalent. A developer who doesn't want managed infrastructure has no store implementation that maintains quality over time — facts accumulate, redundancy grows, and retrieval degrades. The gap is not in `MemoryManager` (which remains an orchestrator over its stores) but in the available store implementations: none provide offline maintenance without a server.

`FileMemoryStore` fills this gap as a local alternative to managed stores. It organizes knowledge as a structured file hierarchy that the agent can navigate directly, and exposes an offline maintenance step (consolidation) that runs outside the agent loop — just as a managed backend would process knowledge asynchronously. By running offline, this step can do more than cleanup: it can also build local indexes, enabling semantic search without requiring a managed vector service. The storage layer is abstracted behind a `FileBackend` interface, so the same memory system can be backed by a local filesystem, a git repository, S3, or any other store that supports basic file operations.

---

## Decision

This proposal introduces two constructs backed by a shared `FileBackend`:

- **`FileMemoryStore`** — implements the `MemoryStore` interface (for `MemoryManager`, L2). Handles knowledge: extracted facts, learned skills, progressive disclosure, search, and consolidation.
- **`FileSessionStorage`** — implements the `Storage` interface (for `ContextOffloader`, L1). Handles session persistence: evicted content blocks, binary storage, retrieval by reference.

Both are separate classes with distinct responsibilities, but they share the same `FileBackend` instance and write to the same file hierarchy. This gives a unified, inspectable filesystem containing everything an agent has learned and experienced — without conflating L1 and L2 into a single construct.

The storage backend is abstracted behind a `FileBackend` interface — any system that can read, write, list, and delete files can serve as the underlying store. This enables the same memory system to run against a local directory, a git repository, S3, or a custom implementation without changing the memory logic.

The existing Strands API remains unchanged. L1 today is limited — content that leaves the active window has no general path to be retrieved back into context. By writing both layers to the same hierarchy, the `FileBackend` provides a unified substrate that future context retrieval capabilities can build on. `MemoryManager` still owns L1 --> L2 extraction. What changes is the physical storage: instead of separate, disconnected backends for each layer, both write to the same file hierarchy. Every write from either layer is routed through the `FileBackend`, which determines how persistence, history, and atomicity are handled.

### File Hierarchy

`FileSessionStorage` and `FileMemoryStore` accept the same `FileBackend` instance at construction. This shared backend is what unifies the hierarchy — both write to a single root directory but are isolated by path: `FileSessionStorage` writes to `sessions/`, while `FileMemoryStore` writes to `knowledge/`. Consolidation metadata lives in `consolidation/`.

```
agent_memory/
├── sessions/                        # L1 - ContextOffloader writes here
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

| Mechanism | Controlled by | How it works witFh `FileMemoryStore` |
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

#### FileBackend Interface

The `FileBackend` interface defines the minimal set of file operations that any storage system must provide. `FileMemoryStore` passes relative paths (e.g., `knowledge/facts/testing.md`) — the backend joins them with its own `rootPath` (provided at construction) to form the full path. This keeps the store decoupled from where files physically live.

```typescript
interface FileBackend {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix?: string): Promise<FileEntry[]>;
  exists(path: string): Promise<boolean>;

  // Versioning — each backend implements with its native mechanism
  changesSince(timestamp: number): Promise<FileChange[]>;
  rollback(path: string, timestamp: number): Promise<void>;
}

interface FileEntry {
  path: string;
  isDirectory: boolean;
}

interface FileChange {
  path: string;
  timestamp: number;
  operation: "write" | "delete";
}
```

**`changesSince(timestamp)`** returns all writes and deletes that occurred after the given timestamp. Consolidation uses this to scope work (`"since-last"`) and to provide recency context to the agent. **`rollback(path, timestamp)`** restores a file to its state at the given timestamp — used to undo bad consolidation.

#### How the Components Connect

```
┌──────────────────────────────────────────────────────────────────┐
│ Agent                                                            │
│                                                                  │
│  ┌──────────────────┐          ┌────────────────────────┐        │
│  │ ContextOffloader │          │ MemoryManager          │        │
│  │ (plugin)         │          │ (orchestrator)         │        │
│  └────────┬─────────┘          └───────────┬────────────┘        │
│           │ store()/retrieve()             │ search()/add()      │
│           ▼                                ▼                     │
│  ┌───────────────────┐          ┌────────────────────────┐       │
│  │ FileSessionStorage│          │ FileMemoryStore        │       │
│  │ implements Storage│          │ implements MemoryStore │       │
│  └────────┬──────────┘          └───────────┬────────────┘       │
│           │                                 │                    │
│           │         ┌───────────┐           │                    │
│           └────────►│FileBackend│◄──────────┘                    │
│                     │(shared)   │                                │
│                     └─────┬─────┘                                │
│                           │                                      │
└───────────────────────────┼──────────────────────────────────────┘
                            ▼
                   .agent-memory/
                   ├── sessions/
                   └── knowledge/
```

#### Example: LocalFileBackend

```typescript
class LocalFileBackend implements FileBackend {
  private rootPath: string;

  constructor({ rootPath }: { rootPath: string }) {
    this.rootPath = rootPath;
  }

  // File operations — each joins this.rootPath with the relative path
  async read(path: string): Promise<string> {}
  async write(path: string, content: string): Promise<void> {}
  async delete(path: string): Promise<void> {}
  async list(prefix?: string): Promise<FileEntry[]> {}
  async exists(path: string): Promise<boolean> {}

  // Versioning — implemented via .versions/ snapshots and .journal
  async changesSince(timestamp: number): Promise<FileChange[]> {}
  async rollback(path: string, timestamp: number): Promise<void> {}
}
```

#### FileSessionStorage

`FileSessionStorage` implements the `Storage` interface (called by the `ContextOffloader`). It handles L1 persistence — storing evicted content blocks as files under `sessions/` and retrieving them by reference.

```typescript
interface FileSessionStorageConfig {
  backend: FileBackend;
}

class FileSessionStorage implements Storage {
  constructor(config: FileSessionStorageConfig)

  async store(key: string, content: Uint8Array, contentType?: string): Promise<string>
  async retrieve(reference: string): Promise<{ content: Uint8Array; contentType: string }>
}
```

#### FileMemoryStore

`FileMemoryStore` implements the `MemoryStore` interface (called by `MemoryManager`). It handles L2 — knowledge storage, progressive disclosure, search, and consolidation. It operates on `knowledge/` through whichever `FileBackend` is provided.

```typescript
interface FileMemoryStoreConfig {
  // Required
  name: string;
  backend: FileBackend;

  // Optional (MemoryStore interface)
  description?: string;
  limit?: number;
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

#### FileSessionStorage

**`store(key, content, contentType?)`**

Called by the context offloader when content is evicted from the context window. The `key` is a unique identifier for the content block (provided by the offloader), and `contentType` is the MIME type (e.g., `text/plain`, `image/png`). Writes the content as a file to `sessions/` and returns the file path as a reference string.

**`retrieve(reference)`**

Takes the reference string returned by `store()` and reads the file back. Returns the content and its content type. Called when the agent needs previously evicted content back in the context window.

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

### Versioning

Versioning is a backend responsibility — each backend implements `changesSince()` and `rollback()` using whatever mechanism is native to its storage:

| Backend | How it versions |
|---------|----------------|
| `GitFileBackend` | `git log`, `git show`, `git revert` — free, built into the storage |
| `LocalFileBackend` | Copies previous content to `.versions/{path}/{timestamp}` before overwriting; maintains a `.journal` file for `changesSince()` |
| `S3FileBackend` | S3 object versioning — managed by the service |

`FileMemoryStore` doesn't implement versioning itself — it calls `this.backend.rollback()` or `this.backend.changesSince()` and lets the backend decide how. This avoids redundant work for backends that already version natively (git, S3) while still supporting backends that don't (local filesystem).


### Integration with Existing Features

L1 and L2 are separate constructs backed by the same `FileBackend`:

```typescript
import { Agent, MemoryManager } from "@strands-agents/sdk";
import { ContextOffloader } from "@strands-agents/sdk/vended-plugins/context-offloader";
import { FileMemoryStore, FileSessionStorage, LocalFileBackend } from "@strands-agents/sdk/memory";

const backend = new LocalFileBackend({ rootPath: "./.agent-memory" });

const sessionStorage = new FileSessionStorage({ backend });  // L1
const memoryStore = new FileMemoryStore({                     // L2
    name: "agent-memory",
    backend,
});

const agent = new Agent({
    model,
    plugins: [new ContextOffloader({ storage: sessionStorage })],
    memoryManager: new MemoryManager({
        stores: [memoryStore],
    }),
});
```

Custom backends implement the `FileBackend` interface. See [Appendix C](#appendix-c-git-based-memory) for an example git-based implementation.

---

## Consolidation

Consolidation improves memory quality after facts accumulate. It is a developer-invoked Strands agent exposed as a method on `FileMemoryStore`. It reads stored knowledge, reasons across files, and writes changes through the `FileBackend`. Every change is versioned by the backend (via `history()`/`rollback()`), so bad consolidation is trivially reversible.

All extracted facts land in `knowledge/facts/` by default — `FileMemoryStore.add()` writes there unconditionally for simplicity and to avoid a classification model call on every extraction. Consolidation is therefore responsible for reorganizing files into appropriate subdirectories (`skills/`, `system/`, etc.) during offline maintenance, when it has full cross-file context to make informed categorization decisions.

### How It Works

```
myStore.consolidate(config)
│
├─ 1. SCOPE: determine which files to process
│     scope: "since-last" → read last consolidation timestamp from changelog.md,
│                            then call backend.changesSince(timestamp) to get modified files
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
│     - tools:         readFile, writeFile, deleteFile (thin wrappers around this.backend)
│     - context:       the FileChange[] entries for this cluster (from step 1), providing
│                      timestamps so the agent can reason about recency
│
│     The agent reads the cluster's files, applies the requested operations, and writes
│     changes back through the FileBackend.
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
- Backend-agnostic — swap between local filesystem, git, S3, or custom implementations without changing the memory logic
- Full audit trail — versioned history with rollback support
- Developer debugging — inspect the file hierarchy directly; changes are diffable
- Portability — memory directory can be copied, shared, or used to seed other agents with a knowledge base

### What Becomes Harder

- Scaling beyond ~1,000 knowledge files — file listing and search may slow down with very large trees (backend-dependent)
- Concurrent writes from multiple agent instances — simultaneous writes require coordination (file locking or single-writer constraint)
- Retrieval quality depends on model judgment — the agent must recognize when to search and what to read; if it doesn't look, relevant memories stay hidden
- Consolidation cost and non-determinism — each run calls a model, costs tokens, and may produce different results on re-runs (mitigated by every change being versioned and reversible)
- Storage growth — sessions accumulate indefinitely; may need a retention policy for old session files



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
  backend: new LocalFileBackend({ rootPath: "./.agent-memory" }),
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
  <summary><b>Appendix C: Git-Based Memory (Original Design)</b></summary>

The original design for this proposal was a `GitMemoryStore` — a single class backed directly by a git repository. Every write produced a git commit, rollback was `git revert`, and the full audit trail lived in `git log`. Consolidation used git worktrees for concurrent operations and `git diff` for developer debugging.

The `FileBackend` abstraction was introduced instead so that the file-based memory model (hierarchy, progressive disclosure, consolidation) remains unchanged while the underlying storage can vary. 

We can still implement a git-based backend using the FileBackend abstraction:

```typescript
import fs from "node:fs/promises";

class GitFileBackend implements FileBackend {
  private rootPath: string;

  constructor({ rootPath }: { rootPath: string }) {
    this.rootPath = rootPath;
  }

  async read(path: string) { /* fs.readFile at rootPath/path */ }
  async write(path: string, content: string) { /* fs.writeFile, then git add + git commit */ }
  async delete(path: string) { /* fs.rm, then git add + git commit */ }
  async list(prefix?: string) { /* fs.readdir at rootPath/prefix */ }
  async exists(path: string) { /* fs.access at rootPath/path */ }
}
```

### Call Flow

When the agent extracts a fact, `FileMemoryStore.add()` calls `this.backend.write()` (the store doesn't know which backend — it calls the interface method, which resolves to whichever instance was passed in):

```
agent extracts "user prefers dark mode"
  → FileMemoryStore.add(content, { title: "dark-mode" })
    → GitFileBackend.write("knowledge/facts/dark-mode.md", content)
      → fs.writeFile(".agent-memory/knowledge/facts/dark-mode.md", content)
      → git add knowledge/facts/dark-mode.md
      → git commit -m "memory(facts): update dark-mode.md"
```

When the context offloader evicts content:

```
ContextOffloader evicts a session block
  → FileSessionStorage.store(key, content)
    → GitFileBackend.write("sessions/current.md", content)
      → fs.writeFile + git add + git commit
```

When consolidation runs:

```
myStore.consolidate({ model, operations: ["deduplicate"], scope: "since-last" })
  → consolidation agent calls FileMemoryStore methods
    → each write/delete routes through GitFileBackend
      → individual commits per operation
         a3f2c1d memory(facts): merge dark-mode.md into editor-preferences.md
         b7e4a2f memory(facts): delete dark-mode.md
```

### Usage

```typescript
const backend = new GitFileBackend({ rootPath: "./.agent-memory" });

const sessionStorage = new FileSessionStorage({ backend });
const memoryStore = new FileMemoryStore({
    name: "agent-memory",
    backend,
});

const agent = new Agent({
    model,
    plugins: [new ContextOffloader({ storage: sessionStorage })],
    memoryManager: new MemoryManager({ stores: [memoryStore] }),
});
```

The developer gets `git log`, `git diff`, and `git revert` for free — same memory model, git-native audit trail.

### Versioning Interface in Practice

The versioning methods on `FileBackend` are called by `FileMemoryStore` during consolidation and rollback. Here's how they're used with the git backend:

```typescript
const backend = new GitFileBackend({ rootPath: "./.agent-memory" });

// Scoping: get all files that changed since a timestamp (used by consolidation "since-last")
const changes = await backend.changesSince(1718234000);
// → [{ path: "knowledge/facts/dark-mode.md", timestamp: 1718234500, operation: "write" },
//    { path: "knowledge/facts/old-process.md", timestamp: 1718300000, operation: "delete" }]

// Rollback: restore a file to its state at a prior timestamp (used to undo bad consolidation)
await backend.rollback("knowledge/facts/editor-preferences.md", 1718234000);
```

For `GitFileBackend`, `changesSince()` maps to `git log --since` and `rollback()` maps to `git show <commit>:<path>` + write. For `LocalFileBackend`, these use the `.journal` file and `.versions/` snapshots respectively.

</details>

<details>
  <summary><b>Appendix D: Consolidation Examples</b></summary>

### Full Usage Script

```typescript
// consolidate.ts — run via cron, GitHub Action, or manually
import { FileMemoryStore, LocalFileBackend } from "@strands-agents/sdk/memory";

const myStore = new FileMemoryStore({
  name: "agent-memory",
  backend: new LocalFileBackend({ rootPath: "./.agent-memory" }),
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