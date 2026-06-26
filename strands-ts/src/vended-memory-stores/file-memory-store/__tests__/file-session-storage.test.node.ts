import { describe, it, expect, beforeEach } from 'vitest'
import { FileSessionStorage } from '../file-session-storage.js'
import type { FileBackend, FileChange, FileEntry } from '../types.js'

class InMemoryBackend implements FileBackend {
  private _files = new Map<string, string>()

  async read(path: string): Promise<string> {
    const content = this._files.get(path)
    if (content === undefined) throw new Error(`file not found: ${path}`)
    return content
  }

  async write(path: string, content: string): Promise<void> {
    this._files.set(path, content)
  }

  async delete(path: string): Promise<void> {
    this._files.delete(path)
  }

  async list(prefix?: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = []
    for (const filePath of this._files.keys()) {
      const target = prefix ? prefix + '/' : ''
      if (filePath.startsWith(target)) {
        entries.push({ path: filePath, isDirectory: false })
      }
    }
    return entries
  }

  async exists(path: string): Promise<boolean> {
    return this._files.has(path)
  }

  async changesSince(_timestamp: number): Promise<FileChange[]> {
    return []
  }

  async rollback(_path: string, _timestamp: number): Promise<void> {
    throw new Error('not implemented')
  }
}

describe('FileSessionStorage', () => {
  let backend: InMemoryBackend
  let storage: FileSessionStorage

  beforeEach(() => {
    backend = new InMemoryBackend()
    storage = new FileSessionStorage({ backend })
  })

  describe('store', () => {
    it('stores content under sessions/ and returns a reference', async () => {
      const content = new TextEncoder().encode('evicted content block')
      const reference = await storage.store('block-1', content, 'text/plain')
      expect(reference).toMatch(/^sessions\//)
      expect(reference).toContain('block-1')
    })

    it('uses appropriate extension for content type', async () => {
      const content = new TextEncoder().encode('{"key":"value"}')
      const reference = await storage.store('data', content, 'application/json')
      expect(reference).toMatch(/\.json$/)
    })

    it('defaults to text/plain extension', async () => {
      const content = new TextEncoder().encode('plain text')
      const reference = await storage.store('note', content)
      expect(reference).toMatch(/\.txt$/)
    })

    it('sanitizes key characters', async () => {
      const content = new TextEncoder().encode('data')
      const reference = await storage.store('path/with/../traversal', content)
      expect(reference).not.toContain('..')
      const afterPrefix = reference.slice('sessions/'.length)
      expect(afterPrefix).not.toContain('/')
    })
  })

  describe('retrieve', () => {
    it('retrieves previously stored content', async () => {
      const original = 'hello world'
      const content = new TextEncoder().encode(original)
      const reference = await storage.store('greeting', content, 'text/plain')

      const retrieved = await storage.retrieve(reference)
      const decoded = new TextDecoder().decode(retrieved.content)
      expect(decoded).toBe(original)
      expect(retrieved.contentType).toBe('text/plain')
    })

    it('returns correct content type for json', async () => {
      const content = new TextEncoder().encode('{}')
      const reference = await storage.store('obj', content, 'application/json')
      const retrieved = await storage.retrieve(reference)
      expect(retrieved.contentType).toBe('application/json')
    })

    it('throws for references not under sessions/', async () => {
      await expect(storage.retrieve('knowledge/facts/secret.md')).rejects.toThrow('Reference not found')
    })

    it('throws for nonexistent references', async () => {
      await expect(storage.retrieve('sessions/nonexistent.txt')).rejects.toThrow()
    })
  })
})
