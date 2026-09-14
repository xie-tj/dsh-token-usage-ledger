import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type {} from '../lib/types/host/index.js'
// The packed root entry intentionally has no sibling declaration; typecheck:host
// validates its source and this suite exercises the built runtime.
// @ts-expect-error built bundle runtime entry
import UsageLedgerService from '../lib/index.js'

function table() {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => values.get(key),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value) }),
    delete: vi.fn(async (key: string) => { values.delete(key) }),
    entries: () => values.entries(),
  }
}

function setup(config: ConstructorParameters<typeof UsageLedgerService>[1] = {}) {
  const sessionTable = table()
  const callTable = table()
  const close = vi.fn(async () => {})
  const id = SessionId(`usage-ledger-live-${Math.random()}`)
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: Date.now(),
    cwd: '/live',
    isSeeded: false,
  })
  const ctx = new Context()
  ctx.provide('storageDomain', {
    open: async () => ({
      table: (name: string) => name === 'sessions' ? sessionTable : callTable,
      close,
    }),
  } as never)
  ctx.provide('sessions', { list: () => [session], get: (id: SessionId) => id === session.id ? session : undefined } as never)
  const persistence: { list: () => Promise<unknown> } = { list: vi.fn(async () => []) }
  ctx.provide('sessionPersistence', persistence as never)
  ctx.provide('settings', { register: vi.fn(() => () => {}) } as never)
  const fiber = ctx.plugin(UsageLedgerService, config)
  return { ctx, fiber, session, sessionTable, callTable, close, persistence }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20))
  if (!predicate()) throw new Error('test condition was not observed before timeout')
}

describe('UsageLedgerService lifecycle', () => {
  it('opens SQLite-backed tables and keeps disabled mode immediately idle', async () => {
    const test = setup({ backfillMode: 'off' })
    await test.fiber.await()
    const snapshot = await test.ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' })
    expect(snapshot.events).toEqual([])
    expect(test.ctx.usageLedger.statusSnapshot()).toMatchObject({ state: 'paused', backfillDays: 30 })
    await test.fiber.dispose()
    expect(test.close).toHaveBeenCalledOnce()
  })

  it('does not register Usage work on the awaited session/flush barrier', async () => {
    let releaseListing!: () => void
    const listing = new Promise<void>(resolve => { releaseListing = resolve })
    const test = setup({ backfillMode: 'process' })
    test.persistence.list = async () => { await listing; return [] }
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
    await test.fiber.dispose()
  })

  it('folds compact live usage in a child process without retaining assistant content', async () => {
    const test = setup({ backfillMode: 'process' })
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
    await waitFor(() => test.callTable.entries().next().value !== undefined)
    const snapshot = await test.ctx.usageLedger.snapshot({ workspace: '/live', days: 2, timeZone: 'UTC' })
    expect(snapshot.events).toMatchObject([{
      inputTokens: 7,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    }])
    await test.fiber.dispose()
  })

  it('keeps live mode while pausing unsupported historical persistence', async () => {
    const test = setup({ backfillMode: 'process' })
    test.persistence.list = vi.fn(async () => [{
      version: 0,
      id: SessionId('old-history'),
      createdAt: Date.now(),
      cwd: '/history',
      isSeeded: false,
    }])
    await test.fiber.await()
    await waitFor(() => test.ctx.usageLedger.statusSnapshot().state === 'paused')
    expect(test.ctx.usageLedger.statusSnapshot().lastError).toContain('backgroundReaderSpec')
    const snapshot = await test.ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' })
    expect(snapshot.events).toEqual([])
    await test.fiber.dispose()
  })
})
