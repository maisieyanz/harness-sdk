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
 * Chat is read-only until `/learn` turns extraction on, so a session can show memory *forming* from
 * conversation and not just being read. It stays off by default because a write mid-session would
 * change the corpus `/consolidate` acts on, and the planted defects are the point of that step.
 *
 * Usage (credentials come from .env — see .env.example):
 *   npm run demo
 */

import * as readline from 'node:readline'
import {
  Agent,
  AfterInvocationEvent,
  ExtractionTrigger,
  HookOrder,
  MemoryManager,
  type ExtractionTriggerContext,
  type InvokableTool,
} from '@strands-agents/sdk'
import { awaitConsistentListing, createDemoTarget, createModel, heading, printListing } from './shared.js'
import { SEED_ENTRIES } from './seed-corpus.js'

/** Where consolidation records what it changed and why, relative to the store's namespace. */
const CHANGELOG_KEY = 'consolidation-changelog.md'

/** Inputs that end the session, matching the conventions a shell user already expects. */
const EXIT_COMMANDS = new Set(['/quit', '/exit', 'quit', 'exit', 'q'])

/**
 * Runs extraction after a turn, but only while `/learn` is on.
 *
 * Extraction is configured on the store at construction and wired through hooks at agent init, so it
 * cannot be attached and detached at runtime. A trigger reading a mutable flag gives the same effect:
 * always attached, fires only when the session has opted in.
 */
class ToggledTrigger extends ExtractionTrigger {
  readonly name = 'toggled'

  /** Whether extraction should run after the next turn. Flipped by `/learn`. */
  enabled = false

  attach(context: ExtractionTriggerContext): void {
    // SDK_LAST matches the built-in InvocationTrigger: run after the SDK's own after-invocation hooks
    // so extraction sees the fully settled turn. Firing earlier extracts a partial turn, and the rest
    // of it then extracts again as a second entry.
    context.agent.addHook(
      AfterInvocationEvent,
      () => {
        if (this.enabled) context.fire()
      },
      { order: HookOrder.SDK_LAST }
    )
  }
}

async function main(): Promise<void> {
  const learnTrigger = new ToggledTrigger()
  const { owner, repo, branch, storage, scoped, memoryStore } = createDemoTarget({
    extraction: { trigger: learnTrigger },
  })

  const memoryManager = new MemoryManager({ stores: [memoryStore], injection: false })
  const agent = new Agent({
    model: createModel(),
    memoryManager,
    // The default printer would write the answer itself; this session streams manually so tool calls
    // can be printed as they happen, which is the part worth watching.
    printer: false,
    // The last clause keeps the model from disclaiming that it cannot save memory: extraction happens
    // outside the turn, so without this it narrates a limitation the demo is actively disproving.
    systemPrompt:
      'You are a code review assistant. Answer from your memory files, and cite the paths you used. ' +
      'Durable facts from this conversation are persisted for you automatically — never tell the user ' +
      'you are unable to save something to memory.',
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
        await runCommand(trimmed, { owner, repo, branch, storage, scoped, memoryStore }, learnTrigger)
      } else {
        await runTurn(agent, trimmed, memoryStore, learnTrigger.enabled ? memoryManager : undefined)
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
 * @param memoryManager - Supplied only while `/learn` is on, to await extraction and report what it wrote
 */
async function runTurn(
  agent: Agent,
  question: string,
  memoryStore: ReturnType<typeof createDemoTarget>['memoryStore'],
  memoryManager?: MemoryManager
): Promise<void> {
  const before = await memoryStore.listFiles()
  const totalFiles = before.length

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

  if (memoryManager) await reportExtraction(memoryManager, memoryStore, before)
}

/**
 * Waits for the turn's extraction to finish and names the files it wrote.
 *
 * Extraction is fire-and-forget: the trigger dispatches it in the background so the agent is never
 * blocked on a write. `flush()` is what makes it observable in a demo — without it the commit would
 * usually land after the next prompt had already been drawn.
 *
 * @param memoryManager - The manager whose coordinator owns the pending extraction
 * @param memoryStore - The store to re-list for a before/after comparison
 * @param before - The listing captured before the turn
 */
async function reportExtraction(
  memoryManager: MemoryManager,
  memoryStore: ReturnType<typeof createDemoTarget>['memoryStore'],
  before: { path: string; description: string }[]
): Promise<void> {
  await memoryManager.flush()

  const beforePaths = new Set(before.map((file) => file.path))

  // GitHub can serve a cached tree for a few seconds after a push, so the first listing after a write
  // may not show it yet. Re-list until something new appears rather than reporting a write as a no-op.
  let added: { path: string; description: string }[] = []
  for (let attempt = 0; attempt < 5 && added.length === 0; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500))
    added = (await memoryStore.listFiles()).filter((file) => !beforePaths.has(file.path))
  }

  // Silence is the honest answer when a turn held no durable fact — extraction declining to write is
  // as much a part of the behavior as writing.
  if (added.length === 0) {
    console.log('  [memory] nothing worth keeping from that turn')
    return
  }
  for (const file of added) {
    console.log(`  [memory] + ${file.path} — ${file.description}`)
  }
}

/** Everything a command needs: repo coordinates plus the storage and store. */
type CommandContext = ReturnType<typeof createDemoTarget>

/**
 * Dispatches a slash command.
 *
 * @param input - The raw input, including the leading slash, with its original case preserved
 * @param context - Repo coordinates, storage backend, and memory store
 */
async function runCommand(input: string, context: CommandContext, learnTrigger: ToggledTrigger): Promise<void> {
  const { owner, repo, branch, storage, scoped, memoryStore } = context

  // `/read` carries a path, matched by prefix before the exact-match cases below. The path keeps the
  // input's case: store keys are case-sensitive, so lowercasing it would break a mixed-case filename.
  if (/^\/read(\s|$)/i.test(input)) {
    await showDisclosure(memoryStore, input.slice('/read'.length).trim())
    return
  }

  // Only the command word is normalized, so `/LIST` works without affecting any argument.
  const command = input.toLowerCase()

  switch (command) {
    case '/help':
      printHelp()
      return

    case '/learn':
      learnTrigger.enabled = true
      console.log('\n  extraction ON — facts from this conversation will be committed after each turn')
      return

    case '/learn off':
      learnTrigger.enabled = false
      console.log('\n  extraction OFF — back to read-only')
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

/**
 * Walks through progressive disclosure without a model call: shows the injected listing, then invokes
 * the store's read tool on one path.
 *
 * The read half is the store's real machinery: `getTools()` returns the same tool the model calls, so
 * the output is the actual tool result, not a rendering of one. The listing half is reconstructed from
 * the public `listFiles()` — the injector keeps its renderer private, and reaching into it would couple
 * this example to SDK internals — so it mirrors the injected format rather than being byte-identical.
 *
 * @param memoryStore - The store to disclose from
 * @param path - The file to read, exactly as the listing spells it; omitted to show only the listing
 */
async function showDisclosure(
  memoryStore: ReturnType<typeof createDemoTarget>['memoryStore'],
  path: string
): Promise<void> {
  // The store types this as the base Tool; InvokableTool is the SDK's documented path for standalone
  // execution, and narrowing to it is what makes invoke() reachable.
  const readTool = memoryStore.getTools()[0] as InvokableTool<{ path: string }, unknown> | undefined
  if (!readTool) {
    console.log('\n  Disclosure is off for this store, so there is no read tool to call.')
    return
  }

  const files = await memoryStore.listFiles()
  if (files.length === 0) {
    console.log('\n  Store is empty — nothing to disclose. Run /seed first.')
    return
  }

  console.log('\n  1. Injected every turn — the model sees this much for free:\n')
  for (const file of files) {
    console.log(`     ${file.path} — "${file.description}"`)
  }

  if (!path) {
    console.log('\n  2. Pass a path to read one: /read <path from the listing>')
    return
  }

  console.log(`\n  2. The model calls ${readTool.name}({ path: '${path}' }):\n`)
  const result = await readTool.invoke({ path })
  for (const line of JSON.stringify(result, null, 2).split('\n')) {
    console.log(`     ${line}`)
  }

  console.log(
    `\n  Only that one file's content entered context. The other ${files.length - 1} stayed as one-line` +
      '\n  descriptions in the listing — that is the whole trade progressive disclosure makes.'
  )
}

/**
 * Writes the seed corpus as a single commit, overwriting any file at a seeded path.
 *
 * Re-seedable on purpose: a `/learn` beat leaves facts behind, and having to reset the repo between
 * beats would break the session. Files the seed does not name are left alone, so re-seeding restores
 * the planted defects without discarding anything else — say so when that happens, since the resulting
 * corpus is then larger than the 9 files consolidation is described against.
 */
async function seed(storage: CommandContext['storage'], memoryStore: CommandContext['memoryStore']): Promise<void> {
  const seededPaths = new Set(SEED_ENTRIES.map((entry) => entry.path))
  const kept = (await memoryStore.listFiles()).filter((file) => !seededPaths.has(file.path))

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
  await awaitConsistentListing(memoryStore)
  await printListing(memoryStore)

  if (kept.length > 0) {
    console.log(`\n  Kept ${kept.length} file(s) the seed does not name:`)
    for (const file of kept) console.log(`    ${file.path}`)
    console.log('    Consolidation will consider these too, so it may do more than the three fixes below.')
  }

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
  console.log('    /learn        start writing memory from conversation (/learn off to stop)')
  console.log('    /seed         write the 9-file corpus (one commit)')
  console.log('    /list         print the injected file listing')
  console.log('    /read <path>  walk through disclosure on one file, no model call')
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
