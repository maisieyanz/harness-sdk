/**
 * Local filesystem implementation of {@link FileBackend}.
 *
 * Uses a `.journal` file and `.versions/` directory for change tracking and rollback.
 */

import type { FileBackend, FileChange, FileEntry } from './types.js'

const JOURNAL_FILE = '.journal'
const VERSIONS_DIR = '.versions'

/**
 * Configuration for {@link LocalFileBackend}.
 */
export interface LocalFileBackendConfig {
  /** Absolute or relative path to the root directory for all stored files. */
  rootPath: string
}

/**
 * A {@link FileBackend} backed by the local filesystem.
 *
 * Versioning is implemented via a `.versions/` directory (pre-overwrite snapshots) and a
 * `.journal` file (append-only log of writes and deletes with timestamps).
 */
export class LocalFileBackend implements FileBackend {
  private readonly _rootPath: string

  constructor(config: LocalFileBackendConfig) {
    this._rootPath = config.rootPath
  }

  private async _resolve(relativePath: string): Promise<string> {
    const path = await import('node:path')
    const resolved = path.resolve(this._rootPath, relativePath)
    const root = path.resolve(this._rootPath)
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`path traversal blocked: ${relativePath}`)
    }
    return resolved
  }

  private async _ensureDir(filePath: string): Promise<void> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
  }

  private async _appendJournal(relativePath: string, operation: 'write' | 'delete'): Promise<void> {
    const fs = await import('node:fs/promises')
    const journalPath = await this._resolve(JOURNAL_FILE)
    await this._ensureDir(journalPath)
    const entry = JSON.stringify({ path: relativePath, timestamp: Date.now(), operation }) + '\n'
    await fs.appendFile(journalPath, entry, 'utf-8')
  }

  private async _saveVersion(relativePath: string): Promise<void> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const sourcePath = await this._resolve(relativePath)

    try {
      await fs.access(sourcePath)
    } catch {
      return
    }

    const versionDir = await this._resolve(`${VERSIONS_DIR}/${relativePath}`)
    await fs.mkdir(path.dirname(versionDir), { recursive: true })
    await fs.mkdir(versionDir, { recursive: true })
    const content = await fs.readFile(sourcePath, 'utf-8')
    const versionPath = path.join(versionDir, `${Date.now()}`)
    await fs.writeFile(versionPath, content, 'utf-8')
  }

  /** {@inheritDoc FileBackend.read} */
  async read(path: string): Promise<string> {
    const fs = await import('node:fs/promises')
    return fs.readFile(await this._resolve(path), 'utf-8')
  }

  /** {@inheritDoc FileBackend.write} */
  async write(path: string, content: string): Promise<void> {
    const fs = await import('node:fs/promises')
    const fullPath = await this._resolve(path)
    await this._saveVersion(path)
    await this._ensureDir(fullPath)
    await fs.writeFile(fullPath, content, 'utf-8')
    await this._appendJournal(path, 'write')
  }

  /** {@inheritDoc FileBackend.delete} */
  async delete(path: string): Promise<void> {
    const fs = await import('node:fs/promises')
    const fullPath = await this._resolve(path)
    await this._saveVersion(path)
    try {
      await fs.unlink(fullPath)
    } catch {
      // File already gone — no-op
    }
    await this._appendJournal(path, 'delete')
  }

  /** {@inheritDoc FileBackend.list} */
  async list(prefix?: string): Promise<FileEntry[]> {
    const fs = await import('node:fs/promises')
    const targetDir = prefix ? await this._resolve(prefix) : await this._resolve('.')
    const entries: FileEntry[] = []

    try {
      const dirents = await fs.readdir(targetDir, { withFileTypes: true })
      for (const dirent of dirents) {
        if (dirent.name === JOURNAL_FILE || dirent.name === VERSIONS_DIR) continue
        const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name
        entries.push({ path: relativePath, isDirectory: dirent.isDirectory() })
      }
    } catch {
      // Directory does not exist — return empty
    }

    return entries
  }

  /** {@inheritDoc FileBackend.exists} */
  async exists(path: string): Promise<boolean> {
    const fs = await import('node:fs/promises')
    try {
      await fs.access(await this._resolve(path))
      return true
    } catch {
      return false
    }
  }

  /** {@inheritDoc FileBackend.changesSince} */
  async changesSince(timestamp: number): Promise<FileChange[]> {
    const fs = await import('node:fs/promises')
    const journalPath = await this._resolve(JOURNAL_FILE)
    let raw: string

    try {
      raw = await fs.readFile(journalPath, 'utf-8')
    } catch {
      return []
    }

    const changes: FileChange[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const entry = JSON.parse(line) as FileChange
      if (entry.timestamp > timestamp) {
        changes.push(entry)
      }
    }
    return changes
  }

  /** {@inheritDoc FileBackend.rollback} */
  async rollback(path: string, timestamp: number): Promise<void> {
    const fs = await import('node:fs/promises')
    const nodePath = await import('node:path')
    const versionDir = await this._resolve(`${VERSIONS_DIR}/${path}`)

    let versions: string[]
    try {
      versions = await fs.readdir(versionDir)
    } catch {
      throw new Error(`no version history for: ${path}`)
    }

    const sorted = versions
      .map((v) => ({ name: v, ts: parseInt(v, 10) }))
      .filter((v) => !isNaN(v.ts) && v.ts <= timestamp)
      .sort((a, b) => b.ts - a.ts)

    if (sorted.length === 0) {
      throw new Error(`no version found at or before timestamp ${timestamp} for: ${path}`)
    }

    const content = await fs.readFile(nodePath.join(versionDir, sorted[0]!.name), 'utf-8')
    const fullPath = await this._resolve(path)
    await this._ensureDir(fullPath)
    await fs.writeFile(fullPath, content, 'utf-8')
    await this._appendJournal(path, 'write')
  }
}
