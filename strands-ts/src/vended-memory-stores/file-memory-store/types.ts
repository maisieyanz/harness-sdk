/**
 * Types for the file-based memory store.
 */

import type { Model } from '../../models/model.js'
import type { ExtractionConfig } from '../../memory/extraction/types.js'
import type { MemoryStoreConfig } from '../../memory/types.js'
import type { Storage } from '../../storage/storage.js'

/**
 * Configuration for {@link FileMemoryStore}.
 */
export interface FileMemoryStoreConfig extends Omit<MemoryStoreConfig, 'writable'> {
  /** The unified Storage backend for file operations. */
  storage: Storage
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
