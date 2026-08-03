/**
 * Progressive disclosure for {@link FileMemoryStore}.
 *
 * The store shows the model what it knows *about* — every file's path and description — and lets the
 * model pull the content it judges relevant. That splits retrieval into a cheap recurring part (the
 * injected listing) and an on-demand part (the read tool), instead of betting a fixed context budget
 * on a keyword search's top hits.
 *
 * Holds the injector plugin the store hands to the {@link MemoryManager} and the read tool; the store
 * owns the file listing, since it knows the storage layout.
 */

import type { JSONValue } from '../../types/json.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { Storage } from '../../storage/storage.js'
import type { Tool } from '../../tools/tool.js'
import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import { ContextInjector } from '../../vended-plugins/context-injector/plugin.js'
import { escapeXmlText } from '../../injection/xml.js'
import { assertKnowledgePath, decoder, parseFrontmatter } from './internal.js'

/**
 * Builds the plugin that injects the file listing, which the store supplies to the
 * {@link MemoryManager} via `getPlugins()`. Skips injection when the store is empty, so a fresh store
 * costs no tokens.
 *
 * Injects on every turn rather than only on a user turn: the listing is the model's only map of what
 * memory exists, so an autonomous turn that has just read one file still needs it to find the next.
 * Both the path and the description are escaped, since stored content is model- or user-derived and so
 * a prompt-injection surface.
 *
 * @param storeName - The store's name, which makes the plugin name unique per store
 * @param listFiles - Supplies the current path/description listing, called once per injected turn
 * @returns A {@link ContextInjector} that injects the listing
 */
export function createDisclosureInjector(
  storeName: string,
  listFiles: () => Promise<{ path: string; description: string }[]>
): Plugin {
  return new ContextInjector({
    name: `strands:file-memory-disclosure:${storeName}`,
    trigger: 'everyTurn',
    renderContent: async (): Promise<string | undefined> => {
      const files = await listFiles()
      if (files.length === 0) return undefined

      const instruction = `You have these memory files from previous conversations. Read any whose description looks relevant to the current request with ${readToolName(storeName)} before answering — the descriptions below are summaries, not the content.`
      const lines = files.map((file) =>
        file.description
          ? `${escapeXmlText(file.path)} — "${escapeXmlText(file.description)}"`
          : escapeXmlText(file.path)
      )
      return `<memory-files>\n${instruction}\n\n${lines.join('\n')}\n</memory-files>`
    },
  })
}

/**
 * Builds the on-demand half of progressive disclosure: a tool that reads one file by path. Named after
 * the store, e.g. `agent-memory` yields `read_agent_memory_file` — tool names must be unique
 * agent-wide, so two file memory stores would otherwise collide and the registry would reject the
 * second.
 *
 * @param storeName - The store's name, which names the tool
 * @param storage - The store's namespaced storage
 * @returns The read tool, ready to register
 */
export function createReadTool(storeName: string, storage: Storage): Tool {
  return tool({
    name: readToolName(storeName),
    description:
      'Read one memory file in full, by its exact path. Use when the memory file listing shows a path whose description looks relevant to the current task — the listing gives you only a one-line summary, this gives you the content.',
    inputSchema: z.object({
      path: z
        .string()
        .describe('Exact path of the file to read, as shown in the memory file listing (e.g. "facts/testing.md").'),
    }),
    callback: async (input) => {
      // Canonicalize with the same rules add() applies on the way in, so a file written under one
      // spelling is not readable under another. The rejection messages reach the model as the tool
      // error, which is enough for it to correct the path itself.
      const path = assertKnowledgePath(input.path)

      const bytes = await storage.read(path)
      if (!bytes) {
        throw new Error(`No memory file at '${path}'. Paths must match the memory file listing exactly.`)
      }

      const { description, body } = parseFrontmatter(decoder.decode(bytes))
      return { path, description, content: body.trim() } as JSONValue
    },
  })
}

/** Derives the read tool's name from the store's name. */
function readToolName(storeName: string): string {
  return `read_${storeName.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}_file`
}
