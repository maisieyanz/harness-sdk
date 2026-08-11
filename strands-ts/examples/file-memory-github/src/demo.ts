/**
 * An interactive session over the GitHub-backed memory store.
 *
 * The three-step scripts (`seed`, `ask`, `consolidate`) each build their own agent, so each starts with
 * an empty message history. This runs one agent for the whole session instead, which is what makes
 * follow-up questions possible and lets the cost of disclosure be observed over several turns: the
 * listing is re-injected every turn, but a file already read stays in context, so asking twice about
 * one topic reads the files once.
 *
 * Seeding and consolidation are commands here rather than separate processes. Each still lands as its
 * own commit, so the repo remains the audit trail — `/repo` prints the URL to watch.
 *
 * Chat is read-only: nothing the agent is told during a session is written back. That keeps the seeded
 * corpus fixed, so `/consolidate` acts on exactly the planted defects.
 *
 * Usage (credentials come from .env — see .env.example):
 *   npm run demo
 */

import * as readline from 'node:readline'
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { awaitConsistentListing, createDemoTarget, createModel, heading, printListing } from './shared.js'
import { SEED_ENTRIES } from './seed-corpus.js'

/** Where consolidation records what it changed and why, relative to the store's namespace. */
const CHANGELOG_KEY = 'consolidation-changelog.md'

/** Inputs that end the session, matching the conventions a shell user already expects. */
const EXIT_COMMANDS = new Set(['/quit', '/exit', 'quit', 'exit', 'q'])

async function main(): Promise<void> {
  const { owner, repo, branch, storage, scoped, memoryStore } = createDemoTarget()

  const agent = new Agent({
    model: createModel(),
    memoryManager: new MemoryManager({ stores: [memoryStore], injection: false }),
    // The default printer would write the answer itself; this session streams manually so tool calls
    // can be printed as they happen, which is the part worth watching.
    printer: false,
    systemPrompt: 'You are a code review assistant. Answer from your memory files, and cite the paths you used.',
  })

  const readline_ = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (): Promise<string> => new Promise((resolve) => readline_.question('\n> ', resolve))

  heading(`File Memory Store — ${owner}/${repo} (branch: ${branch})`)
  printHelp()

  // Empty on a first run, so the opening listing doubles as a prompt to /seed.
  console.log('\nCurrent memory:\n')
  await printListing(memoryStore)

  for (;;) {
    let input: string
    try {
      input = await ask()
    } catch {
      // readline rejects on Ctrl-D / closed stdin, which is an ordinary way to leave.
      break
    }

    const trimmed = input.trim()
    if (!trimmed) continue
    if (EXIT_COMMANDS.has(trimmed.toLowerCase())) break

    try {
      if (trimmed.startsWith('/')) {
        await runCommand(trimmed.toLowerCase(), { owner, repo, branch, storage, scoped, memoryStore })
      } else {
        await runTurn(agent, trimmed, memoryStore)
      }
    } catch (error: unknown) {
      // A failed turn or command must not end the session — an expired token or a throttled model is
      // recoverable, and losing the agent's history to it would mean restarting the demo.
      console.error(`\n  ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  readline_.close()
  console.log('\nBye!\n')
}

/**
 * Runs one chat turn, printing tool calls as they happen and the answer as it streams.
 *
 * @param agent - The session's agent, whose history carries across turns
 * @param question - The user's input
 * @param memoryStore - The store, read for the file count the summary line reports against
 */
async function runTurn(
  agent: Agent,
  question: string,
  memoryStore: ReturnType<typeof createDemoTarget>['memoryStore']
): Promise<void> {
  const totalFiles = (await memoryStore.listFiles()).length

  // Track distinct paths rather than call count, so a repeated read is not counted twice
  const readPaths = new Set<string>()
  let answer = ''
  let streamedAnswer = false

  for await (const event of agent.stream(question)) {
    if (event.type === 'beforeToolCallEvent') {
      const path = (event.toolUse.input as { path?: string }).path
      console.log(`  [reads] ${path ?? JSON.stringify(event.toolUse.input)}`)
      if (path) readPaths.add(path)
    }
    // Check the value, not just the key: a tool-use turn emits a text block whose `text` is undefined.
    // The type must be narrowed too — a guard-content block carries an object under the same key.
    if (
      event.type === 'contentBlockEvent' &&
      'text' in event.contentBlock &&
      typeof event.contentBlock.text === 'string'
    ) {
      if (!streamedAnswer) {
        console.log('')
        streamedAnswer = true
      }
      process.stdout.write(event.contentBlock.text)
      answer += event.contentBlock.text
    }
  }

  if (!answer.trim()) console.log('\n  (no answer returned)')
  console.log('')

  // A turn that reads nothing is the interesting case once a topic is already in context, so report it
  // rather than staying silent.
  console.log(
    readPaths.size === 0
      ? `  read 0 of ${totalFiles} files — answered from what earlier turns already pulled in`
      : `  read ${readPaths.size} of ${totalFiles} files — the rest never entered context`
  )
}

/** Everything a command needs: repo coordinates plus the storage and store. */
type CommandContext = ReturnType<typeof createDemoTarget>

/**
 * Dispatches a slash command.
 *
 * @param command - The lowercased input, including the leading slash
 * @param context - Repo coordinates, storage backend, and memory store
 */
async function runCommand(command: string, context: CommandContext): Promise<void> {
  const { owner, repo, branch, storage, scoped, memoryStore } = context

  switch (command) {
    case '/help':
      printHelp()
      return

    case '/list':
      console.log('')
      await printListing(memoryStore)
      return

    case '/repo':
      console.log(`\n  https://github.com/${owner}/${repo}/tree/${branch}`)
      console.log(`  https://github.com/${owner}/${repo}/commits/${branch}`)
      return

    case '/seed':
      await seed(storage, memoryStore)
      return

    case '/consolidate':
      await consolidate(context)
      return

    case '/changelog': {
      const changelogBytes = await scoped.read(CHANGELOG_KEY)
      console.log(
        `\n${changelogBytes ? new TextDecoder().decode(changelogBytes) : '  (no changelog yet — run /consolidate)'}`
      )
      return
    }

    default:
      console.log(`\n  Unknown command: ${command}. Try /help.`)
  }
}

/** Writes the seed corpus as a single commit. */
async function seed(storage: CommandContext['storage'], memoryStore: CommandContext['memoryStore']): Promise<void> {
  const existing = await memoryStore.listFiles()
  if (existing.length > 0) {
    console.log(`\n  Store already holds ${existing.length} files. Reset it first — see the README.`)
    return
  }

  console.log('')
  // One commit for the whole seed, rather than a commit per file. Without this the seed would be a
  // dozen commits and burn a dozen round trips against the API rate limit.
  storage.beginBatch()
  for (const entry of SEED_ENTRIES) {
    await memoryStore.add(entry.content, { path: entry.path, description: entry.description })
    console.log(`  + ${entry.path}`)
  }
  await storage.commitBatch(`seed ${SEED_ENTRIES.length} knowledge files`)

  console.log(`\n  Committed ${SEED_ENTRIES.length} files as a single commit.\n`)
  await printListing(memoryStore)

  console.log('\n  Seeded defects for consolidation to fix:')
  console.log('    duplicate      facts/dark-mode-preference.md + facts/theme-setting.md')
  console.log('    contradiction  facts/indentation-tabs.md (March) vs facts/indentation-spaces.md (June)')
  console.log('    related facts  the three facts/testing-*.md files share one principle')
}

/** Plans and executes a consolidation pass as a single commit, then shows the result. */
async function consolidate(context: CommandContext): Promise<void> {
  const { storage, scoped, memoryStore } = context

  const before = await memoryStore.listFiles()
  if (before.length === 0) {
    console.log('\n  Store is empty — run /seed first.')
    return
  }

  console.log('\n  Planning — deduplicate, resolveContradictions, deriveInsights, reorganize ...\n')

  // Buffer every write and delete the run makes, so the whole consolidation is one atomic commit.
  storage.beginBatch()
  await memoryStore.consolidate({
    model: createModel(),
    operations: ['deduplicate', 'resolveContradictions', 'deriveInsights', 'reorganize'],
  })
  await storage.commitBatch('consolidation — deduplicate, resolve contradictions, derive insights')

  console.log('  Consolidation committed as a single commit.\n')

  await awaitConsistentListing(memoryStore)
  await printListing(memoryStore)

  const after = await memoryStore.listFiles()
  console.log(`\n  ${before.length} files → ${after.length} files. See /changelog for the reasoning.`)
  console.log('  Ask about indentation again — one file now answers what took reconciling before.')
}

/** Prints the command list. */
function printHelp(): void {
  console.log('  Ask a question, or run a command:\n')
  console.log('    /seed         write the 9-file corpus (one commit)')
  console.log('    /list         print the injected file listing')
  console.log('    /consolidate  run a consolidation pass (one commit)')
  console.log('    /changelog    print consolidation-changelog.md')
  console.log('    /repo         print the repo and commit-history URLs')
  console.log('    /help         this list')
  console.log('    /quit         leave')
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
