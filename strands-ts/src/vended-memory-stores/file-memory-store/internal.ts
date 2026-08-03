/**
 * Internals shared between {@link FileMemoryStore} and its `consolidation/` modules.
 *
 * These are the primitives both sides must agree on: the frontmatter format the store writes and
 * the validator enforces, the reserved changelog path every walk of the store excludes, and the
 * path-identity rule validation and execution both apply. They live here rather than on either
 * side so `consolidation/` never has to import from the store, which would form a cycle.
 *
 * @internal
 */

import { normalizeKey } from '../../storage/storage.js'

/** @internal */
export const encoder = new TextEncoder()

/** @internal */
export const decoder = new TextDecoder()

/**
 * Path (within the store's namespace) reserved for the consolidation audit log.
 *
 * @internal
 */
export const CONSOLIDATION_CHANGELOG = 'consolidation-changelog.md'

/**
 * Frontmatter opening delimiter. Matches the convention used by {@link FileMemoryStore.add}:
 * files start with `---\n`, followed by YAML fields, then a closing `---\n`.
 *
 * @internal
 */
export const FRONTMATTER_OPEN = '---\n'

/**
 * Frontmatter closing delimiter, including the newline that must precede it.
 *
 * @internal
 */
export const FRONTMATTER_CLOSE = '\n---\n'

/**
 * Cap on concurrent storage reads when fanning out over the store's keys. The Storage contract makes
 * no guarantee about concurrent-read capacity, so an unbounded fan-out (one read per key) can exhaust
 * a backend's connection pool or trip throttling on a large corpus. Reads still run in parallel,
 * just no more than this many at once.
 *
 * @internal
 */
export const STORAGE_READ_CONCURRENCY = 8

/**
 * The only `description` form {@link parseFrontmatter} reads. Shared with consolidation's write
 * validation so a plan cannot write a description this parser would read as empty.
 *
 * @internal
 */
export const FRONTMATTER_DESCRIPTION_PATTERN = /^description:\s*(".*")\s*$/m

/**
 * Extract description from YAML frontmatter and return the remaining body.
 *
 * @internal
 */
export function parseFrontmatter(content: string): { description: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { description: '', body: content }

  const frontmatter = match[1] ?? ''
  const body = match[2] ?? ''

  const descMatch = frontmatter.match(FRONTMATTER_DESCRIPTION_PATTERN)
  if (!descMatch) return { description: '', body }

  const rawDesc = descMatch[1] ?? ''
  let description: string
  try {
    description = JSON.parse(rawDesc) as string
  } catch {
    description = rawDesc.slice(1, -1)
  }
  return { description, body }
}

/**
 * Map `items` through `fn` running at most `limit` calls concurrently, preserving input order.
 * A worker pool pulls from a shared cursor so a slow item never blocks others in its batch.
 *
 * @internal
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++
      // index is bounded by items.length — the item is always present
      const item = items[index] as T
      results[index] = await fn(item)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * Case-normalized path identity comparison. Returns true when two paths would resolve to the same
 * file on a case-insensitive filesystem. This is a conservative approximation — backend-resolved
 * identity (probing the storage layer for true equivalence) is future work.
 *
 * @internal
 */
export function pathsResolveSame(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Canonicalize a caller- or model-supplied knowledge path, applying the rules every entry point into
 * the store must agree on: `normalizeKey` collapses slash runs and rejects `..`, single-dot segments
 * are rejected because the OS collapses `./x.md` to `x.md` (so it would alias another key), and the
 * changelog is an audit artifact rather than knowledge. Shared by `add()` and the read tool so a path
 * cannot be written under one spelling and read under another.
 *
 * @throws {@link StorageError} when the path is empty or contains a `..` segment
 * @throws Error when the path contains a `.` segment or addresses the reserved changelog
 *
 * @internal
 */
export function assertKnowledgePath(path: string): string {
  const key = normalizeKey(path)
  if (key.split('/').some((segment) => segment === '.')) {
    throw new Error(`Invalid memory path '${path}': must not contain '.' segments`)
  }
  if (isConsolidationChangelog(key)) {
    throw new Error(`Invalid memory path '${path}': must not be the reserved '${CONSOLIDATION_CHANGELOG}' file`)
  }
  return key
}

/**
 * Whether a key addresses the reserved consolidation changelog. The changelog is an audit artifact
 * rather than knowledge, so every path that walks the store excludes it: {@link FileMemoryStore.search}
 * so it is never recalled as a memory, `readAllFiles` so consolidation never ingests and rewrites its
 * own log, and `validatePath` so no plan can clobber the audit trail.
 *
 * @internal
 */
export function isConsolidationChangelog(key: string): boolean {
  return pathsResolveSame(key, CONSOLIDATION_CHANGELOG)
}

/**
 * Resolve a model-provided path to its canonical stored key using case-insensitive matching.
 *
 * Returns the stored key when exactly one key in `files` matches `path` via `pathsResolveSame`.
 * Returns `undefined` when zero or multiple keys match — zero means the path genuinely does not
 * exist, multiple means the backend is case-sensitive and stores ambiguous keys (safe to reject).
 * Callers that get `undefined` fall through to exact-case behavior, preserving the safe false-reject.
 *
 * @internal
 */
export function resolveCanonicalKey(files: Map<string, string>, path: string): string | undefined {
  // Fast path: exact match avoids scanning every key
  if (files.has(path)) return path

  const normalized = path.toLowerCase()
  let found: string | undefined
  for (const key of files.keys()) {
    if (key.toLowerCase() === normalized) {
      // Multiple matches — ambiguous resolution, bail out
      if (found !== undefined) return undefined
      found = key
    }
  }
  return found
}

/**
 * Resolve the key a write action should land on, distinguishing the two reasons
 * {@link resolveCanonicalKey} returns `undefined`.
 *
 * Zero matches means the path is genuinely new, so the model's spelling is the right key. Two or more
 * means the backend is case-sensitive and already holds case-variant keys — no spelling is more
 * defensible, and writing the model's own mints a *third* file the delete pass will not clean up, so
 * this aborts instead. An exact match is exempt: that key *is* a stored file. The abort is recoverable
 * through consolidation itself, since a delete-only or move-out plan writes no ambiguous target.
 *
 * @returns The stored key when exactly one matches or `path` is itself a stored key, or `path`
 *   verbatim when none match
 * @throws Error when two or more stored keys differ from `path` only by case and none is `path` itself
 *
 * @internal
 */
export function resolveWriteTarget(files: Map<string, string>, path: string): string {
  // Addresses a stored file directly, so writing it cannot mint a third spelling
  if (files.has(path)) return path

  const normalized = path.toLowerCase()
  const matches = [...files.keys()].filter((key) => key.toLowerCase() === normalized)
  if (matches.length > 1) {
    throw new Error(
      `Consolidation aborted: write target '${path}' is ambiguous — the store holds ${matches.length} keys that ` +
        `differ from it only by case (${matches.join(', ')}). Writing this spelling would create a third copy and ` +
        `leave the duplicates in place. Resolve them first — a delete-only or move-out consolidation can do it — ` +
        `then re-run.`
    )
  }
  return matches[0] ?? path
}
