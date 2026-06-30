/**
 * Types for the file-based memory store.
 */

import type { Model } from '../../models/model.js'
import type { ExtractionConfig } from '../../memory/extraction/types.js'
import type { MemoryStoreConfig } from '../../memory/types.js'

// ---------------------------------------------------------------------------
// Storage adapter — placeholder until the unified Storage primitive lands.
// When `@strands-agents/sdk/storage` ships its `Storage` interface (put/get/delete/list),
// this block gets replaced with a direct import and thin adapter. Until then, the
// FileMemoryStore operates through this minimal contract so the rest of the module
// (consolidation, progressive disclosure, search) stays decoupled from the eventual
// Storage implementation details.
// ---------------------------------------------------------------------------

/**
 * A single entry in a directory listing.
 * @internal
 */
export interface FileEntry {
  path: string
  isDirectory: boolean
  mtime?: number
}

/**
 * Stub for the unified Storage primitive. Will be replaced by `Storage` from
 * `@strands-agents/sdk/storage` when it ships (put/get/delete/list on Uint8Array).
 * @internal
 */
export interface FileStorage {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  delete(path: string): Promise<void>
  list(prefix?: string): Promise<FileEntry[]>
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link FileMemoryStore}.
 */
export interface FileMemoryStoreConfig extends Omit<MemoryStoreConfig, 'writable'> {
  /**
   * Storage adapter for file operations. Placeholder until the unified Storage
   * primitive ships — at that point this becomes `storage: Storage` from
   * `@strands-agents/sdk/storage`.
   */
  storage: FileStorage
  /** Maximum tokens to include when rendering the file tree for injection. */
  retrieval?: { maxTokens?: number }
  /**
   * Automatic extraction config. When enabled, the MemoryManager extracts facts from
   * conversation and writes them to `knowledge/facts/` via `add()`.
   */
  extraction?: boolean | ExtractionConfig
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
  model: Model
  /** Which maintenance operations to run. */
  operations: ConsolidationOperation[]
  /** Whether to process all files or only those changed since the last run. */
  scope: 'since-last' | 'all'
}
