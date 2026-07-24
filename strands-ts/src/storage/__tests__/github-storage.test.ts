import type { Octokit } from '@octokit/rest'

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StorageError } from '../../errors.js'
import { decodeBase64, encodeBase64 } from '../../types/media.js'
import { GithubStorage, type GithubStorageConfig } from '../github-storage.js'

interface MockOctokit {
  git: {
    getRef: ReturnType<typeof vi.fn>
    getCommit: ReturnType<typeof vi.fn>
    getTree: ReturnType<typeof vi.fn>
    createBlob: ReturnType<typeof vi.fn>
    createTree: ReturnType<typeof vi.fn>
    createCommit: ReturnType<typeof vi.fn>
    updateRef: ReturnType<typeof vi.fn>
  }
  repos: {
    getContent: ReturnType<typeof vi.fn>
    createOrUpdateFileContents: ReturnType<typeof vi.fn>
    deleteFile: ReturnType<typeof vi.fn>
  }
}

/** Builds a mock Octokit whose git/repos namespaces are vi.fn()s the tests drive. */
function mockOctokit(): MockOctokit {
  return {
    git: {
      getRef: vi.fn(),
      getCommit: vi.fn(),
      getTree: vi.fn(),
      createBlob: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      updateRef: vi.fn(),
    },
    repos: {
      getContent: vi.fn(),
      createOrUpdateFileContents: vi.fn(),
      deleteFile: vi.fn(),
    },
  }
}

/** An Octokit 404, shaped like the errors the REST client throws on a missing resource. */
function notFound(): Error & { status: number } {
  return Object.assign(new Error('Not Found'), { status: 404 })
}

const encoder = new TextEncoder()

describe('GithubStorage', () => {
  let octokit: ReturnType<typeof mockOctokit>

  beforeEach(() => {
    octokit = mockOctokit()
  })

  const newStorage = (config?: Partial<GithubStorageConfig>): GithubStorage =>
    new GithubStorage({ owner: 'org', repo: 'mem', octokit: octokit as unknown as Octokit, ...config })

  describe('constructor', () => {
    it('throws when both octokit and token are provided', () => {
      expect(
        () => new GithubStorage({ owner: 'org', repo: 'mem', token: 't', octokit: octokit as unknown as Octokit })
      ).toThrow(StorageError)
    })

    it('accepts owner and repo alone', () => {
      expect(() => new GithubStorage({ owner: 'org', repo: 'mem' })).not.toThrow()
    })
  })

  describe('write', () => {
    it('creates a file with no sha when the key does not exist', async () => {
      octokit.repos.getContent.mockRejectedValue(notFound())
      octokit.repos.createOrUpdateFileContents.mockResolvedValue({})
      const storage = newStorage({ prefix: 'agents/' })

      await storage.write('knowledge/a.md', encoder.encode('hello'))

      expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'org',
          repo: 'mem',
          path: 'agents/knowledge/a.md',
          content: encodeBase64(encoder.encode('hello')),
          branch: 'main',
        })
      )
      expect(octokit.repos.createOrUpdateFileContents.mock.calls[0]![0]).not.toHaveProperty('sha')
    })

    it('passes the existing sha when the key already exists', async () => {
      octokit.repos.getContent.mockResolvedValue({ data: { type: 'file', sha: 'abc123' } })
      octokit.repos.createOrUpdateFileContents.mockResolvedValue({})
      const storage = newStorage()

      await storage.write('knowledge/a.md', encoder.encode('hi'))

      expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({ sha: 'abc123' }))
    })

    it('round-trips arbitrary bytes through base64', async () => {
      octokit.repos.getContent.mockRejectedValue(notFound())
      octokit.repos.createOrUpdateFileContents.mockResolvedValue({})
      const storage = newStorage()
      const bytes = new Uint8Array([0, 1, 2, 255, 128])

      await storage.write('blob', bytes)

      const sent = octokit.repos.createOrUpdateFileContents.mock.calls[0]![0].content
      expect(decodeBase64(sent)).toEqual(bytes)
    })

    it('wraps errors in StorageError', async () => {
      octokit.repos.getContent.mockRejectedValue(notFound())
      octokit.repos.createOrUpdateFileContents.mockRejectedValue(new Error('403'))
      const storage = newStorage()

      await expect(storage.write('k', new Uint8Array([1]))).rejects.toThrow(StorageError)
    })
  })

  describe('read', () => {
    it('decodes base64 file content to bytes', async () => {
      const bytes = new Uint8Array([9, 8, 7])
      octokit.repos.getContent.mockResolvedValue({
        data: { type: 'file', content: encodeBase64(bytes) },
      })
      const storage = newStorage()

      const result = await storage.read('some/key')
      expect(result).toEqual(bytes)
    })

    it('decodes base64 content that GitHub wraps with line breaks', async () => {
      const bytes = new Uint8Array([9, 8, 7])
      // GitHub wraps blob base64 at 60 columns; the reader must tolerate the embedded newlines.
      const wrapped = encodeBase64(bytes).replace(/(.{2})/, '$1\n')
      octokit.repos.getContent.mockResolvedValue({ data: { type: 'file', content: wrapped } })
      const storage = newStorage()

      expect(await storage.read('some/key')).toEqual(bytes)
    })

    it('returns null for a 404', async () => {
      octokit.repos.getContent.mockRejectedValue(notFound())
      const storage = newStorage()

      expect(await storage.read('missing')).toBeNull()
    })

    it('returns null when the path resolves to a directory', async () => {
      octokit.repos.getContent.mockResolvedValue({ data: [{ type: 'file' }] })
      const storage = newStorage()

      expect(await storage.read('a/dir')).toBeNull()
    })

    it('wraps non-404 errors in StorageError', async () => {
      octokit.repos.getContent.mockRejectedValue(new Error('500'))
      const storage = newStorage()

      await expect(storage.read('k')).rejects.toThrow(StorageError)
    })
  })

  describe('delete', () => {
    it('deletes the file at the resolved sha', async () => {
      octokit.repos.getContent.mockResolvedValue({ data: { type: 'file', sha: 'sha1' } })
      octokit.repos.deleteFile.mockResolvedValue({})
      const storage = newStorage({ prefix: 'p/' })

      await storage.delete('k')

      expect(octokit.repos.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'org', repo: 'mem', path: 'p/k', sha: 'sha1', branch: 'main' })
      )
    })

    it('is a no-op when the key does not exist', async () => {
      octokit.repos.getContent.mockRejectedValue(notFound())
      const storage = newStorage()

      await storage.delete('missing')
      expect(octokit.repos.deleteFile).not.toHaveBeenCalled()
    })

    it('wraps errors in StorageError', async () => {
      octokit.repos.getContent.mockResolvedValue({ data: { type: 'file', sha: 'sha1' } })
      octokit.repos.deleteFile.mockRejectedValue(new Error('409'))
      const storage = newStorage()

      await expect(storage.delete('k')).rejects.toThrow(StorageError)
    })
  })

  describe('list', () => {
    beforeEach(() => {
      octokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'commitsha' } } })
      octokit.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'treesha' } } })
    })

    it('returns blob paths under the prefix, sorted, with the store prefix stripped', async () => {
      octokit.git.getTree.mockResolvedValue({
        data: {
          truncated: false,
          tree: [
            { type: 'blob', path: 'p/knowledge/b.md' },
            { type: 'tree', path: 'p/knowledge' },
            { type: 'blob', path: 'p/knowledge/a.md' },
            { type: 'blob', path: 'p/other.md' },
          ],
        },
      })
      const storage = newStorage({ prefix: 'p/' })

      const keys = await storage.list('knowledge/')
      expect(keys).toEqual(['knowledge/a.md', 'knowledge/b.md'])
      expect(octokit.git.getTree).toHaveBeenCalledWith(
        expect.objectContaining({ tree_sha: 'treesha', recursive: 'true' })
      )
    })

    it('throws when the tree listing is truncated', async () => {
      // GitHub's tree API does not paginate, so a truncated response is an incomplete key set;
      // returning it would let consolidation plan over a partial view and orphan omitted files.
      octokit.git.getTree.mockResolvedValue({
        data: {
          truncated: true,
          tree: [{ type: 'blob', path: 'a.md' }],
        },
      })
      const storage = newStorage()

      await expect(storage.list('')).rejects.toThrow(StorageError)
      await expect(storage.list('')).rejects.toThrow(/truncated/)
    })

    it('returns an empty list when the branch does not exist', async () => {
      octokit.git.getRef.mockRejectedValue(notFound())
      const storage = newStorage()

      expect(await storage.list('')).toEqual([])
    })

    it('wraps non-404 errors in StorageError', async () => {
      octokit.git.getRef.mockRejectedValue(new Error('500'))
      const storage = newStorage()

      await expect(storage.list('')).rejects.toThrow(StorageError)
    })
  })

  describe('batch', () => {
    beforeEach(() => {
      octokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'basecommit' } } })
      octokit.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'basetree' } } })
      octokit.git.createBlob.mockResolvedValue({ data: { sha: 'blobsha' } })
      octokit.git.createTree.mockResolvedValue({ data: { sha: 'newtree' } })
      octokit.git.createCommit.mockResolvedValue({ data: { sha: 'newcommit' } })
      octokit.git.updateRef.mockResolvedValue({})
    })

    it('queues writes and deletes into a single commit', async () => {
      const storage = newStorage()
      storage.beginBatch()
      await storage.write('knowledge/a.md', encoder.encode('a'))
      await storage.delete('knowledge/old.md')
      // No per-op commit while batching
      expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled()
      expect(octokit.repos.deleteFile).not.toHaveBeenCalled()

      await storage.commitBatch('consolidate run')

      const tree = octokit.git.createTree.mock.calls[0]![0].tree
      expect(tree).toEqual([
        { path: 'knowledge/a.md', mode: '100644', type: 'blob', sha: 'blobsha' },
        { path: 'knowledge/old.md', mode: '100644', type: 'blob', sha: null },
      ])
      expect(octokit.git.createCommit).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'memory: consolidate run', tree: 'newtree', parents: ['basecommit'] })
      )
      expect(octokit.git.updateRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: 'heads/main', sha: 'newcommit' })
      )
    })

    it('lets a later mutation supersede an earlier one on the same key', async () => {
      const storage = newStorage()
      storage.beginBatch()
      await storage.write('k.md', encoder.encode('first'))
      await storage.delete('k.md')
      await storage.commitBatch('m')

      const tree = octokit.git.createTree.mock.calls[0]![0].tree
      expect(tree).toEqual([{ path: 'k.md', mode: '100644', type: 'blob', sha: null }])
    })

    it('does nothing but closes the batch when empty', async () => {
      const storage = newStorage()
      storage.beginBatch()
      await storage.commitBatch('empty')

      expect(octokit.git.createCommit).not.toHaveBeenCalled()
      await expect(storage.commitBatch('again')).rejects.toThrow(StorageError)
    })

    it('throws when commitBatch is called with no open batch', async () => {
      const storage = newStorage()
      await expect(storage.commitBatch('m')).rejects.toThrow(StorageError)
    })

    it('wraps commit failures in StorageError', async () => {
      octokit.git.updateRef.mockRejectedValue(new Error('non-fast-forward'))
      const storage = newStorage()
      storage.beginBatch()
      await storage.write('k.md', encoder.encode('x'))

      await expect(storage.commitBatch('m')).rejects.toThrow(StorageError)
    })
  })

  describe('key normalization', () => {
    it('rejects a key with a .. segment', async () => {
      const storage = newStorage()
      await expect(storage.read('../escape')).rejects.toThrow(StorageError)
    })
  })

  describe('namespace', () => {
    it('prefixes keys on the underlying client', async () => {
      octokit.repos.getContent.mockRejectedValue(notFound())
      octokit.repos.createOrUpdateFileContents.mockResolvedValue({})
      const storage = newStorage().namespace('sub')

      await storage.write('a.md', encoder.encode('x'))

      expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'sub/a.md' })
      )
    })

    it('prefixes the key on read', async () => {
      const bytes = new Uint8Array([1, 2, 3])
      octokit.repos.getContent.mockResolvedValue({ data: { type: 'file', content: encodeBase64(bytes) } })
      const storage = newStorage().namespace('sub')

      expect(await storage.read('a.md')).toEqual(bytes)
      expect(octokit.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: 'sub/a.md' }))
    })

    it('prefixes the key on delete', async () => {
      octokit.repos.getContent.mockResolvedValue({ data: { type: 'file', sha: 'sha1' } })
      octokit.repos.deleteFile.mockResolvedValue({})
      const storage = newStorage().namespace('sub')

      await storage.delete('a.md')

      expect(octokit.repos.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'sub/a.md' }))
    })

    it('scopes list to the namespace and strips its prefix', async () => {
      octokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'commitsha' } } })
      octokit.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'treesha' } } })
      octokit.git.getTree.mockResolvedValue({
        data: {
          truncated: false,
          tree: [
            { type: 'blob', path: 'sub/a.md' },
            { type: 'blob', path: 'other/b.md' },
          ],
        },
      })
      const storage = newStorage().namespace('sub')

      expect(await storage.list('')).toEqual(['a.md'])
    })
  })

  describe('config', () => {
    beforeEach(() => {
      octokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'commitsha' } } })
      octokit.git.getCommit.mockResolvedValue({ data: { tree: { sha: 'treesha' } } })
      octokit.git.getTree.mockResolvedValue({ data: { truncated: false, tree: [] } })
    })

    it('reads from and lists against a custom branch', async () => {
      octokit.repos.getContent.mockRejectedValue(notFound())
      const storage = newStorage({ branch: 'develop' })

      await storage.read('a.md')
      expect(octokit.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: 'develop' }))

      await storage.list('')
      expect(octokit.git.getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/develop' }))
    })

    it('commits a custom branch and applies a custom commit prefix', async () => {
      octokit.git.createBlob.mockResolvedValue({ data: { sha: 'blobsha' } })
      octokit.git.createTree.mockResolvedValue({ data: { sha: 'newtree' } })
      octokit.git.createCommit.mockResolvedValue({ data: { sha: 'newcommit' } })
      octokit.git.updateRef.mockResolvedValue({})
      const storage = newStorage({ branch: 'develop', commitPrefix: 'knowledge' })
      storage.beginBatch()
      await storage.write('a.md', encoder.encode('x'))
      await storage.commitBatch('run')

      expect(octokit.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ message: 'knowledge: run' }))
      expect(octokit.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/develop' }))
    })

    it('applies a custom commit prefix on a per-op write', async () => {
      octokit.repos.getContent.mockRejectedValue(notFound())
      octokit.repos.createOrUpdateFileContents.mockResolvedValue({})
      const storage = newStorage({ commitPrefix: 'knowledge' })

      await storage.write('a.md', encoder.encode('x'))

      expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/^knowledge: /) })
      )
    })
  })
})
