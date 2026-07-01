import { describe, it, expect, beforeEach } from 'vitest'
import { FileMemoryStore } from '../file-memory-store.js'
import type { InvokableTool } from '../../../tools/tool.js'
import type { Storage } from '../../../storage/storage.js'

/**
 * In-memory implementation of the unified Storage interface for testing.
 */
class InMemoryStorage implements Storage {
  private _store = new Map<string, Uint8Array>()

  async put(key: string, data: Uint8Array): Promise<void> {
    this._store.set(key, data.slice())
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = this._store.get(key)
    return value === undefined ? null : value.slice()
  }

  async delete(key: string): Promise<void> {
    this._store.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) keys.push(key)
    }
    return keys.sort()
  }
}

const encoder = new TextEncoder()

describe('FileMemoryStore', () => {
  let storage: InMemoryStorage
  let store: FileMemoryStore

  beforeEach(() => {
    storage = new InMemoryStorage()
    store = new FileMemoryStore({
      name: 'test-store',
      description: 'A test file memory store',
      storage,
    })
  })

  describe('add', () => {
    it('writes a markdown file to knowledge/facts/', async () => {
      await store.add('User prefers dark mode', { title: 'dark-mode', description: 'Theme preference' })
      const content = await storage.get('knowledge/facts/dark-mode.md')
      expect(content).not.toBeNull()
      expect(new TextDecoder().decode(content!)).toContain('dark mode')
    })

    it('includes frontmatter with description', async () => {
      await store.add('Prefers integration tests', { title: 'testing', description: 'Testing approach' })
      const bytes = await storage.get('knowledge/facts/testing.md')
      const content = new TextDecoder().decode(bytes!)
      expect(content).toContain('---')
      expect(content).toContain('description: "Testing approach"')
      expect(content).toContain('Prefers integration tests')
    })

    it('derives filename from content when no title provided', async () => {
      await store.add('The user likes vim keybindings')
      const keys = await storage.list('knowledge/facts/')
      expect(keys.length).toBe(1)
      expect(keys[0]).toMatch(/knowledge\/facts\/.*\.md$/)
    })

    it('derives description from first sentence when not provided', async () => {
      await store.add('Always use strict mode. It prevents bugs.')
      const keys = await storage.list('knowledge/facts/')
      const bytes = await storage.get(keys[0]!)
      const content = new TextDecoder().decode(bytes!)
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
      await storage.put(
        'knowledge/system/prefs.md',
        encoder.encode('---\ndescription: "User prefs"\n---\n\ndark mode everywhere')
      )
      const results = await store.search('dark mode')
      const paths = results.map((r) => r.metadata?.['path'] as string)
      expect(paths.every((p) => !p.startsWith('knowledge/system/'))).toBe(true)
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
      await storage.put('knowledge/system/prefs.md', encoder.encode('---\ndescription: "Core preferences"\n---\n\nvim mode'))
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
      await storage.put('knowledge/system/a.md', encoder.encode('---\ndescription: "A"\n---\n\nContent A'))
      await storage.put('knowledge/system/b.md', encoder.encode('---\ndescription: "B"\n---\n\nContent B'))
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
    it('does nothing when no files are in scope', async () => {
      await expect(
        store.consolidate({ model: {} as any, operations: ['deduplicate'], scope: 'since-last' })
      ).resolves.toBeUndefined()
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
