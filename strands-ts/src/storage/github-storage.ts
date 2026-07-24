import type { Storage } from './storage.js'

import { StorageError } from '../errors.js'
import { logger } from '../logging/logger.js'
import { decodeBase64, encodeBase64 } from '../types/media.js'
import { namespace, normalizeKey, normalizePrefix } from './storage.js'

/** Configuration for {@link GithubStorage}. */
export interface GithubStorageConfig {
  /** Repository owner (user or organization login). */
  owner: string
  /** Repository name. */
  repo: string
  /** Branch to read from and commit to. Defaults to `main`. */
  branch?: string
  /** GitHub token used to authenticate. Required for writes and private repos. Cannot be combined with `octokit`. */
  token?: string
  /** Optional key prefix prepended to every key (a leading namespace within the repo). */
  prefix?: string
  /** Prefix prepended to every commit message. Defaults to `memory`. */
  commitPrefix?: string
  /** Pre-configured Octokit client. Cannot be combined with `token`. */
  octokit?: import('@octokit/rest').Octokit
}

/** A queued mutation awaiting {@link GithubStorage.commitBatch}. */
interface BatchEntry {
  type: 'put' | 'delete'
  key: string
  data?: Uint8Array
}

/** A single entry in a git tree, as accepted by the create-tree API. */
interface GitTreeItem {
  path: string
  mode: '100644'
  type: 'blob'
  sha?: string | null
}

const FILE_MODE = '100644'

/**
 * GitHub-repository {@link Storage} backend.
 *
 * Stores each key as a file in a GitHub repository at the key's path (under an optional prefix),
 * so the store is browsable, diffable, and versioned through GitHub itself. The Octokit REST client
 * is loaded lazily on first use and declared as an optional peer dependency, so consumers that never
 * construct a `GithubStorage` are not required to install `@octokit/rest`.
 *
 * Two commit modes are supported. By default every {@link write} and {@link delete} is its own
 * commit. For a multi-file change — such as a {@link FileMemoryStore} consolidation run — call
 * {@link beginBatch}, perform the mutations, then {@link commitBatch} to land them all in one commit,
 * which avoids dozens of commits and the associated API rate-limit pressure. While a batch is open,
 * {@link write} and {@link delete} are queued and not visible to {@link read} until committed.
 *
 * @example
 * ```typescript
 * import { GithubStorage } from '@strands-agents/sdk/storage'
 *
 * const storage = new GithubStorage({ owner: 'myorg', repo: 'agent-memory', branch: 'main', token })
 * await storage.write('knowledge/facts/note.md', bytes)
 * ```
 */
export class GithubStorage implements Storage {
  private readonly _owner: string
  private readonly _repo: string
  private readonly _branch: string
  private readonly _token: string | undefined
  private readonly _prefix: string
  private readonly _commitPrefix: string
  private _client: import('@octokit/rest').Octokit | undefined
  private _batch: BatchEntry[] | null = null

  /**
   * @param config - Repository coordinates, optional auth token or client, and commit/key prefixes
   * @throws {@link StorageError} if both `token` and `octokit` are provided
   */
  constructor(config: GithubStorageConfig) {
    if (config.octokit && config.token) {
      throw new StorageError('Cannot specify both octokit and token. Configure auth on the Octokit client instead.')
    }
    this._owner = config.owner
    this._repo = config.repo
    this._branch = config.branch ?? 'main'
    this._token = config.token
    this._prefix = config.prefix ? config.prefix.replace(/\/+$/, '') + '/' : ''
    this._commitPrefix = config.commitPrefix ?? 'memory'
    this._client = config.octokit
  }

  /**
   * Opens a batch. Subsequent {@link write} and {@link delete} calls are queued rather than committed,
   * until {@link commitBatch} lands them as a single commit. A no-op if a batch is already open.
   */
  beginBatch(): void {
    this._batch ??= []
  }

  /**
   * Commits all queued mutations as a single commit and closes the batch.
   *
   * Builds one git tree containing every queued put (as a blob) and delete (as a tree entry with a
   * null sha), then creates one commit on top of the branch head. When two queued mutations target
   * the same key, the later one wins. A no-op (that still closes the batch) when nothing is queued.
   *
   * @param message - Human-readable description appended after the commit prefix
   * @throws {@link StorageError} if no batch is open, or if the commit fails
   */
  async commitBatch(message: string): Promise<void> {
    const entries = this._batch
    this._batch = null
    if (entries === null) {
      throw new StorageError('commitBatch called with no open batch — call beginBatch first')
    }
    if (entries.length === 0) return

    // Later mutations to the same key supersede earlier ones so the tree carries one entry per path
    const deduped = new Map<string, BatchEntry>()
    for (const entry of entries) deduped.set(entry.key, entry)

    const client = await this._getClient()
    try {
      const baseCommitSha = await this._getBranchHeadSha(client)
      const baseCommit = await client.git.getCommit({ owner: this._owner, repo: this._repo, commit_sha: baseCommitSha })
      const baseTreeSha = baseCommit.data.tree.sha

      const treeItems: GitTreeItem[] = []
      for (const entry of deduped.values()) {
        if (entry.type === 'put' && entry.data) {
          const blob = await client.git.createBlob({
            owner: this._owner,
            repo: this._repo,
            content: encodeBase64(entry.data),
            encoding: 'base64',
          })
          treeItems.push({ path: entry.key, mode: FILE_MODE, type: 'blob', sha: blob.data.sha })
        } else if (entry.type === 'delete') {
          treeItems.push({ path: entry.key, mode: FILE_MODE, type: 'blob', sha: null })
        }
      }

      const newTree = await client.git.createTree({
        owner: this._owner,
        repo: this._repo,
        base_tree: baseTreeSha,
        tree: treeItems,
      })
      const newCommit = await client.git.createCommit({
        owner: this._owner,
        repo: this._repo,
        message: `${this._commitPrefix}: ${message}`,
        tree: newTree.data.sha,
        parents: [baseCommitSha],
      })
      await client.git.updateRef({
        owner: this._owner,
        repo: this._repo,
        ref: `heads/${this._branch}`,
        sha: newCommit.data.sha,
      })
    } catch (error: unknown) {
      throw new StorageError(`Failed to commit batch to '${this._owner}/${this._repo}'`, { cause: error })
    }
  }

  /**
   * Stores `data` under `key`, overwriting any existing value. When a batch is open the write is
   * queued instead of committed; otherwise it lands as its own commit.
   *
   * @param key - Opaque, `/`-separated key identifying the value
   * @param data - Raw bytes to persist
   * @throws {@link StorageError} if the key is invalid or the commit fails
   */
  async write(key: string, data: Uint8Array): Promise<void> {
    const path = this._pathFor(normalizeKey(key))
    if (this._batch) {
      this._batch.push({ type: 'put', key: path, data })
      return
    }
    const client = await this._getClient()
    try {
      const existing = await this._getFileSha(client, path)
      await client.repos.createOrUpdateFileContents({
        owner: this._owner,
        repo: this._repo,
        path,
        message: `${this._commitPrefix}: update ${path}`,
        content: encodeBase64(data),
        branch: this._branch,
        ...(existing ? { sha: existing } : {}),
      })
    } catch (error: unknown) {
      throw new StorageError(`Failed to write '${path}' to '${this._owner}/${this._repo}'`, { cause: error })
    }
  }

  /**
   * Retrieves the bytes previously stored under `key`. Reflects the committed state of the branch —
   * mutations queued in an open batch are not visible until committed.
   *
   * @param key - The key to read
   * @returns The stored bytes, or `null` if no value exists for `key`
   * @throws {@link StorageError} if the key is invalid or the read fails for a reason other than a missing key
   */
  async read(key: string): Promise<Uint8Array | null> {
    const path = this._pathFor(normalizeKey(key))
    const client = await this._getClient()
    try {
      const response = await client.repos.getContent({ owner: this._owner, repo: this._repo, path, ref: this._branch })
      const file = response.data
      if (Array.isArray(file) || file.type !== 'file' || !('content' in file)) return null
      return decodeBase64(file.content)
    } catch (error: unknown) {
      if (isNotFoundError(error)) return null
      throw new StorageError(`Failed to read '${path}' from '${this._owner}/${this._repo}'`, { cause: error })
    }
  }

  /**
   * Deletes the value stored under `key`. A no-op if the key does not exist. When a batch is open the
   * delete is queued instead of committed; otherwise it lands as its own commit.
   *
   * @param key - The key to delete
   * @throws {@link StorageError} if the key is invalid or the commit fails
   */
  async delete(key: string): Promise<void> {
    const path = this._pathFor(normalizeKey(key))
    if (this._batch) {
      this._batch.push({ type: 'delete', key: path })
      return
    }
    const client = await this._getClient()
    try {
      const sha = await this._getFileSha(client, path)
      if (!sha) return
      await client.repos.deleteFile({
        owner: this._owner,
        repo: this._repo,
        path,
        message: `${this._commitPrefix}: delete ${path}`,
        sha,
        branch: this._branch,
      })
    } catch (error: unknown) {
      throw new StorageError(`Failed to delete '${path}' from '${this._owner}/${this._repo}'`, { cause: error })
    }
  }

  /**
   * Lists the keys whose names begin with `prefix`, sorted lexicographically. Returns an empty list
   * when the branch does not yet exist (an uninitialized store).
   *
   * @param prefix - Key prefix to match. An empty string matches all keys.
   * @returns The matching keys, sorted ascending
   * @throws {@link StorageError} if the prefix is invalid or the listing fails
   */
  async list(prefix: string): Promise<string[]> {
    const normalized = normalizePrefix(prefix)
    const listPrefix = `${this._prefix}${normalized}`
    const client = await this._getClient()
    try {
      const baseCommitSha = await this._getBranchHeadSha(client)
      const baseCommit = await client.git.getCommit({ owner: this._owner, repo: this._repo, commit_sha: baseCommitSha })
      const tree = await client.git.getTree({
        owner: this._owner,
        repo: this._repo,
        tree_sha: baseCommit.data.tree.sha,
        recursive: 'true',
      })
      if (tree.data.truncated) {
        logger.warn(
          `owner=<${this._owner}>, repo=<${this._repo}> | github tree listing was truncated, some keys may be missing`
        )
      }
      const keys: string[] = []
      for (const item of tree.data.tree) {
        if (item.type !== 'blob' || item.path === undefined || !item.path.startsWith(listPrefix)) continue
        keys.push(this._prefix ? item.path.slice(this._prefix.length) : item.path)
      }
      return keys.sort()
    } catch (error: unknown) {
      if (isNotFoundError(error)) return []
      throw new StorageError(`Failed to list '${this._owner}/${this._repo}' under '${normalized}'`, { cause: error })
    }
  }

  /** Returns a prefixed view of this storage without mutating the original. */
  namespace(prefix: string): Storage {
    return namespace(this, prefix)
  }

  private async _getClient(): Promise<import('@octokit/rest').Octokit> {
    if (this._client) return this._client
    const { Octokit } = await import('@octokit/rest')
    this._client = new Octokit(this._token ? { auth: this._token } : {})
    return this._client
  }

  private async _getBranchHeadSha(client: import('@octokit/rest').Octokit): Promise<string> {
    const ref = await client.git.getRef({ owner: this._owner, repo: this._repo, ref: `heads/${this._branch}` })
    return ref.data.object.sha
  }

  private async _getFileSha(client: import('@octokit/rest').Octokit, path: string): Promise<string | null> {
    try {
      const response = await client.repos.getContent({ owner: this._owner, repo: this._repo, path, ref: this._branch })
      const file = response.data
      if (Array.isArray(file) || file.type !== 'file') return null
      return file.sha
    } catch (error: unknown) {
      if (isNotFoundError(error)) return null
      throw error
    }
  }

  private _pathFor(key: string): string {
    return `${this._prefix}${key}`
  }
}

/**
 * Returns true when the error is an Octokit 404 (missing file, branch, or repo).
 *
 * @param error - The caught error to inspect
 * @returns Whether the error represents a not-found response
 */
function isNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'status' in error && error.status === 404
}
