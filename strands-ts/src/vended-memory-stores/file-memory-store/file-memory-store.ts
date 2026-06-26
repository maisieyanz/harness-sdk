/**
 * File-based memory store implementing the {@link MemoryStore} interface.
 *
 * Organizes knowledge as a structured file hierarchy under `knowledge/` in the shared
 * {@link FileBackend}. Provides progressive disclosure (file tree in system prompt + navigation
 * tools), keyword-based search, and offline consolidation.
 */

import type { JSONValue } from '../../types/json.js'
import type { MemoryEntry, MemoryStore, SearchOptions } from '../../memory/types.js'
import type { ExtractionConfig } from '../../memory/extraction/types.js'
import type { Tool } from '../../tools/tool.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { FileBackend, FileMemoryStoreConfig, ConsolidateConfig } from './types.js'
import { ContextInjector } from '../../vended-plugins/context-injector/plugin.js'
import { tool } from '../../tools/tool-factory.js'

const KNOWLEDGE_PREFIX = 'knowledge'
const SYSTEM_PREFIX = `${KNOWLEDGE_PREFIX}/system`
const FACTS_PREFIX = `${KNOWLEDGE_PREFIX}/facts`

/**
 * Parses YAML frontmatter from a markdown file, extracting the `description` field.
 */
function parseFrontmatter(content: string): { description: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { description: '', body: content }

  const frontmatter = match[1] ?? ''
  const body = match[2] ?? ''

  const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m)
  return { description: descMatch?.[1] ?? '', body }
}

/**
 * Generates a slug from text for use as a filename.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50)
}

/**
 * A zero-infrastructure memory store backed by a file hierarchy.
 *
 * Implements {@link MemoryStore} for use with {@link MemoryManager}. Knowledge is stored as
 * markdown files with YAML frontmatter under `knowledge/`. The agent navigates the file tree
 * using tools registered via {@link getTools}, and `search()` provides keyword-based fallback.
 *
 * Consolidation (offline maintenance) is triggered externally via {@link consolidate} and uses
 * an LLM to deduplicate, prune, and reorganize stored knowledge.
 */
export class FileMemoryStore implements MemoryStore {
  readonly name: string
  readonly description?: string
  readonly writable: boolean = true
  readonly maxSearchResults?: number
  readonly extraction?: boolean | ExtractionConfig

  private readonly _backend: FileBackend
  private readonly _maxTokens: number

  constructor(config: FileMemoryStoreConfig) {
    this.name = config.name
    if (config.description !== undefined) this.description = config.description
    if (config.maxSearchResults !== undefined) this.maxSearchResults = config.maxSearchResults
    if (config.extraction !== undefined) this.extraction = config.extraction
    this._backend = config.backend
    this._maxTokens = config.retrieval?.maxTokens ?? 2000
  }

  /**
   * Search knowledge files by keyword matching against filenames, descriptions, and content.
   *
   * Excludes `knowledge/system/` (already loaded in full via injection). Returns the top matches
   * ranked by term frequency.
   */
  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const maxResults = options?.maxSearchResults ?? this.maxSearchResults ?? 5
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []

    const scored: Array<{ entry: MemoryEntry; score: number }> = []
    await this._searchDirectory(KNOWLEDGE_PREFIX, terms, scored)

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, maxResults).map((s) => s.entry)
  }

  /**
   * Add a knowledge entry to `knowledge/facts/`.
   *
   * Writes a markdown file with YAML frontmatter. The filename is derived from `metadata.title`
   * if present, otherwise from the first few words of the content.
   */
  async add(content: string, metadata?: Record<string, JSONValue>): Promise<void> {
    const title = (metadata?.['title'] as string | undefined) ?? slugify(content.split(/[.\n]/)[0]!.slice(0, 60))
    const description =
      (metadata?.['description'] as string | undefined) ?? content.split(/[.\n]/)[0]!.slice(0, 120)

    const filename = `${slugify(title) || `entry-${Date.now()}`}.md`
    const path = `${FACTS_PREFIX}/${filename}`

    const fileContent = `---\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n\n${content}\n`
    await this._backend.write(path, fileContent)
  }

  /**
   * Returns tools for progressive disclosure: `read_memory_file` and `grep_memory`.
   *
   * These let the agent navigate the knowledge hierarchy directly — reading specific files
   * or searching across file content.
   */
  getTools(): Tool[] {
    return [this._readFileTool(), this._grepTool()]
  }

  /**
   * Returns a {@link ContextInjector} plugin that injects the knowledge file tree and system
   * knowledge into the model's context every user turn.
   *
   * Register this as a plugin on the agent alongside the {@link MemoryManager}. When using
   * progressive disclosure, disable the MemoryManager's built-in injection (`injection: false`)
   * and use this injector instead — the agent sees the file tree and navigates with tools.
   *
   * @returns A plugin that injects the file tree and system knowledge into the model context
   */
  createInjector(): Plugin {
    return new ContextInjector({
      name: `strands:file-memory-injector:${this.name}`,
      trigger: 'everyTurn',
      renderContent: async () => {
        const [tree, systemKnowledge] = await Promise.all([this.renderFileTree(), this.loadSystemKnowledge()])

        const parts: string[] = []

        if (systemKnowledge) {
          parts.push(`<memory-system>\n${systemKnowledge}\n</memory-system>`)
        }

        if (tree) {
          parts.push(
            `<memory-files>\n${tree}\n\nUse read_memory_file to load a file, or grep_memory to search content.\n</memory-files>`
          )
        }

        return parts.length > 0 ? parts.join('\n\n') : undefined
      },
    })
  }

  /**
   * Renders the knowledge file tree for injection into the system prompt.
   *
   * Lists all files under `knowledge/` with their descriptions. Files in `system/` are marked
   * as always-loaded; others show filename + description only.
   */
  async renderFileTree(): Promise<string> {
    const lines: string[] = ['knowledge/']
    await this._renderTreeLevel(KNOWLEDGE_PREFIX, lines, 1)
    return lines.join('\n')
  }

  /**
   * Returns the full content of all files in `knowledge/system/` for injection.
   */
  async loadSystemKnowledge(): Promise<string> {
    const entries = await this._backend.list(SYSTEM_PREFIX)
    const parts: string[] = []

    for (const entry of entries) {
      if (entry.isDirectory) continue
      const content = await this._backend.read(entry.path)
      parts.push(content)
    }

    return parts.join('\n\n---\n\n')
  }

  /**
   * Run offline consolidation.
   *
   * Scopes work to changed files (or all files), clusters by subdirectory, and invokes an LLM
   * to perform the requested maintenance operations.
   */
  async consolidate(_config: ConsolidateConfig): Promise<void> {
    throw new Error('consolidation is not yet implemented')
  }

  private async _searchDirectory(
    prefix: string,
    terms: string[],
    results: Array<{ entry: MemoryEntry; score: number }>
  ): Promise<void> {
    const entries = await this._backend.list(prefix)

    for (const entry of entries) {
      if (entry.isDirectory) {
        await this._searchDirectory(entry.path, terms, results)
        continue
      }

      if (entry.path.startsWith(SYSTEM_PREFIX)) continue

      const content = await this._backend.read(entry.path)
      const { description, body } = parseFrontmatter(content)
      const searchable = `${entry.path} ${description} ${body}`.toLowerCase()

      let score = 0
      for (const term of terms) {
        const matches = searchable.split(term).length - 1
        score += matches
      }

      if (score > 0) {
        results.push({
          entry: {
            content: body.trim(),
            metadata: { path: entry.path, description },
          },
          score,
        })
      }
    }
  }

  private async _renderTreeLevel(prefix: string, lines: string[], depth: number): Promise<void> {
    const entries = await this._backend.list(prefix)
    const indent = '│   '.repeat(depth - 1) + '├── '

    for (const entry of entries) {
      if (entry.isDirectory) {
        const dirName = entry.path.split('/').pop()!
        const marker = entry.path === SYSTEM_PREFIX ? ' [loaded in full]' : ''
        lines.push(`${indent}${dirName}/${marker}`)
        await this._renderTreeLevel(entry.path, lines, depth + 1)
      } else {
        const fileName = entry.path.split('/').pop()!
        try {
          const content = await this._backend.read(entry.path)
          const { description } = parseFrontmatter(content)
          const desc = description ? ` — "${description}"` : ''
          lines.push(`${indent}${fileName}${desc}`)
        } catch {
          lines.push(`${indent}${fileName}`)
        }
      }
    }
  }

  private _readFileTool(): Tool {
    const backend = this._backend
    return tool({
      name: 'read_memory_file',
      description: 'Read a specific knowledge file from memory. Use the file tree to identify relevant files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file (e.g., "knowledge/facts/testing-philosophy.md")',
          },
        },
        required: ['path'],
      },
      callback: async (input: unknown): Promise<JSONValue> => {
        const { path } = input as { path: string }
        if (!path.startsWith(KNOWLEDGE_PREFIX + '/')) {
          return 'Error: path must be under knowledge/'
        }
        try {
          const content = await backend.read(path)
          const { body } = parseFrontmatter(content)
          return body.trim()
        } catch {
          return `Error: file not found: ${path}`
        }
      },
    })
  }

  private _grepTool(): Tool {
    const backend = this._backend
    return tool({
      name: 'grep_memory',
      description:
        'Search across knowledge file content for a keyword or phrase. Returns matching file paths and excerpts.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search term or phrase to look for across all knowledge files',
          },
        },
        required: ['query'],
      },
      callback: async (input: unknown): Promise<JSONValue> => {
        const { query: rawQuery } = input as { query: string }
        const queryLower = rawQuery.toLowerCase()
        const matches: Array<{ path: string; excerpt: string }> = []

        const searchDir = async (prefix: string): Promise<void> => {
          const entries = await backend.list(prefix)
          for (const entry of entries) {
            if (entry.isDirectory) {
              await searchDir(entry.path)
              continue
            }
            try {
              const content = await backend.read(entry.path)
              const lower = content.toLowerCase()
              const idx = lower.indexOf(queryLower)
              if (idx !== -1) {
                const start = Math.max(0, idx - 50)
                const end = Math.min(content.length, idx + queryLower.length + 50)
                matches.push({ path: entry.path, excerpt: content.slice(start, end).trim() })
              }
            } catch {
              // Skip unreadable files
            }
          }
        }

        await searchDir(KNOWLEDGE_PREFIX)

        if (matches.length === 0) return 'No matches found.'
        return matches
          .slice(0, 10)
          .map((m) => `${m.path}:\n  ...${m.excerpt}...`)
          .join('\n\n')
      },
    })
  }
}
