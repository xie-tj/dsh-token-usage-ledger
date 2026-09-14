import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type {} from '../lib/types/host/index.js'
// The packed root entry intentionally has no sibling declaration; typecheck:host
// validates its source and this suite exercises the built runtime.
// @ts-expect-error built bundle runtime entry
import UsageLedgerService from '../lib/index.js'

async function setup(config: ConstructorParameters<typeof UsageLedgerService>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-host-'))
  const id = SessionId('usage-ledger-live-' + Math.random())
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: Date.now(),
    cwd: '/live',
    isSeeded: false,
  })
  const ctx = new Context()
  ctx.provide('sessions', { list: () => [session], get: (id: SessionId) => id === session.id ? session : undefined } as never)
  const persistence: {
    list: () => Promise<unknown>
    backgroundReaderSpec?: () => unknown
  } = { list: vi.fn(async () => []) }
  ctx.provide('sessionPersistence', persistence as never)
  ctx.provide('settings', { register: vi.fn(() => () => {}) } as never)
  const fiber = ctx.plugin(UsageLedgerService, {
    databasePath: join(root, 'usage-ledger-v4.sqlite'),
    backfillPowerMode: 'always',
    ...config,
  })
  return {
    ctx,
    fiber,
    session,
    persistence,
    dispose: async () => {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20))
  if (!await predicate()) throw new Error('test condition was not observed before timeout')
}

describe('UsageLedgerService lifecycle', () => {
  it('opens a bounded private SQLite ledger and keeps disabled mode immediately idle', async () => {
    const test = await setup({ backfillMode: 'off' })
    try {
      await test.fiber.await()
      const snapshot = await test.ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' })
      expect(snapshot.events).toEqual([])
      expect(snapshot.eventsTruncated).toBe(false)
      expect(test.ctx.usageLedger.statusSnapshot()).toMatchObject({ state: 'paused', backfillDays: 30, backfillScope: 'all' })
    } finally {
      await test.dispose()
    }
  })

  it('does not register Usage work on the awaited session/flush barrier', async () => {
    let releaseListing!: () => void
    const listing = new Promise<void>(resolve => { releaseListing = resolve })
    const test = await setup({ backfillMode: 'process' })
    test.persistence.backgroundReaderSpec = () => ({
      protocolVersion: 1,
      workerModule: fileURLToPath(new URL('./fixtures/worker-reader.mjs', import.meta.url)),
      options: { events: '[]' },
    })
    test.persistence.list = async () => { await listing; return [] }
    try {
      await test.fiber.await()
      const result = await Promise.race([
        test.ctx.parallel('session/flush', test.session).then(() => 'resolved'),
        new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 100)),
      ])
      expect(result).toBe('resolved')
      const snapshot = await Promise.race([
        test.ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' }),
        new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 100)),
      ])
      expect(snapshot).not.toBe('timeout')
      releaseListing()
    } finally {
      releaseListing()
      await test.dispose()
    }
  })

  it('folds compact live usage in a child process without retaining assistant content', async () => {
    const test = await setup({ backfillMode: 'process' })
    try {
      await test.fiber.await()
      const now = Date.now()
      test.ctx.emit('session/event', test.session, {
        type: 'assistant/chunk',
        seq: 0,
        time: now,
        data: {
          turn: 0,
          step: 0,
          chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 } },
        },
      } as never)
      await waitFor(async () => {
        const snapshot = await test.ctx.usageLedger.snapshot({ workspace: '/live', days: 2, timeZone: 'UTC' })
        return snapshot.events.length === 1
      })
      const snapshot = await test.ctx.usageLedger.snapshot({ workspace: '/live', days: 2, timeZone: 'UTC' })
      expect(snapshot.events).toMatchObject([{
        inputTokens: 7,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      }])
      const all = await test.ctx.usageLedger.snapshot({ all: true, timeZone: 'UTC' })
      expect(all).toMatchObject({ all: true, days: 1 })
      const exported = await test.ctx.usageLedger.exportCsv({ all: true, timeZone: 'UTC' })
      expect(exported.rows).toBe(1)
      expect(await readFile(exported.path, 'utf8')).toContain('inputTokens')
    } finally {
      await test.dispose()
    }
  })

  it('keeps live mode while pausing unsupported historical persistence', async () => {
    const test = await setup({ backfillMode: 'process' })
    try {
      await test.fiber.await()
      await waitFor(() => test.ctx.usageLedger.statusSnapshot().state === 'paused')
      expect(test.ctx.usageLedger.statusSnapshot().lastError).toContain('backgroundReaderSpec')
      const snapshot = await test.ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' })
      expect(snapshot.events).toEqual([])
    } finally {
      await test.dispose()
    }
  })
})
