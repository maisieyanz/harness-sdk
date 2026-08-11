# File Memory Store + GitHub Storage

`FileMemoryStore` backed by a GitHub repository. Memory is markdown files in a real repo, so every
change to what the agent knows is a commit you can diff, review, blame, and revert.

There are two ways to run it.

**`npm run demo`** — one interactive session. Ask questions, and drive the demo beats with commands:

| Command        | What it does                           |
| -------------- | -------------------------------------- |
| `/seed`        | write the 9-file corpus (one commit)   |
| `/list`        | print the injected file listing        |
| `/consolidate` | run a consolidation pass (one commit)  |
| `/changelog`   | print `consolidation-changelog.md`     |
| `/repo`        | print the repo and commit-history URLs |
| `/help`        | the command list                       |
| `/quit`        | leave                                  |

One agent serves the whole session, so its message history carries across turns. That is what the
three scripts below cannot show: follow-up questions work, and because a file already read stays in
context while the listing is re-injected each turn, asking twice about one topic reads the files once —
the second turn reports reading 0 files. Chat is read-only, so the seeded corpus stays exactly as
written and `/consolidate` acts on precisely the planted defects.

**Three separate scripts** — the same beats as one-shot processes, each its own agent, so you can
inspect the repo on GitHub in between:

| Step | Command               | What it shows                                                    |
| ---- | --------------------- | ---------------------------------------------------------------- |
| 1    | `npm start`           | Seeding — 9 knowledge files, one commit                          |
| 2    | `npm run ask`         | Progressive disclosure — the agent opens only the files it needs |
| 3    | `npm run consolidate` | Consolidation — an offline pass that fixes the corpus            |

## What each step demonstrates

**Progressive disclosure.** This is the store's default retrieval mode, not something the demo turns
on: `FileMemoryStore` hands the `MemoryManager` a plugin that injects the _listing_ each turn — every
file's path and one-line description — and registers a `read_agent_memory_file` tool. Attach the store
to an agent and you get both; step 2 is a separate command only so you can watch the tool calls, not
because anything needs invoking. The model decides what to open, and on the seeded corpus it reads 5 of
9 files; the other 4 never cost a token. Pass `disclosure: false` to opt out.

The demo pairs the store with `injection: false` on the manager, which turns off its keyword-search
injection. The listing is a better map of memory than a search's top hits, and both would compete for
the same context budget.

**Consolidation.** One structured-output call plans actions over the whole corpus, guardrails validate
the entire plan, then deterministic code executes it. The seed contains three defects on purpose:

| Defect          | Files                                                     | Expected fix                             |
| --------------- | --------------------------------------------------------- | ---------------------------------------- |
| Duplicate       | `dark-mode-preference` + `theme-setting`                  | merge into one file                      |
| Contradiction   | `indentation-tabs` (March) vs `indentation-spaces` (June) | keep the June fact, delete the stale one |
| Scattered facts | three `testing-*` files                                   | synthesize one philosophy file           |

A run takes the store from 9 files to 5, and writes `consolidation-changelog.md` recording every action
with the model's reasoning. The model chooses the merged filenames, so they vary between runs.

**Atomic commits.** `GithubStorage.beginBatch()` / `commitBatch()` buffer a multi-file change into a
single commit. Without it, seeding would be 9 commits and consolidation another 8 — it touches eight
paths (two writes, five deletes, and the changelog). With it, the whole run is one reviewable diff.

## Setup

You need a GitHub repo to use as the memory store, a token that can write to it, and Bedrock access.

1. Create a repository (initialized with a README so the default branch exists).
2. Create a fine-grained personal access token scoped to that repo with **Contents: Read and write**.
3. Create your `.env` — the npm scripts load it automatically, so there is nothing to export per
   shell. It is gitignored.

```bash
cp .env.example .env
$EDITOR .env         # fill in GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO
```

4. Install and run:

```bash
npm install
npm run demo         # interactive session — /seed, ask questions, /consolidate

# or the same beats as separate processes
npm start            # step 1 — seed
npm run ask          # step 2 — progressive disclosure
npm run consolidate  # step 3 — consolidate
```

Environment variables already exported in your shell take precedence over `.env`, so you can override
any single value inline — `MODEL_ID=... npm run ask` — without editing the file.

AWS credentials are deliberately not part of `.env`. They resolve through the standard AWS chain, so
whatever already works for the `aws` CLI works here — an exported set from your usual refresh command, a
profile, or an instance role. Only `AWS_REGION` is in `.env`, because it is configuration rather than a
credential.

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
    ├── facts/…                    # every knowledge file
    └── consolidation-changelog.md # audit trail, excluded from the listing
```

Paths are otherwise arbitrary — the store imposes no taxonomy. It gives meaning to exactly two keys:
`facts/` is where `add()` writes an entry that carries no explicit path, and
`consolidation-changelog.md` is reserved. The changelog is excluded from the listing, from search, and
from consolidation's own input, because it is an audit artifact rather than knowledge; `add()` rejects
any attempt to write to it.

The seed puts everything under `facts/` for that reason. Group files however suits your domain — just
know that a directory name carries no behavior, so nesting is for your benefit when reading the repo,
not a signal to the store.

## Resetting

Each step assumes the one before it, so re-run them from a clean store. Delete `memory/` and commit;
the next `npm start` (or `/seed`) reseeds from scratch. `/seed` refuses to write into a non-empty
store, so a stale corpus surfaces as a message rather than a confusing double-seed:

```bash
gh repo clone <owner>/<repo> /tmp/reset -- --depth 1
git -C /tmp/reset rm -rq memory
git -C /tmp/reset commit -m "reset: clear memory store"
git -C /tmp/reset push
```

Running `npm run ask` against an already-consolidated store still works, but it reads fewer files and
the defects it would otherwise have to reconcile are gone.

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
