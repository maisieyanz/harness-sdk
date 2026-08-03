/**
 * Step 3 — consolidate the store.
 *
 * One structured-output call plans actions over the whole corpus, guardrails validate the entire plan
 * before anything is mutated, then deterministic code executes it. Batching the execution means the
 * whole run lands as a single commit, so the GitHub diff reads as one reviewable change rather than a
 * scatter of individual writes and deletes.
 *
 * Usage (credentials come from .env — see .env.example):
 *   npm run consolidate
 */

import { awaitConsistentListing, createDemoTarget, createModel, heading, printListing } from './shared.js'

/** Where consolidation records what it changed and why, relative to the store's namespace. */
const CHANGELOG_KEY = 'consolidation-changelog.md'

async function main(): Promise<void> {
  const { owner, repo, branch, storage, scoped, memoryStore } = createDemoTarget()

  heading('Step 3 — consolidation')

  console.log('Before:\n')
  await printListing(memoryStore)

  const model = createModel()

  console.log('\nPlanning and executing — deduplicate, resolveContradictions, deriveInsights, reorganize ...\n')

  // Buffer every write and delete the run makes, so the whole consolidation is one atomic commit.
  storage.beginBatch()
  await memoryStore.consolidate({
    model,
    operations: ['deduplicate', 'resolveContradictions', 'deriveInsights', 'reorganize'],
  })
  await storage.commitBatch('consolidation — deduplicate, resolve contradictions, derive insights')

  console.log('  Consolidation committed as a single commit.\n')

  heading('After')
  await awaitConsistentListing(memoryStore)
  await printListing(memoryStore)

  heading('Audit trail (consolidation-changelog.md)')
  const changelogBytes = await scoped.read(CHANGELOG_KEY)
  console.log(changelogBytes ? new TextDecoder().decode(changelogBytes) : '  (no changelog written)')

  console.log(`\nCompare the before/after diff: https://github.com/${owner}/${repo}/commits/${branch}\n`)
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
