/**
 * Types for the file-based memory system.
 *
 * Defines the {@link FileBackend} interface that any storage backend must implement,
 * and the configuration types for {@link FileMemoryStore} and {@link FileSessionStorage}.
 */

import type { ExtractionConfig } from '../../memory/extraction/types.js'
import type { MemoryStoreConfig } from '../../memory/types.js'

/**
 * A single entry in a directory listing.
 */
export interface FileEntry {
  /** Relative path from the backend root. */
  path: string
  /** Whether this entry is a directory. */
  isDirectory: boolean
}

/**
 * A recorded change to a file — used by consolidation to scope work.
 */
export interface FileChange {
  /** Relative path from the backend root. */
  path: string
  /** Unix timestamp (ms) when the change occurred. */
  timestamp: number
  /** The type of change. */
  operation: 'write' | 'delete'
}

/**
 * Minimal file operations that any storage backend must provide.
 *
 * {@link FileMemoryStore} and {@link FileSessionStorage} pass relative paths (e.g.,
 * `knowledge/facts/testing.md`) — the backend joins them with its own root to form the full path.
 */
export interface FileBackend {
  /** Read a file's content as a UTF-8 string. Throws if the file does not exist. */
  read(path: string): Promise<string>
  /** Write a file, creating intermediate directories as needed. */
  write(path: string, content: string): Promise<void>
  /** Delete a file. Does not throw if the file does not exist. */
  delete(path: string): Promise<void>
  /** List entries under a prefix. When omitted, lists from the root. */
  list(prefix?: string): Promise<FileEntry[]>
  /** Check whether a file exists. */
  exists(path: string): Promise<boolean>

  /** Return all changes (writes and deletes) since the given timestamp (ms). */
  changesSince(timestamp: number): Promise<FileChange[]>
  /** Restore a file to its state at the given timestamp. */
  rollback(path: string, timestamp: number): Promise<void>
}

/**
 * Configuration for {@link FileMemoryStore}.
 */
export interface FileMemoryStoreConfig extends Omit<MemoryStoreConfig, 'writable'> {
  /** The file backend to use for persistence. */
  backend: FileBackend
  /** Maximum tokens to include when rendering the file tree for injection. */
  retrieval?: { maxTokens?: number }
  /**
   * Automatic extraction config. When enabled, the MemoryManager extracts facts from
   * conversation and writes them to `knowledge/facts/` via `add()`.
   */
  extraction?: boolean | ExtractionConfig
}

/**
 * Configuration for {@link FileSessionStorage}.
 */
export interface FileSessionStorageConfig {
  /** The file backend to use for persistence. */
  backend: FileBackend
}

/**
 * Operations the consolidation agent can perform.
 */
export type ConsolidationOperation =
  | 'deduplicate'
  | 'resolve-contradictions'
  | 'derive-insights'
  | 'prune'
  | 'reorganize'

/**
 * Configuration for a consolidation run.
 */
export interface ConsolidateConfig {
  /** The model to use for consolidation reasoning. */
  model: unknown
  /** Which maintenance operations to run. */
  operations: ConsolidationOperation[]
  /** Whether to process all files or only those changed since the last run. */
  scope: 'since-last' | 'all'
}
