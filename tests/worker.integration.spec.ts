import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type {} from '../lib/types/host/index.js'
// @ts-expect-error built bundle runtime entry
import UsageLedgerService from '../lib/index.js'

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20))
  if (!await predicate()) throw new Error('worker integration condition timed out')
}

describe('Usage Ledger worker integration', () => {
  it('uses a provider-owned reader to backfill the recent priority window into direct SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-worker-'))
    const now = Date.now()
    const recent = SessionId('worker-recent')
    const old = SessionId('worker-old')
    const eventTime = now - 1_000
    const events = [
      { type: 'request/context', seq: 0, time: eventTime, data: { provider: 'deepseek', model: 'chat' } },
      { type: 'step/start', seq: 1, time: eventTime + 1, data: { turn: 0, step: 0 } },
      { type: 'assistant/chunk', seq: 2, time: eventTime + 2, data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } } } },
      { type: 'assistant/message', seq: 3, time: eventTime + 3, data: { turn: 0, step: 0, usage: { inputTokens: 12, outputTokens: 8 } } },
    ]
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [
        { header: { version: 0, id: old, createdAt: now - 31 * 24 * 60 * 60 * 1_000, cwd: '/old', isSeeded: false } },
        { header: { version: 0, id: recent, createdAt: now, cwd: '/recent', isSeeded: false } },
      ],
      backgroundReaderSpec: () => ({
        protocolVersion: 1,
        workerModule: fileURLToPath(new URL('./fixtures/worker-reader.mjs', import.meta.url)),
        options: { events: JSON.stringify(events) },
      }),
    } as never)
    ctx.provide('settings', { register: vi.fn(() => () => {}) } as never)
    const fiber = ctx.plugin(UsageLedgerService, {
      databasePath: join(root, 'usage-ledger-v4.sqlite'),
      backfillScope: 'recent',
      backfillPowerMode: 'always',
      backfillPauseRssMiB: 1_048_576,
    })
    try {
      await fiber.await()
      await waitFor(async () => {
        const snapshot = await ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' })
        const status = ctx.usageLedger.statusSnapshot()
        return snapshot.events.length === 1 && status.state === 'idle' && status.processedSessions === 1
      })
      const snapshot = await ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' })
      expect(snapshot.events).toHaveLength(1)
      expect(snapshot.models).toMatchObject([{ provider: 'deepseek', model: 'chat', requests: 1 }])
      expect(ctx.usageLedger.statusSnapshot()).toMatchObject({ state: 'idle', totalSessions: 1, processedSessions: 1 })
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('streams all retained history in recent-first passes without calling persistence.list()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-streaming-'))
    const now = Date.now()
    const recent = SessionId('streaming-recent')
    const old = SessionId('streaming-old')
    const events = [
      { type: 'request/context', seq: 0, time: now, data: { provider: 'deepseek', model: 'chat' } },
      { type: 'assistant/message', seq: 1, time: now + 1, data: { turn: 0, step: 0, usage: { inputTokens: 2, outputTokens: 1 } } },
    ]
    const list = vi.fn(async () => {
      throw new Error('streaming lister must avoid persistence.list()')
    })
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list,
      backgroundReaderSpec: () => ({
        protocolVersion: 1,
        supportsSessionListing: true,
        workerModule: fileURLToPath(new URL('./fixtures/worker-reader.mjs', import.meta.url)),
        options: {
          events: JSON.stringify(events),
          sessions: JSON.stringify([
            { id: recent, createdAt: now, cwd: '/recent' },
            { id: old, createdAt: now - 365 * 24 * 60 * 60 * 1_000, cwd: '/old' },
          ]),
        },
      }),
    } as never)
    ctx.provide('settings', { register: vi.fn(() => () => {}) } as never)
    const fiber = ctx.plugin(UsageLedgerService, {
      databasePath: join(root, 'usage-ledger-v4.sqlite'),
      backfillScope: 'all',
      backfillPowerMode: 'always',
      backfillPauseRssMiB: 1_048_576,
    })
    try {
      await fiber.await()
      await waitFor(async () => {
        const snapshot = await ctx.usageLedger.snapshot({ days: 366, timeZone: 'UTC' })
        const status = ctx.usageLedger.statusSnapshot()
        return snapshot.events.length === 2 && status.state === 'idle' && status.processedSessions === 2
      })
      const snapshot = await ctx.usageLedger.snapshot({ days: 366, timeZone: 'UTC' })
      expect(snapshot.events).toHaveLength(2)
      expect(snapshot.events.map(event => event.workspace).sort()).toEqual(['/old', '/recent'])
      expect(ctx.usageLedger.statusSnapshot()).toMatchObject({ state: 'idle', totalSessions: 2, processedSessions: 2 })
      expect(list).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
