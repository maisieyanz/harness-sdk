/**
 * The unified storage primitive.
 *
 * Every backend (in-memory, local filesystem, S3, custom) implements this interface.
 * Subsystems (sessions, memory, transcripts, context, offloader) all accept a Storage
 * instance for persistence.
 */
export interface Storage {
  /** Persist `data` under `key`. Overwrites if the key already exists. */
  put(key: string, data: Uint8Array): Promise<void>
  /** Read bytes stored under `key`. Returns `null` if the key does not exist. */
  get(key: string): Promise<Uint8Array | null>
  /** Delete the value stored under `key`. No-op if absent. */
  delete(key: string): Promise<void>
  /** List all keys beginning with `prefix`, sorted ascending. */
  list(prefix: string): Promise<string[]>
}
