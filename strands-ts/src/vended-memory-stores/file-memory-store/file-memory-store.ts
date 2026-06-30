/**
 * File-based memory store implementing the {@link MemoryStore} interface.
 *
 * Organizes knowledge as a structured file hierarchy under `knowledge/`. Provides progressive
 * disclosure (file tree in system prompt + navigation tools), keyword-based search, and offline
 * consolidation via an agent-based maintenance step.
 */

import type { JSONValue } from '../../types/json.js'
import type { MemoryEntry, MemoryStore, SearchOptions } from '../../memory/types.js'
import type { ExtractionConfig } from '../../memory/extraction/types.js'
import type { Tool } from '../../tools/tool.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { FileStorage, FileMemoryStoreConfig, ConsolidateConfig, ConsolidationOperation } from './types.js'
import { Agent } from '../../agent/agent.js'
import { ContextInjector } from '../../vended-plugins/context-injector/plugin.js'
import { tool } from '../../tools/tool-factory.js'
import { logger } from '../../logging/logger.js'

const KNOWLEDGE_PREFIX = 'knowledge'
const SYSTEM_PREFIX = `${KNOWLEDGE_PREFIX}/system`
const FACTS_PREFIX = `${KNOWLEDGE_PREFIX}/facts`

function parseFrontmatter(content: string): { description: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { description: '', body: content }

  const frontmatter = match[1] ?? ''
  const body = match[2] ?? ''

  const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m)
  return { description: descMatch?.[1] ?? '', body }
}

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

  private readonly _storage: FileStorage

  constructor(config: FileMemoryStoreConfig) {
    this.name = config.name
    if (config.description !== undefined) this.description = config.description
    if (config.maxSearchResults !== undefined) this.maxSearchResults = config.maxSearchResults
    if (config.extraction !== undefined) this.extraction = config.extraction
    this._storage = config.storage
  }

  // ---------------------------------------------------------------------------
  // MemoryStore interface
  // ---------------------------------------------------------------------------

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
    await this._storage.write(path, fileContent)
  }

  /**
   * Returns tools for progressive disclosure: `read_memory_file` and `grep_memory`.
   */
  getTools(): Tool[] {
    return [this._readFileTool(), this._grepTool()]
  }

  // ---------------------------------------------------------------------------
  // Progressive disclosure
  // ---------------------------------------------------------------------------

  /**
   * Returns a {@link ContextInjector} plugin that injects the knowledge file tree and system
   * knowledge into the model's context every turn.
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
   * Renders the knowledge file tree with descriptions for system prompt injection.
   */
  async renderFileTree(): Promise<string> {
    const lines: string[] = ['knowledge/']
    await this._renderTreeLevel(KNOWLEDGE_PREFIX, lines, 1)
    return lines.join('\n')
  }

  /**
   * Returns the full content of all files in `knowledge/system/`.
   */
  async loadSystemKnowledge(): Promise<string> {
    const entries = await this._storage.list(SYSTEM_PREFIX)
    const parts: string[] = []

    for (const entry of entries) {
      if (entry.isDirectory) continue
      const content = await this._storage.read(entry.path)
      parts.push(content)
    }

    return parts.join('\n\n---\n\n')
  }

  // ---------------------------------------------------------------------------
  // Consolidation
  // ---------------------------------------------------------------------------

  /**
   * Run offline consolidation.
   *
   * Scopes work to changed files (via mtime) or all files, clusters by subdirectory, and
   * invokes an LLM agent to perform the requested maintenance operations. Records each run
   * in `consolidation/changelog.md`.
   *
   * @param config - Model, operations, and scope for this consolidation run
   */
  async consolidate(config: ConsolidateConfig): Promise<void> {
    const filePaths = await this._scopeFiles(config.scope)
    if (filePaths.length === 0) {
      logger.debug('scope=<empty> | no files to consolidate')
      return
    }

    const clusters = this._clusterByDirectory(filePaths)

    for (const [directory, paths] of Object.entries(clusters)) {
      await this._consolidateCluster(directory, paths, config)
    }

    await this._recordConsolidation(config.operations)
  }

  // ---------------------------------------------------------------------------
  // Private — search
  // ---------------------------------------------------------------------------

  private async _searchDirectory(
    prefix: string,
    terms: string[],
    results: Array<{ entry: MemoryEntry; score: number }>
  ): Promise<void> {
    const entries = await this._storage.list(prefix)

    for (const entry of entries) {
      if (entry.isDirectory) {
        await this._searchDirectory(entry.path, terms, results)
        continue
      }

      if (entry.path.startsWith(SYSTEM_PREFIX)) continue

      const content = await this._storage.read(entry.path)
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

  // ---------------------------------------------------------------------------
  // Private — tree rendering
  // ---------------------------------------------------------------------------

  private async _renderTreeLevel(prefix: string, lines: string[], depth: number): Promise<void> {
    const entries = await this._storage.list(prefix)
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
          const content = await this._storage.read(entry.path)
          const { description } = parseFrontmatter(content)
          const desc = description ? ` — "${description}"` : ''
          lines.push(`${indent}${fileName}${desc}`)
        } catch {
          lines.push(`${indent}${fileName}`)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — tools
  // ---------------------------------------------------------------------------

  private _readFileTool(): Tool {
    const storage = this._storage
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
          const content = await storage.read(path)
          const { body } = parseFrontmatter(content)
          return body.trim()
        } catch {
          return `Error: file not found: ${path}`
        }
      },
    })
  }

  private _grepTool(): Tool {
    const storage = this._storage
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
          const entries = await storage.list(prefix)
          for (const entry of entries) {
            if (entry.isDirectory) {
              await searchDir(entry.path)
              continue
            }
            try {
              const content = await storage.read(entry.path)
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

  // ---------------------------------------------------------------------------
  // Private — consolidation
  // ---------------------------------------------------------------------------

  private async _scopeFiles(scope: 'since-last' | 'all'): Promise<string[]> {
    if (scope === 'all') {
      return this._collectAllFiles(KNOWLEDGE_PREFIX)
    }

    const lastTimestamp = await this._readLastConsolidationTimestamp()
    return this._collectFilesSince(KNOWLEDGE_PREFIX, lastTimestamp)
  }

  private async _collectFilesSince(prefix: string, timestamp: number): Promise<string[]> {
    const entries = await this._storage.list(prefix)
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory) {
        files.push(...(await this._collectFilesSince(entry.path, timestamp)))
      } else if (entry.mtime !== undefined && entry.mtime > timestamp) {
        files.push(entry.path)
      } else if (entry.mtime === undefined) {
        files.push(entry.path)
      }
    }
    return files
  }

  private async _collectAllFiles(prefix: string): Promise<string[]> {
    const entries = await this._storage.list(prefix)
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory) {
        files.push(...(await this._collectAllFiles(entry.path)))
      } else {
        files.push(entry.path)
      }
    }
    return files
  }

  private _clusterByDirectory(paths: string[]): Record<string, string[]> {
    const clusters: Record<string, string[]> = {}
    for (const filePath of paths) {
      const parts = filePath.split('/')
      const dir = parts.slice(0, -1).join('/')
      if (!clusters[dir]) clusters[dir] = []
      clusters[dir]!.push(filePath)
    }
    return clusters
  }

  private async _consolidateCluster(
    directory: string,
    paths: string[],
    config: ConsolidateConfig
  ): Promise<void> {
    const fileContents: string[] = []
    for (const filePath of paths) {
      try {
        const content = await this._storage.read(filePath)
        fileContents.push(`--- ${filePath} ---\n${content}`)
      } catch {
        // File may have been deleted between scope and execution
      }
    }

    if (fileContents.length === 0) return

    const systemPrompt = this._buildConsolidationPrompt(config.operations, directory)

    const agent = new Agent({
      model: config.model,
      systemPrompt,
      tools: [this._consolidationReadTool(), this._consolidationWriteTool(), this._consolidationDeleteTool()],
      printer: false,
    })

    const userMessage = `Here are the knowledge files to process:\n\n${fileContents.join('\n\n')}`

    await agent.invoke(userMessage)
  }

  private _buildConsolidationPrompt(operations: ConsolidationOperation[], directory: string): string {
    const operationInstructions: Record<ConsolidationOperation, string> = {
      deduplicate: 'Merge files that express the same fact into a single file. Remove the redundant one.',
      'resolve-contradictions':
        'When two files contradict each other, keep the more recent fact and delete the outdated one.',
      'derive-insights':
        'Combine related facts into higher-level patterns or summaries when multiple files share a theme.',
      prune: 'Delete entries whose content is fully covered by a newer, more complete file.',
      reorganize:
        'Move files to more appropriate subdirectories based on content (e.g., skills/ for procedural knowledge, system/ for broadly relevant facts).',
    }

    const instructions = operations.map((op) => `- **${op}**: ${operationInstructions[op]}`).join('\n')

    return [
      'You are a memory consolidation agent. Your job is to improve the quality and organization of stored knowledge files.',
      '',
      `You are working on files in: ${directory}`,
      '',
      '## Operations to perform:',
      instructions,
      '',
      '## Rules:',
      '- Use the provided tools to read, write, and delete files.',
      '- Preserve the markdown format with YAML frontmatter (description field).',
      '- When merging files, update the description to reflect the combined content.',
      '- When moving files (reorganize), write to the new path and delete the old one.',
      '- Be conservative — only act when you are confident the operation improves quality.',
      '- Process all provided files and report what you changed.',
    ].join('\n')
  }

  private _consolidationReadTool(): Tool {
    const storage = this._storage
    return tool({
      name: 'read_file',
      description: 'Read a knowledge file by path.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to read' } },
        required: ['path'],
      },
      callback: async (input: unknown): Promise<JSONValue> => {
        const { path } = input as { path: string }
        try {
          return await storage.read(path)
        } catch {
          return `Error: file not found: ${path}`
        }
      },
    })
  }

  private _consolidationWriteTool(): Tool {
    const storage = this._storage
    return tool({
      name: 'write_file',
      description: 'Write or overwrite a knowledge file. Content should be markdown with YAML frontmatter.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Full file content including frontmatter' },
        },
        required: ['path', 'content'],
      },
      callback: async (input: unknown): Promise<JSONValue> => {
        const { path, content } = input as { path: string; content: string }
        if (!path.startsWith(KNOWLEDGE_PREFIX + '/')) {
          return 'Error: path must be under knowledge/'
        }
        await storage.write(path, content)
        return `Written: ${path}`
      },
    })
  }

  private _consolidationDeleteTool(): Tool {
    const storage = this._storage
    return tool({
      name: 'delete_file',
      description: 'Delete a knowledge file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to delete' } },
        required: ['path'],
      },
      callback: async (input: unknown): Promise<JSONValue> => {
        const { path } = input as { path: string }
        if (!path.startsWith(KNOWLEDGE_PREFIX + '/')) {
          return 'Error: path must be under knowledge/'
        }
        await storage.delete(path)
        return `Deleted: ${path}`
      },
    })
  }

  private async _readLastConsolidationTimestamp(): Promise<number> {
    const changelogPath = `consolidation/changelog.md`
    try {
      const content = await this._storage.read(changelogPath)
      const match = content.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/m)
      if (match?.[1]) {
        return new Date(match[1]).getTime()
      }
    } catch {
      // No changelog yet
    }
    return 0
  }

  private async _recordConsolidation(operations: ConsolidationOperation[]): Promise<void> {
    const changelogPath = `consolidation/changelog.md`
    const timestamp = new Date().toISOString()
    const entry = `## ${timestamp}\n- Operations: ${operations.join(', ')}\n\n`

    let existing = ''
    try {
      existing = await this._storage.read(changelogPath)
    } catch {
      // First consolidation
    }

    await this._storage.write(changelogPath, entry + existing)
  }
}
