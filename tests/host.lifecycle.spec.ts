import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import UsageLedgerService from '../src/host/index.ts'

function table() {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => values.get(key),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value) }),
    delete: vi.fn(async (key: string) => { values.delete(key) }),
    entries: () => values.entries(),
  }
}

describe('UsageLedgerService lifecycle', () => {
  it('opens its domain, serves an empty snapshot, and closes the domain on disposal', async () => {
    const ctx = new Context()
    const sessions = { list: () => [], get: () => undefined }
    const persistence = { list: vi.fn(async () => []) }
    const settings = { register: vi.fn(() => () => {}) }
    const sessionTable = table()
    const callTable = table()
    const close = vi.fn(async () => {})
    const open = vi.fn(async () => ({
      table: (name: string) => name === 'sessions' ? sessionTable : callTable,
      close,
    }))
    ctx.provide('storageDomain', { open } as never)
    ctx.provide('sessions', sessions as never)
    ctx.provide('sessionPersistence', persistence as never)
    ctx.provide('settings', settings as never)

    const fiber = ctx.plugin(UsageLedgerService)
    await fiber.await()
    const snapshot = await ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' })

    expect(open).toHaveBeenCalledOnce()
    expect(persistence.list).toHaveBeenCalledOnce()
    expect(snapshot).toMatchObject({ days: 1, timeZone: 'UTC', models: [], events: [] })
    expect(snapshot.daily).toHaveLength(1)
    await fiber.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it('releases each cold session before inspecting the next history log', async () => {
    const first = Session.create(SessionId('usage-ledger-history-first'), undefined, {
      version: 0,
      id: SessionId('usage-ledger-history-first'),
      createdAt: Date.UTC(2026, 1, 1),
      cwd: '/history',
    })
    const second = Session.create(SessionId('usage-ledger-history-second'), undefined, {
      version: 0,
      id: SessionId('usage-ledger-history-second'),
      createdAt: Date.UTC(2026, 1, 2),
      cwd: '/history',
    })
    let releaseFirst!: () => void
    const firstMayLoad = new Promise<void>((resolve) => { releaseFirst = resolve })
    const state: { ctx?: Context } = {}
    let retainedBeforeSecondInspect = -1
    const persistence = {
      list: vi.fn(async () => [first.header, second.header]),
      inspect: vi.fn(async (id: SessionId) => {
        if (id === first.id) {
          await firstMayLoad
          return { meta: first.header, events: first.events }
        }
        const ctx = state.ctx
        if (ctx === undefined) throw new Error('usage ledger test did not initialize before history inspection')
        retainedBeforeSecondInspect = (ctx.usageLedger as unknown as {
          coldSessions: ReadonlySet<Session>
        }).coldSessions.size
        return { meta: second.header, events: second.events }
      }),
    }
    const ctx = new Context()
    const sessionTable = table()
    const callTable = table()
    ctx.provide('storageDomain', {
      open: async () => ({
        table: (name: string) => name === 'sessions' ? sessionTable : callTable,
        close: async () => {},
      }),
    } as never)
    ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
    ctx.provide('sessionPersistence', persistence as never)

    const fiber = ctx.plugin(UsageLedgerService)
    await fiber.await()
    state.ctx = ctx
    releaseFirst()
    await ctx.usageLedger.snapshot({ workspace: '/history', days: 366, timeZone: 'UTC' })

    expect(retainedBeforeSecondInspect).toBe(0)
    await fiber.dispose()
  })
})
