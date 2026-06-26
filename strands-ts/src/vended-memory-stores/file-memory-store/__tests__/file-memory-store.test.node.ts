import { describe, it, expect, beforeEach } from 'vitest'
import { FileMemoryStore } from '../file-memory-store.js'
import type { InvokableTool } from '../../../tools/tool.js'
import type { FileBackend, FileChange, FileEntry } from '../types.js'

/**
 * In-memory implementation of FileBackend for testing FileMemoryStore
 * without touching the real filesystem.
 */
class InMemoryBackend implements FileBackend {
  private _files = new Map<string, { content: string; timestamp: number }>()
  private _changes: FileChange[] = []

  async read(path: string): Promise<string> {
    const entry = this._files.get(path)
    if (!entry) throw new Error(`file not found: ${path}`)
    return entry.content
  }

  async write(path: string, content: string): Promise<void> {
    const timestamp = Date.now()
    this._files.set(path, { content, timestamp })
    this._changes.push({ path, timestamp, operation: 'write' })
  }

  async delete(path: string): Promise<void> {
    this._files.delete(path)
    this._changes.push({ path, timestamp: Date.now(), operation: 'delete' })
  }

  async list(prefix?: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = []
    const seen = new Set<string>()

    for (const filePath of this._files.keys()) {
      const target = prefix ? prefix + '/' : ''
      if (!filePath.startsWith(target)) continue

      const remainder = filePath.slice(target.length)
      const slashIdx = remainder.indexOf('/')

      if (slashIdx === -1) {
        entries.push({ path: filePath, isDirectory: false })
      } else {
        const dirPath = prefix ? `${prefix}/${remainder.slice(0, slashIdx)}` : remainder.slice(0, slashIdx)
        if (!seen.has(dirPath)) {
          seen.add(dirPath)
          entries.push({ path: dirPath, isDirectory: true })
        }
      }
    }
    return entries
  }

  async exists(path: string): Promise<boolean> {
    return this._files.has(path)
  }

  async changesSince(timestamp: number): Promise<FileChange[]> {
    return this._changes.filter((c) => c.timestamp > timestamp)
  }

  async rollback(_path: string, _timestamp: number): Promise<void> {
    throw new Error('not implemented in test backend')
  }
}

describe('FileMemoryStore', () => {
  let backend: InMemoryBackend
  let store: FileMemoryStore

  beforeEach(() => {
    backend = new InMemoryBackend()
    store = new FileMemoryStore({
      name: 'test-store',
      description: 'A test file memory store',
      backend,
    })
  })

  describe('add', () => {
    it('writes a markdown file to knowledge/facts/', async () => {
      await store.add('User prefers dark mode', { title: 'dark-mode', description: 'Theme preference' })
      const exists = await backend.exists('knowledge/facts/dark-mode.md')
      expect(exists).toBe(true)
    })

    it('includes frontmatter with description', async () => {
      await store.add('Prefers integration tests', { title: 'testing', description: 'Testing approach' })
      const content = await backend.read('knowledge/facts/testing.md')
      expect(content).toContain('---')
      expect(content).toContain('description: "Testing approach"')
      expect(content).toContain('Prefers integration tests')
    })

    it('derives filename from content when no title provided', async () => {
      await store.add('The user likes vim keybindings')
      const entries = await backend.list('knowledge/facts')
      expect(entries.length).toBe(1)
      expect(entries[0]!.path).toMatch(/knowledge\/facts\/.*\.md$/)
    })

    it('derives description from first sentence when not provided', async () => {
      await store.add('Always use strict mode. It prevents bugs.')
      const entries = await backend.list('knowledge/facts')
      const content = await backend.read(entries[0]!.path)
      expect(content).toContain('description: "Always use strict mode')
    })
  })

  describe('search', () => {
    beforeEach(async () => {
      await store.add('User prefers dark mode for all editors', { title: 'dark-mode', description: 'Theme preference: dark mode' })
      await store.add('Testing philosophy: integration first, mock at boundaries', { title: 'testing', description: 'Integration-first testing approach' })
      await store.add('Deploy process uses blue-green strategy', { title: 'deploy', description: 'Deployment pipeline details' })
    })

    it('returns matching entries by keyword', async () => {
      const results = await store.search('dark mode')
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0]!.content).toContain('dark mode')
    })

    it('returns empty array for no matches', async () => {
      const results = await store.search('quantum computing')
      expect(results).toEqual([])
    })

    it('returns empty array for empty query', async () => {
      const results = await store.search('')
      expect(results).toEqual([])
    })

    it('respects maxSearchResults option', async () => {
      const results = await store.search('mode', { maxSearchResults: 1 })
      expect(results).toHaveLength(1)
    })

    it('ranks results by term frequency', async () => {
      const results = await store.search('testing')
      expect(results[0]!.metadata?.['path']).toContain('testing')
    })

    it('excludes system files from results', async () => {
      await backend.write(
        'knowledge/system/prefs.md',
        '---\ndescription: "User prefs"\n---\n\ndark mode everywhere'
      )
      const results = await store.search('dark mode')
      const paths = results.map((r) => r.metadata?.['path'] as string)
      expect(paths.every((p) => !p.startsWith('knowledge/system'))).toBe(true)
    })
  })

  describe('getTools', () => {
    it('returns read_memory_file and grep_memory tools', () => {
      const tools = store.getTools()
      expect(tools).toHaveLength(2)
      expect(tools[0]!.name).toBe('read_memory_file')
      expect(tools[1]!.name).toBe('grep_memory')
    })
  })

  describe('read_memory_file tool', () => {
    beforeEach(async () => {
      await store.add('Mock at HTTP boundaries only', { title: 'mocking-rules', description: 'Mocking guidelines' })
    })

    it('reads a knowledge file and returns the body', async () => {
      const tools = store.getTools()
      const readTool = tools[0]! as unknown as InvokableTool<unknown, unknown>
      const result = await readTool.invoke({ path: 'knowledge/facts/mocking-rules.md' })
      expect(result).toContain('Mock at HTTP boundaries only')
    })

    it('returns error for paths outside knowledge/', async () => {
      const tools = store.getTools()
      const readTool = tools[0]! as unknown as InvokableTool<unknown, unknown>
      const result = await readTool.invoke({ path: 'sessions/secret.md' })
      expect(result).toContain('Error')
    })

    it('returns error for nonexistent files', async () => {
      const tools = store.getTools()
      const readTool = tools[0]! as unknown as InvokableTool<unknown, unknown>
      const result = await readTool.invoke({ path: 'knowledge/facts/nonexistent.md' })
      expect(result).toContain('Error')
    })
  })

  describe('grep_memory tool', () => {
    beforeEach(async () => {
      await store.add('Retry failed requests with exponential backoff', { title: 'retry-strategy', description: 'Error handling pattern' })
      await store.add('Always validate user input at API boundaries', { title: 'validation', description: 'Input validation rules' })
    })

    it('finds matching content across files', async () => {
      const tools = store.getTools()
      const grepTool = tools[1]! as unknown as InvokableTool<unknown, unknown>
      const result = await grepTool.invoke({ query: 'exponential backoff' })
      expect(result).toContain('retry-strategy')
      expect(result).toContain('exponential backoff')
    })

    it('returns no matches message when nothing found', async () => {
      const tools = store.getTools()
      const grepTool = tools[1]! as unknown as InvokableTool<unknown, unknown>
      const result = await grepTool.invoke({ query: 'nonexistent term xyz' })
      expect(result).toBe('No matches found.')
    })
  })

  describe('renderFileTree', () => {
    beforeEach(async () => {
      await backend.write('knowledge/system/prefs.md', '---\ndescription: "Core preferences"\n---\n\nvim mode')
      await store.add('Testing approach', { title: 'testing', description: 'Integration-first' })
    })

    it('renders a tree with descriptions', async () => {
      const tree = await store.renderFileTree()
      expect(tree).toContain('knowledge/')
      expect(tree).toContain('system/')
      expect(tree).toContain('facts/')
      expect(tree).toContain('Integration-first')
    })

    it('marks system directory as loaded in full', async () => {
      const tree = await store.renderFileTree()
      expect(tree).toContain('[loaded in full]')
    })
  })

  describe('loadSystemKnowledge', () => {
    it('returns concatenated content of all system files', async () => {
      await backend.write('knowledge/system/a.md', '---\ndescription: "A"\n---\n\nContent A')
      await backend.write('knowledge/system/b.md', '---\ndescription: "B"\n---\n\nContent B')
      const result = await store.loadSystemKnowledge()
      expect(result).toContain('Content A')
      expect(result).toContain('Content B')
    })

    it('returns empty string when no system files exist', async () => {
      const result = await store.loadSystemKnowledge()
      expect(result).toBe('')
    })
  })

  describe('consolidate', () => {
    it('throws not-yet-implemented error', async () => {
      await expect(
        store.consolidate({ model: {}, operations: ['deduplicate'], scope: 'all' })
      ).rejects.toThrow('not yet implemented')
    })
  })

  describe('createInjector', () => {
    it('returns a plugin with the expected name', () => {
      const injector = store.createInjector()
      expect(injector.name).toBe('strands:file-memory-injector:test-store')
    })

    it('returns a plugin instance', () => {
      const injector = store.createInjector()
      expect(injector).toBeDefined()
      expect(typeof injector.initAgent).toBe('function')
    })
  })

  describe('properties', () => {
    it('exposes name from config', () => {
      expect(store.name).toBe('test-store')
    })

    it('exposes description from config', () => {
      expect(store.description).toBe('A test file memory store')
    })

    it('is writable by default', () => {
      expect(store.writable).toBe(true)
    })
  })
})
