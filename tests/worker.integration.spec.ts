import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { fileURLToPath } from 'node:url'
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

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20))
  if (!predicate()) throw new Error('worker integration condition timed out')
}

describe('Usage Ledger worker integration', () => {
  it('backfills only recent sessions through a provider-owned reader', async () => {
    const now = Date.now()
    const recent = SessionId('worker-recent')
    const old = SessionId('worker-old')
    const eventTime = now - 1000
    const events = [
      { type: 'request/context', seq: 0, time: eventTime, data: { provider: 'deepseek', model: 'chat' } },
      { type: 'step/start', seq: 1, time: eventTime + 1, data: { turn: 0, step: 0 } },
      { type: 'assistant/chunk', seq: 2, time: eventTime + 2, data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } } } },
      { type: 'assistant/message', seq: 3, time: eventTime + 3, data: { turn: 0, step: 0, usage: { inputTokens: 12, outputTokens: 8 } } },
    ]
    const sessionTable = table()
    const callTable = table()
    const ctx = new Context()
    ctx.provide('storageDomain', { open: async () => ({
      table: (name: string) => name === 'sessions' ? sessionTable : callTable,
      close: async () => {},
    }) } as never)
    ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [
        { header: { version: 0, id: old, createdAt: now - 31 * 24 * 60 * 60 * 1000, cwd: '/old', isSeeded: false } },
        { header: { version: 0, id: recent, createdAt: now, cwd: '/recent', isSeeded: false } },
      ],
      backgroundReaderSpec: () => ({
        protocolVersion: 1,
        workerModule: fileURLToPath(new URL('./fixtures/worker-reader.mjs', import.meta.url)),
        options: { events: JSON.stringify(events) },
      }),
    } as never)
    ctx.provide('settings', { register: vi.fn(() => () => {}) } as never)

    const fiber = ctx.plugin(UsageLedgerService, { backfillDays: 30 })
    await fiber.await()
    await waitFor(() => callTable.entries().next().value !== undefined)
    const rows = [...callTable.entries()].map(([, row]) => row as { sessionId: string })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sessionId).toBe(recent)
    expect(ctx.usageLedger.statusSnapshot()).toMatchObject({ state: 'idle', totalSessions: 1, processedSessions: 1 })
    await fiber.dispose()
  })
})
