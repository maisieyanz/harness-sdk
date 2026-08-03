/**
 * Step 1 — seed the GitHub-backed memory store.
 *
 * Writes a knowledge corpus that deliberately contains the three defects consolidation exists to fix:
 * a duplicate pair, a contradiction, and a set of related facts that should collapse into one insight.
 * Every write is a commit, so the seeded state is inspectable on GitHub before consolidation runs.
 *
 * Usage:
 *   export GITHUB_TOKEN=... GITHUB_OWNER=... GITHUB_REPO=...
 *   npm start
 */

import { createDemoTarget, heading, printListing } from './shared.js'

/**
 * The seed corpus. Each entry becomes one markdown file with a frontmatter description — the
 * description is what the model sees in the injected listing, so it has to earn the read on its own.
 */
const ENTRIES = [
  // Always-relevant context. Consolidation should leave these alone.
  {
    path: 'system/persona.md',
    description: 'Agent role, review constraints, and communication style',
    content: [
      'You are a senior code review assistant embedded in a platform engineering team.',
      '',
      '## Role',
      '- Review pull requests for correctness, security, and maintainability',
      '- Provide actionable feedback with specific file and line references',
      '- Escalate architectural concerns to the tech lead',
      '',
      '## Constraints',
      '- Never approve a PR that introduces a known security vulnerability',
      '- Always check for breaking changes to public APIs',
      '- Prefer correctness over performance unless told otherwise',
      '',
      '## Communication Style',
      '- Lead with the most critical issue; cite paths and line numbers',
      '- Prefix style-only suggestions with "nit:"',
    ].join('\n'),
  },

  // SCENARIO 1 — duplicate. The same preference recorded twice, in different words.
  {
    path: 'facts/dark-mode-preference.md',
    description: 'User prefers dark mode in every editor and terminal',
    content: 'The user prefers dark mode in all editors, terminals, and browser dev tools.',
  },
  {
    path: 'facts/theme-setting.md',
    description: 'Dark theme preference, with the reason behind it',
    content: 'Theme preference: dark mode. Light themes cause eye strain during long sessions.',
  },

  // SCENARIO 2 — contradiction. The June note supersedes the March one.
  {
    path: 'facts/indentation-tabs.md',
    description: 'Indentation preference: tabs (recorded March 2026)',
    content: 'User indents with tabs in all projects. Set via .editorconfig. Recorded March 2026.',
  },
  {
    path: 'facts/indentation-spaces.md',
    description: 'Indentation preference: 2 spaces (updated June 2026, supersedes tabs)',
    content: [
      'User switched to 2-space indentation as of June 2026. All new code uses spaces.',
      '.editorconfig and the Prettier config were updated accordingly.',
    ].join(' '),
  },

  // SCENARIO 3 — three related facts that share one underlying principle.
  {
    path: 'facts/testing-integration-preference.md',
    description: 'Team prefers integration tests over unit tests for API layers',
    content: 'The team uses integration tests rather than unit tests for API layers.',
  },
  {
    path: 'facts/testing-mock-boundaries.md',
    description: 'Mocking is acceptable only at HTTP boundaries',
    content: 'Mock only at HTTP boundaries, never at the module level. Mock divergence caused a Q1 incident.',
  },
  {
    path: 'facts/testing-real-database.md',
    description: 'Test against a real local database rather than mocks',
    content: [
      'Test database interactions against a real local database, not mocks.',
      'Mocked tests passed last quarter while the production migration still failed.',
    ].join(' '),
  },

  // Procedural knowledge, distinct enough that consolidation should keep both.
  {
    path: 'skills/debugging-production.md',
    description: 'Runbook for triaging a production incident',
    content: [
      '## Triage Steps',
      '1. Check the alarm dashboard — identify the breaching metric',
      '2. Filter logs by the request id from the alarm',
      '3. Follow traces across service boundaries',
      '4. Correlate onset with deployments from the last two hours',
      '',
      '## Rules',
      '- Never restart a service before understanding the root cause',
      '- Capture a heap dump before restarting anything memory-related',
      '- Document findings in the incident channel before acting',
    ].join('\n'),
  },
  {
    path: 'skills/code-review.md',
    description: 'Code review checklist: what to always flag',
    content: [
      '## Always Flag',
      '- Unvalidated user input reaching a database query',
      '- Secrets or API keys committed to source',
      '- Missing error handling on async operations',
      '- Breaking public API changes without a version bump',
      '- Tests that mock the very thing they claim to verify',
      '',
      '## Common Nits',
      '- Inconsistent naming, dead code, leftover debug logging',
      '- Magic numbers without named constants',
    ].join('\n'),
  },
]

async function main(): Promise<void> {
  const { owner, repo, branch, storage, memoryStore } = createDemoTarget()

  heading(`Step 1 — seeding memory into ${owner}/${repo} (branch: ${branch})`)

  // One commit for the whole seed, rather than a commit per file. Without this the seed would be a
  // dozen commits and burn a dozen round trips against the API rate limit.
  storage.beginBatch()
  for (const entry of ENTRIES) {
    await memoryStore.add(entry.content, { path: entry.path, description: entry.description })
    console.log(`  + ${entry.path}`)
  }
  await storage.commitBatch(`seed ${ENTRIES.length} knowledge files`)

  console.log(`\n  Committed ${ENTRIES.length} files as a single commit.`)

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
