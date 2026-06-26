import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { LocalFileBackend } from '../local-file-backend.js'

describe('LocalFileBackend', () => {
  let tmpDir: string
  let backend: LocalFileBackend

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-backend-test-'))
    backend = new LocalFileBackend({ rootPath: tmpDir })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('write', () => {
    it('creates a file with the given content', async () => {
      await backend.write('test.md', '# Hello')
      const content = await fs.readFile(path.join(tmpDir, 'test.md'), 'utf-8')
      expect(content).toBe('# Hello')
    })

    it('creates intermediate directories', async () => {
      await backend.write('a/b/c.md', 'deep')
      const content = await fs.readFile(path.join(tmpDir, 'a/b/c.md'), 'utf-8')
      expect(content).toBe('deep')
    })

    it('overwrites existing files', async () => {
      await backend.write('file.md', 'v1')
      await backend.write('file.md', 'v2')
      const content = await backend.read('file.md')
      expect(content).toBe('v2')
    })
  })

  describe('read', () => {
    it('returns file content as a string', async () => {
      await backend.write('greeting.md', 'hello world')
      const content = await backend.read('greeting.md')
      expect(content).toBe('hello world')
    })

    it('throws when file does not exist', async () => {
      await expect(backend.read('nonexistent.md')).rejects.toThrow()
    })
  })

  describe('delete', () => {
    it('removes an existing file', async () => {
      await backend.write('doomed.md', 'bye')
      await backend.delete('doomed.md')
      const exists = await backend.exists('doomed.md')
      expect(exists).toBe(false)
    })

    it('does not throw when file does not exist', async () => {
      await expect(backend.delete('ghost.md')).resolves.toBeUndefined()
    })
  })

  describe('list', () => {
    it('lists files and directories at the root', async () => {
      await backend.write('file1.md', 'a')
      await backend.write('subdir/file2.md', 'b')
      const entries = await backend.list()
      const paths = entries.map((e) => e.path)
      expect(paths).toContain('file1.md')
      expect(paths).toContain('subdir')
    })

    it('lists entries under a prefix', async () => {
      await backend.write('knowledge/facts/a.md', 'fact a')
      await backend.write('knowledge/facts/b.md', 'fact b')
      const entries = await backend.list('knowledge/facts')
      expect(entries).toHaveLength(2)
      expect(entries.every((e) => !e.isDirectory)).toBe(true)
    })

    it('returns empty array for nonexistent directory', async () => {
      const entries = await backend.list('nonexistent')
      expect(entries).toEqual([])
    })

    it('excludes .journal and .versions from results', async () => {
      await backend.write('file.md', 'content')
      const entries = await backend.list()
      const names = entries.map((e) => e.path)
      expect(names).not.toContain('.journal')
      expect(names).not.toContain('.versions')
    })
  })

  describe('exists', () => {
    it('returns true for existing files', async () => {
      await backend.write('exists.md', 'yes')
      expect(await backend.exists('exists.md')).toBe(true)
    })

    it('returns false for missing files', async () => {
      expect(await backend.exists('nope.md')).toBe(false)
    })
  })

  describe('changesSince', () => {
    it('returns changes after the given timestamp', async () => {
      const before = Date.now() - 1
      await backend.write('a.md', 'content')
      const changes = await backend.changesSince(before)
      expect(changes.length).toBeGreaterThanOrEqual(1)
      expect(changes.some((c) => c.path === 'a.md' && c.operation === 'write')).toBe(true)
    })

    it('includes deletes', async () => {
      await backend.write('b.md', 'content')
      const afterWrite = Date.now()
      await backend.delete('b.md')
      const changes = await backend.changesSince(afterWrite - 1)
      expect(changes.some((c) => c.path === 'b.md' && c.operation === 'delete')).toBe(true)
    })

    it('returns empty when no journal exists', async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-backend-'))
      const freshBackend = new LocalFileBackend({ rootPath: freshDir })
      const changes = await freshBackend.changesSince(0)
      expect(changes).toEqual([])
      await fs.rm(freshDir, { recursive: true, force: true })
    })
  })

  describe('rollback', () => {
    it('restores a file to its previous state', async () => {
      await backend.write('evolving.md', 'version 1')
      await new Promise((r) => setTimeout(r, 20))
      await backend.write('evolving.md', 'version 2')
      // The v1 snapshot was created at the start of write #2; rolling back to
      // "now" (after both writes) finds that snapshot and restores v1.
      const afterV2 = Date.now()
      await backend.rollback('evolving.md', afterV2)
      const content = await backend.read('evolving.md')
      expect(content).toBe('version 1')
    })

    it('throws when no version history exists', async () => {
      await expect(backend.rollback('no-history.md', Date.now())).rejects.toThrow('no version history')
    })
  })

  describe('path traversal protection', () => {
    it('blocks relative paths that escape the root', async () => {
      await expect(backend.read('../../../etc/passwd')).rejects.toThrow('path traversal blocked')
    })

    it('blocks absolute path components in relative paths', async () => {
      await expect(backend.write('../../escape.md', 'bad')).rejects.toThrow('path traversal blocked')
    })
  })
})
