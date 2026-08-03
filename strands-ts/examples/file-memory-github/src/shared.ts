/**
 * Shared setup for the three demo steps.
 *
 * Each step is its own process so the repo can be inspected on GitHub between them — the point of
 * backing memory with a git remote is that every stage is a browsable commit, not an in-memory blob.
 */

import type { Storage } from '@strands-agents/sdk/storage'
import { BedrockModel } from '@strands-agents/sdk'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
import { GithubStorage } from '@strands-agents/sdk/storage'

/** The store name, which also scopes keys under `memory/<name>/` inside the repo. */
export const STORE_NAME = 'agent-memory'

/**
 * The prefix the store would apply on its own. The demo pre-applies it so scripts can read
 * store-relative keys (the changelog) through the same view the store writes them under.
 */
const STORE_PREFIX = `memory/${STORE_NAME}`

/** Reads a required environment variable, exiting with a usable message when it is unset. */
export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required environment variable: ${name}`)
    console.error("Set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO — see this example's README.")
    process.exit(1)
  }
  return value
}

/** Repository coordinates the demo reads and writes. */
export interface DemoTarget {
  owner: string
  repo: string
  branch: string
  /** The raw backend — batching is controlled here, since it is a GithubStorage concern. */
  storage: GithubStorage
  /** The backend scoped to the store's namespace, for reading store-relative keys directly. */
  scoped: Storage
  memoryStore: FileMemoryStore
}

/**
 * Builds the GitHub-backed store from the environment.
 *
 * Namespacing is applied here rather than left to the store so the demo can read store-relative keys
 * through the same view; the store detects the pre-scoped storage and does not prefix it twice.
 *
 * @returns The repo coordinates plus the storage backend and the memory store over it
 */
export function createDemoTarget(): DemoTarget {
  const token = requiredEnv('GITHUB_TOKEN')
  const owner = requiredEnv('GITHUB_OWNER')
  const repo = requiredEnv('GITHUB_REPO')
  const branch = process.env['GITHUB_BRANCH'] ?? 'main'

  const storage = new GithubStorage({ owner, repo, branch, token })
  const scoped = storage.namespace(STORE_PREFIX)
  const memoryStore = new FileMemoryStore({ name: STORE_NAME, storage: scoped })

  return { owner, repo, branch, storage, scoped, memoryStore }
}

/**
 * Builds the model both the agent and consolidation use.
 *
 * Set `BEDROCK_NO_STREAM=1` on a role that is granted `bedrock:InvokeModel` but not
 * `bedrock:InvokeModelWithResponseStream` — that switches the provider to the non-streaming Converse
 * API. Tool calls and structured output work either way; only token-by-token delivery is lost.
 *
 * @returns A configured Bedrock model
 */
export function createModel(): BedrockModel {
  const modelId = process.env['MODEL_ID'] ?? 'global.anthropic.claude-sonnet-5'
  return new BedrockModel(process.env['BEDROCK_NO_STREAM'] ? { modelId, stream: false } : { modelId })
}

/** Prints the store's file listing — exactly what progressive disclosure injects each turn. */
export async function printListing(memoryStore: FileMemoryStore): Promise<void> {
  const files = await memoryStore.listFiles()
  if (files.length === 0) {
    console.log('  (store is empty)')
    return
  }
  const width = Math.max(...files.map((file) => file.path.length))
  for (const file of files) {
    console.log(`  ${file.path.padEnd(width)} — ${file.description}`)
  }
  console.log(`\n  ${files.length} files`)
}

/**
 * Waits until the listing reflects a just-pushed commit.
 *
 * GitHub can serve a cached tree for a few seconds after a push, so an immediate listing may still
 * enumerate keys the commit deleted. `listFiles` drops keys whose read fails, so that combination
 * under-reports rather than erroring. Polling until two consecutive listings agree keeps the demo's
 * before/after comparison honest; a scheduled consolidation job would not need this.
 *
 * @param memoryStore - The store to poll
 * @param attempts - How many times to re-list before giving up and returning the latest count
 */
export async function awaitConsistentListing(memoryStore: FileMemoryStore, attempts = 6): Promise<void> {
  let previous = -1
  for (let attempt = 0; attempt < attempts; attempt++) {
    const files = await memoryStore.listFiles()
    if (files.length === previous) return
    previous = files.length
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

/** A section header, to keep the three scripts' output readable. */
export function heading(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}\n`)
}
