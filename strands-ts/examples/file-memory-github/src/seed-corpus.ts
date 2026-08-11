/**
 * The seed corpus, shared by the `seed` script and the interactive session's `/seed` command.
 *
 * Each entry becomes one markdown file with a frontmatter description — the description is what the
 * model sees in the injected listing, so it has to earn the read on its own.
 *
 * Everything lands under `facts/`, the one directory the store gives meaning to: it is where `add()`
 * puts an entry with no explicit path. Any other layout would work — paths are arbitrary — but a made-up
 * directory would imply the store treats it specially, and it does not.
 */

/** One seeded knowledge file: where it goes, how it advertises itself, and what it holds. */
export interface SeedEntry {
  /** Store-relative path, under `facts/`. */
  path: string
  /** The one-line summary the model sees in the listing. */
  description: string
  /** The file body. */
  content: string
}

/**
 * The corpus. It deliberately contains the three defects consolidation exists to fix: a duplicate
 * pair, a contradiction, and a set of related facts that should collapse into one insight.
 */
export const SEED_ENTRIES: SeedEntry[] = [
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
    path: 'facts/debugging-production-runbook.md',
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
    path: 'facts/code-review-checklist.md',
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
