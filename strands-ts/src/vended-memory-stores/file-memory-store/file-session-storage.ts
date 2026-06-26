/**
 * File-based session storage for the {@link ContextOffloader}.
 *
 * Implements the {@link Storage} interface by writing evicted content blocks to the
 * `sessions/` subtree of the shared {@link FileBackend}.
 */

import type { Storage } from '../../vended-plugins/context-offloader/storage.js'
import type { FileBackend, FileSessionStorageConfig } from './types.js'

const SESSIONS_PREFIX = 'sessions'

/**
 * Maps content types to file extensions for stored session artifacts.
 */
function extensionFor(contentType: string): string {
  if (contentType === 'text/plain') return '.txt'
  if (contentType === 'text/markdown') return '.md'
  if (contentType === 'application/json') return '.json'
  return `.${contentType.split('/').pop() ?? 'bin'}`
}

/**
 * Stores evicted context blocks as files under `sessions/` in the shared {@link FileBackend}.
 *
 * Each block is written as a file whose name is derived from the key. Content type is encoded
 * in the file extension. The file path is returned as the reference for later retrieval.
 */
export class FileSessionStorage implements Storage {
  private readonly _backend: FileBackend

  constructor(config: FileSessionStorageConfig) {
    this._backend = config.backend
  }

  /** {@inheritDoc Storage.store} */
  async store(key: string, content: Uint8Array, contentType: string = 'text/plain'): Promise<string> {
    const sanitizedKey = key.replace(/[^a-zA-Z0-9_-]/g, '_')
    const ext = extensionFor(contentType)
    const path = `${SESSIONS_PREFIX}/${sanitizedKey}${ext}`

    const textContent = new TextDecoder().decode(content)
    await this._backend.write(path, textContent)
    return path
  }

  /** {@inheritDoc Storage.retrieve} */
  async retrieve(reference: string): Promise<{ content: Uint8Array; contentType: string }> {
    if (!reference.startsWith(`${SESSIONS_PREFIX}/`)) {
      throw new Error(`Reference not found: ${reference}`)
    }

    const textContent = await this._backend.read(reference)
    const content = new TextEncoder().encode(textContent)

    const ext = reference.slice(reference.lastIndexOf('.'))
    const contentType = contentTypeFor(ext)

    return { content, contentType }
  }
}

function contentTypeFor(ext: string): string {
  switch (ext) {
    case '.txt':
      return 'text/plain'
    case '.md':
      return 'text/markdown'
    case '.json':
      return 'application/json'
    default:
      return 'application/octet-stream'
  }
}
