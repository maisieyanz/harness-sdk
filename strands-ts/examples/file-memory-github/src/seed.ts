/**
 * Step 1 — seed the GitHub-backed memory store.
 *
 * Writes a knowledge corpus that deliberately contains the three defects consolidation exists to fix:
 * a duplicate pair, a contradiction, and a set of related facts that should collapse into one insight.
 * Every write is a commit, so the seeded state is inspectable on GitHub before consolidation runs.
 *
 * Usage (credentials come from .env — see .env.example):
 *   npm start
 */

import { createDemoTarget, heading, printListing } from './shared.js'
import { SEED_ENTRIES } from './seed-corpus.js'

async function main(): Promise<void> {
  const { owner, repo, branch, storage, memoryStore } = createDemoTarget()

  heading(`Step 1 — seeding memory into ${owner}/${repo} (branch: ${branch})`)

  // One commit for the whole seed, rather than a commit per file. Without this the seed would be a
  // dozen commits and burn a dozen round trips against the API rate limit.
  storage.beginBatch()
  for (const entry of SEED_ENTRIES) {
    await memoryStore.add(entry.content, { path: entry.path, description: entry.description })
    console.log(`  + ${entry.path}`)
  }
  await storage.commitBatch(`seed ${SEED_ENTRIES.length} knowledge files`)

  console.log(`\n  Committed ${SEED_ENTRIES.length} files as a single commit.`)

  heading('The injected file listing (what the agent sees every turn)')
  await printListing(memoryStore)

  heading('Seeded defects for consolidation to fix')
  console.log('  duplicate      facts/dark-mode-preference.md + facts/theme-setting.md')
  console.log('  contradiction  facts/indentation-tabs.md (March) vs facts/indentation-spaces.md (June)')
  console.log('  related facts  the three facts/testing-*.md files share one principle')

  console.log(`\nNext:  npm run ask        — watch progressive disclosure pick files`)
  console.log(`       npm run consolidate — fix the three defects above`)
  console.log(`\nBrowse: https://github.com/${owner}/${repo}/tree/${branch}\n`)
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
