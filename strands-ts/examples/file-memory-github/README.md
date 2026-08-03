# File Memory Store + GitHub Storage

`FileMemoryStore` backed by a GitHub repository. Memory is markdown files in a real repo, so every
change to what the agent knows is a commit you can diff, review, blame, and revert.

The demo runs in three steps, each its own process, so you can inspect the repo on GitHub in between:

| Step | Command               | What it shows                                                    |
| ---- | --------------------- | ---------------------------------------------------------------- |
| 1    | `npm start`           | Seeding — 10 knowledge files, one commit                         |
| 2    | `npm run ask`         | Progressive disclosure — the agent opens only the files it needs |
| 3    | `npm run consolidate` | Consolidation — an offline pass that fixes the corpus            |

## What each step demonstrates

**Progressive disclosure.** The store injects only the _listing_ each turn — every file's path and
one-line description — and registers a `read_agent_memory_file` tool. The model decides what to open.
In step 2 it reads 5 of 10 files; the other 5 never cost a token. This is why the store is paired with
`injection: false`: the listing is a better map of memory than a keyword search's top hits, and both
would compete for the same context budget.

**Consolidation.** One structured-output call plans actions over the whole corpus, guardrails validate
the entire plan, then deterministic code executes it. The seed contains three defects on purpose:

| Defect          | Files                                                     | Expected fix                             |
| --------------- | --------------------------------------------------------- | ---------------------------------------- |
| Duplicate       | `dark-mode-preference` + `theme-setting`                  | merge into one file                      |
| Contradiction   | `indentation-tabs` (March) vs `indentation-spaces` (June) | keep the June fact, delete the stale one |
| Scattered facts | three `testing-*` files                                   | synthesize one philosophy file           |

A run takes the store from 10 files to 6, and writes `consolidation-changelog.md` recording every
action with the model's reasoning.

**Atomic commits.** `GithubStorage.beginBatch()` / `commitBatch()` buffer a multi-file change into a
single commit. Without it, seeding would be 10 commits and consolidation another 9. With it, the
consolidation diff reads as one reviewable change.

## Setup

You need a GitHub repo to use as the memory store, a token that can write to it, and Bedrock access.

1. Create a repository (initialized with a README so the default branch exists).
2. Create a fine-grained personal access token scoped to that repo with **Contents: Read and write**.
3. Export the environment:

```bash
export GITHUB_TOKEN=github_pat_...
export GITHUB_OWNER=your-username
export GITHUB_REPO=agent-memory-demo
```

4. Install and run:

```bash
npm install
npm start            # step 1 — seed
npm run ask          # step 2 — progressive disclosure
npm run consolidate  # step 3 — consolidate
```

### Options

| Variable              | Purpose                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_BRANCH`       | Branch to read and commit to. Defaults to `main`.                                                                                    |
| `MODEL_ID`            | Bedrock model. Defaults to `global.anthropic.claude-sonnet-5`.                                                                       |
| `BEDROCK_NO_STREAM=1` | Use the non-streaming Converse API — needed on a role granted `bedrock:InvokeModel` but not `bedrock:InvokeModelWithResponseStream`. |

`npm run ask -- "your own question"` asks something other than the default.

## Where the files land

Keys are scoped under `memory/<store name>/`, so the store never collides with anything else in the
repo:

```
your-repo/
└── memory/agent-memory/
    ├── system/persona.md          # role and constraints
    ├── facts/…                    # what the agent has learned
    ├── skills/…                   # procedural knowledge
    └── consolidation-changelog.md # audit trail, excluded from the listing
```

The changelog is deliberately excluded from the listing, from search, and from consolidation's own
input — it is an audit artifact, not knowledge.

## Resetting

Delete the `memory/` directory and commit; the next `npm start` reseeds from scratch.

## A note on the listing right after a push

GitHub may serve a cached tree for a few seconds after a commit, so an immediate listing can still
enumerate deleted paths. `listFiles` skips files whose read fails, so this under-reports rather than
erroring. The demo polls until two consecutive listings agree (`awaitConsistentListing` in
`shared.ts`) purely so the before/after comparison is honest — a scheduled consolidation job would
not need it.

## Running consolidation on a schedule

Consolidation is an offline maintenance pass, not something on the agent's hot path. In production it
belongs in a scheduled job:

```yaml
name: Memory Consolidation
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:

jobs:
  consolidate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: us-west-2
      - run: npm ci
      - run: npm run consolidate
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_OWNER: ${{ github.repository_owner }}
          GITHUB_REPO: ${{ github.event.repository.name }}
```
