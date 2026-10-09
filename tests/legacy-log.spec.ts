import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeStoredRows, readLegacyBatches, storedLogPath, zstdFrameEnd } from '../src/legacy-log.ts'

const rows = [
  { type: 'request/context', seq: 0, time: 1, data: { provider: 'test', model: 'model' } },
  { type: 'text-chunks', seq: 1, time: 2, data: { chunks: ['a'] } },
  { type: 'step/start', seq: 2, time: 3, data: { turn: 0, step: 0 } },
  { type: 'assistant/message', seq: 3, time: 4, data: { turn: 0, step: 0, usage: { inputTokens: 5, outputTokens: 2 } } },
]

// The stored writer flushes several records per frame and may flush inside a record.
function concatenatedFrames(): { bytes: Buffer; firstFrameBytes: number } {
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  const cut = text.lastIndexOf('"time"', text.length - 2)
  const first = zstdCompressSync(text.slice(0, cut))
  const second = zstdCompressSync(text.slice(cut))
  return { bytes: Buffer.concat([first, second]), firstFrameBytes: first.length }
}

describe('Legacy stored generation reader', () => {
  it('finds every frame boundary in a concatenated log', () => {
    const { bytes, firstFrameBytes } = concatenatedFrames()
    expect(zstdFrameEnd(bytes, 0)).toBe(firstFrameBytes)
    expect(zstdFrameEnd(bytes, firstFrameBytes)).toBe(bytes.length)
  })

  it('refuses a truncated frame instead of reading past it', () => {
    const { bytes } = concatenatedFrames()
    expect(zstdFrameEnd(bytes.subarray(0, 12), 0)).toBeUndefined()
  })

  it('decodes a record that spans two frames', () => {
    const { bytes } = concatenatedFrames()
    expect([...decodeStoredRows(bytes)].map(row => [row.type, row.seq])).toEqual([
      ['request/context', 0],
      ['text-chunks', 1],
      ['step/start', 2],
      ['assistant/message', 3],
    ])
  })

  it('streams only reducible rows from the saved cursor in bounded batches', async () => {
    const { bytes } = concatenatedFrames()
    const root = await mkdtemp(join(tmpdir(), 'legacy-log-'))
    const path = join(root, 'session.jsonl.zstd')
    try {
      await writeFile(path, bytes)
      const batches = []
      for await (const batch of readLegacyBatches(path, { session: { id: 'session' }, fromSeq: 2, batchEvents: 1 })) batches.push(batch)
      expect(batches).toHaveLength(2)
      expect(batches[0]).toMatchObject({ meta: { id: 'session' }, inheritedEventCount: 0 })
      expect(batches.map(batch => batch.events.map(event => event.type))).toEqual([['step/start'], ['assistant/message']])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reads the stored path a refusal reports and rejects anything else', () => {
    expect(storedLogPath({ location: { path: '/tmp/session.jsonl.zstd' } })).toBe('/tmp/session.jsonl.zstd')
    expect(storedLogPath({ location: '/tmp/plain.jsonl.zstd' })).toBe('/tmp/plain.jsonl.zstd')
    expect(storedLogPath({ location: { path: 'relative/session.jsonl.zstd' } })).toBeUndefined()
    expect(storedLogPath({ location: { reason: 'no path' } })).toBeUndefined()
    expect(storedLogPath(undefined)).toBeUndefined()
  })
})
