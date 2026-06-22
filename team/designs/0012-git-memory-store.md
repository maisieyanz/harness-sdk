# Design Doc: Git-Based Agent Memory

| Field  | Value          |
|--------|----------------|
| Status | Proposed       |
| Date   | June 12, 2026  |
| Issue  | TBD            |
| Scope  | TypeScript SDK |

---

## Context

LLM-powered agents struggle with maintaining and managing long-term memory effectively. As memory accumulates over extended interactions, memory quality degrades. In the Strands SDK, there is no built-in maintenance mechanism that can combine, deduplicate, resolve contradictions, or restructure isolated facts. Over long-horizon use, memory files accumulate redundancy and lose coherent structure, making retrieval less reliable and context windows less efficient.

MemoryManager already handles extraction (promoting observations into long-term memory) and retrieval (injecting stored knowledge back into context). What it lacks is a maintenance layer and a shared substrate:

- **No maintenance** — there is no built-in way to deduplicate, resolve contradictions, or restructure stored knowledge after it's written. MemoryManager writes and retrieves, but never improves what's stored.
- **No unified timeline** — when L1 and L2 use separate backends, there is no single view that shows when sessions happened, when facts were extracted, and how knowledge evolved. Debugging requires checking multiple systems independently.

A git-based approach addresses these issues: version-controlled memory provides built-in history, diffing, and rollback. A shared git repository for both layers provides a unified timeline across sessions and knowledge in a single `git log`. And a developer-invoked consolidation agent provides the missing maintenance mechanism. Since Strands is a client-side SDK with no server process, a scheduled GitHub Action is the natural trigger for consolidation.

---

## Decision

`GitMemoryStore` is a unified, git-backed storage layer that implements both the `Storage` interface (for `ContextManager`, L1) and the `MemoryStore` interface (for `MemoryManager`, L2) against a single git repository. It serves as a single versioned, inspectable, diffable repository containing everything an agent has learned and experienced (session history, extracted facts, and learned skills).

The existing Strands API remains unchanged. `ContextManager` still owns L0 <--> L1, `MemoryManager` still owns L1 --> L2. What changes is the physical storage: instead of separate, disconnected backends for each layer, both write to the same git repo. Every write from any layer produces an informative git commit, giving developers a complete audit trail using standard git tooling (`git log`, `git diff`, `git revert`).

### Architecture

`GitMemoryStore` is a single class that implements both the `Storage` interface (for `ContextManager`) and the `MemoryStore` interface (for `MemoryManager`). This dual implementation is what enables the unified timeline — both layers write commits to the same repo, so `git log` shows the complete history of sessions and knowledge together.

```typescript
interface GitMemoryStoreConfig {
  // Required
  name: string;
  repoPath: string;

  // Optional (MemoryStore interface)
  description?: string;
  limit?: number;
  extraction?: ExtractionConfig;

  // Optional with defaults
  branch?: string;              // default: "main"
  remote?: string;              // default: "origin"
  retrieval?: { maxTokens?: number }; // default: 2000
}

class GitMemoryStore implements Storage, MemoryStore {
  constructor(config: GitMemoryStoreConfig)

  // --- Storage (ContextManager L1) ---
  async store(key: string, content: Uint8Array, contentType?: string): Promise<string>
  async retrieve(reference: string): Promise<{ content: Uint8Array; contentType: string }>

  // --- MemoryStore (MemoryManager L2) ---
  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
  async add(content: string, metadata?: Record<string, JSONValue>): Promise<void>
}
```



### Method Behavior

**`store(key, content, contentType?)`**

Called by the context offloader when content is evicted from the context window. The `key` is a unique identifier for the content block (provided by the offloader), and `contentType` is the MIME type (e.g., `text/plain`, `image/png`). Writes the content as a file to `sessions/`, commits it, and returns the file path as a reference string.

**`retrieve(reference)`**

Takes the reference string returned by `store()` and reads the file back. Returns the content and its content type. Called when content is evicted from the context window (when the agent needs previouslt evicted content back in the context window).

**`add(content, metadata?)`**

Writes a new markdown file to `knowledge/facts/` and commits it. `add()` is a pure filesystem write so there's no model call.

- **Filename:** `metadata.title` if present, otherwise first few words of the content plus a timestamp (e.g., `testing-preferences.md` or `user-prefers-dark-mode-1718234.md`)
- **Frontmatter `description`:** `metadata.description` if present, otherwise first sentence of the content

The `metadata` fields come from the `ModelExtractor` when automatic extraction is configured — its system prompt instructs it to produce a title and description for each extracted fact (see [Appendix A](#appendix-a-extraction-configuration) for the configuration example). When the agent uses the `store_memory` tool instead (explicit write), no extractor is involved — `add()` receives raw content with no metadata and falls back to deriving both from the content.

**`search(query, options?)`**

Required by the `MemoryStore` interface. Performs keyword matching (grep) against filenames, `description` frontmatter, and file content, excluding `knowledge/system/` (already loaded in full). Returns the top matches as `MemoryEntry[]`, ranked by term frequency. No model call, no embeddings.

Progressive disclosure (see [Progressive Disclosure](#progressive-disclosure)) is the primary retrieval mechanism for GitMemoryStore — the agent sees the file tree in its system prompt and navigates knowledge directly using filesystem tools. The [`search_memory` tool](https://github.com/strands-agents/docs/blob/main/designs/0011-memory-manager.md) serves as a fallback: it retrieves actual content in a single tool call, preventing hallucination in cases where the agent might respond based on filenames/descriptions alone without reading the underlying files.

### Integration with Existing Features

`GitMemoryStore` can replace two separate backends with just one:

```typescript
import { Agent, ContextManager, MemoryManager } from "@strands-agents/sdk";
import { GitMemoryStore } from "@strands-agents/sdk/vended-memory-stores";

const myStore = new GitMemoryStore({
    name: "agent-memory",
    repoPath: "./.agent-memory",
});

const agent = new Agent({
    model,
    contextManager: new ContextManager({
        storage: myStore, // L1 backend
    }),
    memoryManager: new MemoryManager({
        stores: [myStore], // L2 backend; supports multiple knowledge stores
    }),
});
```

### File Hierarchy

Both the `ContextManager` and `MemoryManager` write to the same repository but are isolated by path: L1 writes to `sessions/`, while L2 writes to `knowledge/`. Consolidation metadata lives in `consolidation/`. They share a single branch (`main` by default).

```
agent_memory/
├── .git/
├── sessions/                        # L1 - ContextManager writes here
│   ├── current.md
│   └── history/
│       ├── 2026-06-10-session-a.md
│       └── 2026-06-11-session-b.md
├── knowledge/                       # L2 - MemoryManager writes here
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

## Consolidation

Consolidation improves memory quality after facts accumulate. It is a developer-invoked Strands agent exposed as a method on `MemoryManager` (defined under `src/memory/consolidation/`). It reads stored knowledge, reasons across files, and writes changes directly to the git repo via filesystem tools (`readFile`, `writeFile`, `deleteFile`, `gitCommit`). Every change is a git commit, so bad consolidation is trivially reversible with `git revert`.

All extracted facts land in `knowledge/facts/` by default — `GitMemoryStore.add()` writes there unconditionally for simplicity and to avoid a classification model call on every extraction. Consolidation is therefore responsible for reorganizing files into appropriate subdirectories (`skills/`, `system/`, etc.) during offline maintenance, when it has full cross-file context to make informed categorization decisions.

### How It Works

```
memoryManager.consolidate(config)
│
├─ 1. SCOPE: find eligible files
│     scope: "since-last" → files modified since last run (reads last timestamp from consolidation/changelog.md, uses git to find files changed after that date)
│     scope: "all"        → everything in knowledge/
│
├─ 2. CLUSTER: group files by subdirectory
│     cluster 1 (facts/): [dark-mode.md, editor-preferences.md, deploy-process.md]
│     cluster 2 (skills/): [debugging.md, code-review.md]
│
├─ 3. EXECUTE: create one Strands agent, invoke it once per cluster:
│     - model:        the LLM passed in config (does the reasoning)
│     - system prompt: built from config.operations (e.g. "deduplicate", "prune")
│     - tools:        readFile, writeFile, deleteFile, gitCommit
│     → for each cluster, agent reads files, applies operations, commits each change
│
└─ 4. RECORD: append timestamp + summary to consolidation/changelog.md
```

### Operations

The `operations` config controls which directives go into the agent's system prompt. They are prompt instructions — the LLM decides how to apply them.

| Operation | Agent behavior | Example |
|-----------|---------------|---------|
| `deduplicate` | Merge files expressing the same fact | "User prefers dark mode" + "Theme preference: dark" → one file |
| `resolve-contradictions` | Keep the more recent/confident fact, delete the other | "Uses tabs" (April) vs "Uses spaces" (June) → keeps spaces |
| `derive-insights` | Combine related facts into a higher-level pattern | 3 testing facts → "Testing philosophy: high-fidelity, boundary-mocked" |
| `prune` | Delete stale/superseded entries | Fact with `access_count: 1`, last accessed 90 days ago → deleted |
| `reorganize` | Move files to appropriate subdirectories based on content | Fact about debugging patterns in `facts/` → moved to `skills/debugging.md` |

### Usage

Since Strands is a client-side SDK with no server process, consolidation needs an external trigger. Two invocation patterns:

```typescript
// Option 1: Via the agent's existing MemoryManager (e.g., after a session)
await agent.memoryManager.consolidate({
  model,
  operations: ["deduplicate", "resolve-contradictions"],
  scope: "since-last",
});

// Option 2: Standalone script (no agent session needed — for cron, GitHub Action, CLI)
const memoryManager = new MemoryManager({ stores: [myStore] });
await memoryManager.consolidate({
  model,
  operations: ["deduplicate", "resolve-contradictions"],
  scope: "since-last",
});
```

Scheduling frequency is controlled externally by the GitHub Action or cron job. See [Appendix B](#appendix-b-github-action-yaml) for a GitHub Action example.

See [Appendix C](#appendix-c-consolidation-examples) for the full usage script with nightly vs. weekly patterns for option 2.

### Output

Each operation produces an individual git commit with a descriptive message (e.g., `Consolidate(deduplicate): merge dark-mode.md into editor-preferences.md`). A summary is appended to `consolidation/changelog.md`, which serves as both an audit log and the cursor for `scope: "since-last"`. See [Appendix C](#appendix-c-consolidation-examples) for example output.

---

## Progressive Disclosure

Not everything loads into context every turn. The agent retrieves relevant knowledge on demand by navigating the memory repository directly. LLMs are precise and accurate at scoped filesystem calls (listing directories, grepping for keywords, reading specific files), and progressive disclosure leverages this skill as the primary retrieval mechanism.

### How It Works

GitMemoryStore registers two things on the agent at initialization:

**1. The file tree (always in the system prompt)**

The full directory listing of `knowledge/` with each file's `description` frontmatter is injected into the agent's system prompt every turn. The agent always knows what knowledge exists without loading the content:

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

The agent uses the file tree to judge relevance by filename and description, then loads specific files with `readFile` or searches across files with `grep`. For a targeted question, it reads a single matching file. For a broader query, it greps across `knowledge/`, then reads the best matches. See [Appendix D](#appendix-d-retrieval-worked-examples) for worked examples.

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

## Alternatives Considered

### 1. Branching: Separate branch per session

Each session writes to its own branch, merges back to `main` on close.

**Why rejected:** Path-based isolation (`sessions/{id}.md`) achieves the same separation without branch management overhead or merge conflicts.

### 2. Consolidation: Inline during agent sessions

Trigger consolidation within the agent loop (e.g., every N turns) instead of externally.

**Why rejected:** Consolidation reads many files and calls a model — running it mid-session adds latency to agent responses. Since Strands is a client-side SDK with no background process, there's no way to run it asynchronously without blocking the user. External invocation (GitHub Action, CLI) keeps the agent loop fast and gives developers cost control.

### 3. Consolidation: Deterministic rules instead of LLM

Hard-coded deduplication rules (e.g., cosine similarity > 0.95 → merge).

**Why rejected:** Rules miss semantic duplicates ("User prefers dark mode" vs. "Theme preference: dark") and can't derive insights from combining related facts. LLM judgment handles nuance. Non-determinism is mitigated by every change being a reversible git commit.

### 4. File placement: Classify at extraction time

Have `GitMemoryStore.add()` call a model to categorize each fact (e.g., preference, skill, project fact) and write it directly to the appropriate subdirectory (`skills/`, `system/`, etc.).

**Why rejected:** Adds a classification model call to every extraction, increasing latency and token cost during agent sessions. The classifier also only sees a single fact in isolation, leading to worse categorization than the consolidation agent, which sees all files together and can make informed cross-file decisions. Writing everything to `facts/` by default keeps `add()` fast and simple, and lets consolidation handle reorganization with full context during offline maintenance.

### 5. Retrieval: Heuristic scoring with metadata

Score files using frontmatter metadata (tags, recency, access frequency) and load top-K within a token budget. No agent involvement in retrieval.

**Why rejected:** Requires building metadata infrastructure (tag extraction, scoring weights, access counters). Vector store backends like Bedrock Knowledge Bases have embeddings and similarity scoring server-side, making programmatic scoring natural. For a filesystem store there is no equivalent infrastructure — the agent's own judgment (navigating via filenames and descriptions) is the better retrieval engine.

---

## Consequences

### What Becomes Easier

- No ongoing infrastructure costs for storage and retrieval — everything runs locally. Only LLM calls (extraction, consolidation) cost tokens, and those are controlled by the developer.
- Cross-session knowledge with zero external infrastructure (no vector DB, no managed service)
- Full audit trail — every memory change is a git commit with an informative message
- Rollback is `git revert`, not a custom undo system
- Developer debugging — `git diff` shows exactly what consolidation or extraction changed
- Portability — memory repo can be cloned, forked, or shared to seed other agents with a knowledge base

### What Becomes Harder

- Scaling beyond ~1,000 knowledge files — git operations (`status`, `commit`) slow down with large working trees
- Concurrent writes from multiple agent instances — simultaneous commits to the same repo require coordination (file locking or single-writer constraint)
- Retrieval quality depends on model judgment — the agent must recognize when to search and what to read; if it doesn't look, relevant memories stay hidden
- Consolidation cost and non-determinism — each run calls a model, costs tokens, and may produce different results on re-runs (mitigated by every change being a reversible commit)
- Repo size growth — sessions accumulate indefinitely; may need periodic `git gc` or a retention policy for old session files



---

## Willingness to Implement

Yes.


---
<details>
  <summary><b>Appendix A: Extraction Configuration</b></summary>

```typescript
const myStore = new GitMemoryStore({
  name: "agent-memory",
  repoPath: "./.agent-memory",
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
  <summary><b>Appendix B: GitHub Action YAML</b></summary>

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
  <summary><b>Appendix C: Consolidation Examples</b></summary>

### Full Usage Script

```typescript
// consolidate.ts — run via cron, GitHub Action, or manually
import { MemoryManager } from "@strands-agents/sdk";
import { GitMemoryStore } from "@strands-agents/sdk/vended-memory-stores";

const myStore = new GitMemoryStore({
  name: "agent-memory",
  repoPath: "./.agent-memory",
});

const memoryManager = new MemoryManager({ stores: [myStore] });

// Nightly incremental (cheap — only processes new files)
await memoryManager.consolidate({
  model,
  operations: ["deduplicate", "resolve-contradictions"],
  scope: "since-last",
});

// Weekly deep clean (expensive — processes everything)
await memoryManager.consolidate({
  model,
  operations: ["deduplicate", "resolve-contradictions", "derive-insights", "prune"],
  scope: "all",
});
```

### Example Output

Each operation produces an individual git commit:

```
$ git log --oneline
a3f2c1d Consolidate(deduplicate): merge dark-mode.md into editor-preferences.md
b7e4a2f Consolidate(resolve): keep "uses spaces" over "uses tabs" (recency: June vs April)
c9d1b3e Consolidate(derive): synthesize testing-philosophy.md from 3 entries
```

And appends to `consolidation/changelog.md` (serves as both audit log and cursor for `scope: "since-last"`):

```markdown
## 2026-06-15 02:00 (nightly)
- Merged `facts/dark-mode.md` into `facts/editor-preferences.md` (duplicate)
- Pruned `facts/old-deploy-process.md` (last accessed 2026-03-01, access_count: 1)
- Derived `facts/testing-philosophy.md` from 3 related entries
```

### Concurrent Consolidation (Nice to Have)

Multiple consolidation operations can run in parallel via git worktrees — each operation works on an isolated copy, then results are merged back. This enables parallelizing expensive operations (e.g., deduplication across one knowledge domain while resolving contradictions in another) without conflicts.

```typescript
await memoryManager.consolidate({
  model,
  concurrency: 4, // number of parallel worktrees
  operations: ["deduplicate", "resolve-contradictions"],
});
```

</details>

<details>
  <summary><b>Appendix D: Retrieval Worked Examples</b></summary>

```
User asks: "how should I structure these tests?"

Agent sees file tree → spots "testing-philosophy.md" (description: "Integration-first, mock at boundaries")
Agent calls: readFile("knowledge/facts/testing-philosophy.md")
→ full content loaded into context, agent answers using the loaded knowledge
```

For broader queries:

```
User asks: "what do you know about our deploy process?"

Agent calls: grep("deploy", "knowledge/")
→ finds matches in deploy-process.md, project-architecture.md
Agent calls: readFile("knowledge/facts/deploy-process.md")
→ loads the relevant file, answers from it
```

</details>

<details>
  <summary><b>Appendix E: Success Criteria & Benchmarks</b></summary>

### Deep Memory Retrieval (DMR)

Have the agent accumulate knowledge across sessions stored in GitMemoryStore, then test whether it can recall facts from session 1 after 10+ sessions have passed. Compare recall accuracy with vs. without consolidation to measure consolidation's impact on long-horizon retrieval quality.

### File-Hierarchy Retrieval vs. Embeddings

Compare progressive disclosure (file tree + agent navigation) against embedding-based retrieval. Letta's research found that their filesystem approach scored 74.0% on the LoCoMo benchmark by storing conversational histories in files — beating specialized memory tool libraries. Evaluate GitMemoryStore against the same or similar benchmarks.

### Consolidation Frequency

Measure the relationship between consolidation frequency and token cost vs. retrieval quality. Research suggests diminishing returns — find the optimal cadence that preserves retrieval quality without excessive token usage.

</details>