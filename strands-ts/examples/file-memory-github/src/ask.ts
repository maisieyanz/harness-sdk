/**
 * Step 2 — ask the agent a question and watch progressive disclosure work.
 *
 * The store injects only the file listing — every path and its one-line description — and registers a
 * read tool. The model decides which files are worth opening and pays context only for those. The
 * tool calls printed below are that decision, made visible.
 *
 * `injection: false` turns off the manager's own search-result injection: the listing is a better map
 * of memory than a keyword search's top hits, and both would compete for the same context budget.
 *
 * Usage:
 *   export GITHUB_TOKEN=... GITHUB_OWNER=... GITHUB_REPO=...
 *   npm run ask                       # uses the default question
 *   npm run ask -- "your question"
 */

import { Agent, MemoryManager } from '@strands-agents/sdk'
import { createDemoTarget, createModel, heading } from './shared.js'

const DEFAULT_QUESTION = 'What is our testing philosophy, and how should I indent new code?'

async function main(): Promise<void> {
  const { memoryStore } = createDemoTarget()
  const question = process.argv[2] ?? DEFAULT_QUESTION

  const agent = new Agent({
    model: createModel(),
    memoryManager: new MemoryManager({ stores: [memoryStore], injection: false }),
    printer: false,
    systemPrompt: 'You are a code review assistant. Answer from your memory files, and cite the paths you used.',
  })

  heading('Step 2 — progressive disclosure')
  console.log(`Question: ${question}\n`)

  let answer = ''
  for await (const event of agent.stream(question)) {
    if (event.type === 'beforeToolCallEvent') {
      console.log(`  [tool] ${event.toolUse.name} ${JSON.stringify(event.toolUse.input)}`)
    }
    // Check the value, not just the key: a tool-use turn emits a text block whose `text` is undefined
    if (event.type === 'contentBlockEvent' && 'text' in event.contentBlock && event.contentBlock.text) {
      answer += event.contentBlock.text
    }
  }

  heading('Answer')
  console.log(answer.trim())

  console.log(
    [
      '\nThe agent read only the files whose descriptions looked relevant — the rest of the',
      'corpus never entered its context. Note that it had to reconcile the tabs/spaces',
      'contradiction itself, and had to read three separate files to answer one question',
      'about testing. Consolidation is what removes that work.',
      '\nNext: npm run consolidate\n',
    ].join('\n')
  )
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
