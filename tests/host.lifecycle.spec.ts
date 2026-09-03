import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import UsageLedgerService from '../src/host/index.ts'
import type { UsageSessionEvent } from '../src/host/event-types.ts'

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

  it('backfills usage-bearing events from persisted cold sessions into an empty ledger', async () => {
    const sessionId = SessionId('usage-ledger-history-usage')
    const createdAt = Date.UTC(2026, 1, 3)
    const eventTime = Date.UTC(2026, 1, 3, 12)
    const historical = Session.create(sessionId, [
      {
        type: 'request/context',
        seq: 0,
        time: eventTime,
        data: { provider: 'deepseek', model: 'deepseek-chat' },
      },
      {
        type: 'assistant/chunk',
        seq: 1,
        time: eventTime + 1,
        data: {
          turn: 0,
          step: 0,
          chunk: { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } },
        },
      },
    ] as never, {
      version: 0,
      id: sessionId,
      createdAt,
      cwd: '/history',
      isSeeded: false,
    })
    const persistence = {
      list: vi.fn(async () => [{ header: historical.header, revision: 'history' }]),
      open: vi.fn(async () => ({
        id: historical.id,
        header: historical.header,
        inheritedEventCount: 0,
        read: vi.fn(async (offset = 0, length = Number.MAX_SAFE_INTEGER) => historical.snapshotEvents().slice(offset, offset + length)),
        close: vi.fn(async () => {}),
      })),
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
    const snapshot = await ctx.usageLedger.snapshot({ workspace: '/history', days: 366, timeZone: 'UTC' })

    expect(snapshot.events).toMatchObject([{
      workspace: '/history',
      provider: 'deepseek',
      model: 'deepseek-chat',
      outcome: 'started',
      inputTokens: 11,
      outputTokens: 7,
    }])
    expect(snapshot.models).toMatchObject([{
      workspace: '/history',
      provider: 'deepseek',
      model: 'deepseek-chat',
      requests: 1,
      meteredRequests: 1,
    }])
    expect(sessionTable.put).toHaveBeenCalled()
    await fiber.dispose()
  })

  it('keeps usage on the failed dispatch when a retry succeeds', async () => {
    const sessionId = SessionId('usage-ledger-retry-usage')
    const eventTime = Date.UTC(2026, 1, 4, 12)
    const retryId = 'retry-usage-bearing'
    const historical = Session.create(sessionId, [
      {
        type: 'request/context',
        seq: 0,
        time: eventTime,
        data: { provider: 'deepseek', model: 'deepseek-chat' },
      },
      {
        type: 'assistant/chunk',
        seq: 1,
        time: eventTime + 1,
        data: {
          turn: 0,
          step: 0,
          chunk: { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } },
        },
      },
      {
        type: 'llm/retry',
        seq: 2,
        time: eventTime + 2,
        data: {
          retryId,
          turn: 0,
          step: 0,
          provider: 'deepseek',
          mode: 'always',
          policyKey: 'test',
          retry: 1,
          delayMs: 10,
          failure: { name: 'TestError', message: 'failed' },
        },
      },
      {
        type: 'llm/retry-started',
        seq: 3,
        time: eventTime + 3,
        data: { retryId, turn: 0, step: 0, retry: 1 },
      },
      {
        type: 'assistant/chunk',
        seq: 4,
        time: eventTime + 4,
        data: {
          turn: 0,
          step: 0,
          chunk: { type: 'usage', usage: { inputTokens: 13, outputTokens: 9 } },
        },
      },
      {
        type: 'llm/retry',
        seq: 5,
        time: eventTime + 5,
        data: {
          retryId,
          turn: 0,
          step: 0,
          provider: 'deepseek',
          mode: 'always',
          policyKey: 'test',
          retry: 2,
          delayMs: 20,
          failure: { name: 'TestError', message: 'failed again' },
        },
      },
      {
        type: 'llm/retry-started',
        seq: 6,
        time: eventTime + 6,
        data: { retryId, turn: 0, step: 0, retry: 2 },
      },
      {
        type: 'assistant/chunk',
        seq: 7,
        time: eventTime + 7,
        data: {
          turn: 0,
          step: 0,
          chunk: { type: 'usage', usage: { inputTokens: 17, outputTokens: 10 } },
        },
      },
      {
        type: 'assistant/message',
        seq: 8,
        time: eventTime + 8,
        surfaceOp: 'append',
        data: {
          turn: 0,
          step: 0,
          message: {
            id: 'message-1',
            role: 'assistant',
            content: [],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
          usage: { inputTokens: 17, outputTokens: 10 },
        },
      },
    ] as never, {
      version: 0,
      id: sessionId,
      createdAt: eventTime,
      cwd: '/retry',
      isSeeded: false,
    })
    const persistence = {
      list: vi.fn(async () => [{ header: historical.header, revision: 'history' }]),
      open: vi.fn(async () => ({
        id: historical.id,
        header: historical.header,
        inheritedEventCount: 0,
        read: vi.fn(async (offset = 0, length = Number.MAX_SAFE_INTEGER) => historical.snapshotEvents().slice(offset, offset + length)),
        close: vi.fn(async () => {}),
      })),
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
    const snapshot = await ctx.usageLedger.snapshot({ workspace: '/retry', days: 366, timeZone: 'UTC' })

    expect(snapshot.events).toHaveLength(3)
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'failure', retried: true, inputTokens: 11, outputTokens: 7 }),
      expect.objectContaining({ outcome: 'failure', retried: true, inputTokens: 13, outputTokens: 9 }),
      expect.objectContaining({ outcome: 'success', retried: false, inputTokens: 17, outputTokens: 10 }),
    ]))
    await fiber.dispose()
  })
  it('does not count a scheduled retry until its provider dispatch starts', async () => {
    const eventTime = Date.UTC(2026, 1, 4, 13)
    const retryId = 'retry-without-active-attempt'
    const retry = {
      type: 'llm/retry',
      seq: 0,
      time: eventTime,
      data: {
        retryId,
        turn: 0,
        step: 0,
        provider: 'deepseek',
        mode: 'always',
        policyKey: 'test',
        retry: 1,
        delayMs: 10,
        failure: { name: 'TestError', message: 'failed' },
      },
    } as const
    const scenarios = [
      { id: 'usage-ledger-retry-scheduled', events: [retry], expectedCalls: 0 },
      {
        id: 'usage-ledger-retry-started',
        events: [retry, {
          type: 'llm/retry-started',
          seq: 1,
          time: eventTime + 1,
          data: { retryId, turn: 0, step: 0, retry: 1 },
        } as const],
        expectedCalls: 1,
      },
    ]

    for (const scenario of scenarios) {
      const sessionId = SessionId(scenario.id)
      const historical = Session.create(sessionId, scenario.events as never, {
        version: 0,
        id: sessionId,
        createdAt: eventTime,
        cwd: '/retry-scheduled',
        isSeeded: false,
      })
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
      ctx.provide('sessionPersistence', {
        list: async () => [{ header: historical.header, revision: 'history' }],
        open: async () => ({
          id: historical.id,
          header: historical.header,
          inheritedEventCount: 0,
          read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) => historical.snapshotEvents().slice(offset, offset + length),
          close: async () => {},
        }),
      } as never)

      const fiber = ctx.plugin(UsageLedgerService)
      await fiber.await()
      const snapshot = await ctx.usageLedger.snapshot({ workspace: '/retry-scheduled', days: 366, timeZone: 'UTC' })

      expect(snapshot.events).toHaveLength(scenario.expectedCalls)
      if (scenario.expectedCalls === 1) {
        expect(snapshot.events[0]).toMatchObject({ outcome: 'started', retried: false })
      }
      await fiber.dispose()
    }
  })

  it('adapts the published inspect face and excludes inherited seeded usage', async () => {
    const sessionId = SessionId('usage-ledger-seeded-child')
    const eventTime = Date.UTC(2026, 1, 5, 12)
    const events = [
      {
        type: 'request/context', seq: 0, time: eventTime,
        data: { provider: 'deepseek', model: 'deepseek-chat' },
      },
      {
        type: 'assistant/chunk', seq: 1, time: eventTime + 1,
        data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 99, outputTokens: 99 } } },
      },
      {
        type: 'request/context', seq: 2, time: eventTime + 2,
        data: { provider: 'deepseek', model: 'deepseek-reasoner' },
      },
      {
        type: 'assistant/chunk', seq: 3, time: eventTime + 3,
        data: { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } } },
      },
    ] as UsageSessionEvent[]
    const header = {
      version: 0, id: sessionId, createdAt: eventTime, cwd: '/seeded',
      parentSession: SessionId('usage-ledger-parent'), isSeeded: true,
    }
    const inspect = vi.fn(async () => ({ meta: header, inheritedEventCount: 2, events }))
    const read = vi.fn(function (this: { events: UsageSessionEvent[] }, offset = 0, length = 256) {
      return Promise.resolve(this.events.slice(offset, offset + length))
    })
    const close = vi.fn(function (this: { closed: boolean }) {
      this.closed = true
      return Promise.resolve()
    })
    const openHandle = { header, inheritedEventCount: 2, events, closed: false, read, close }
    const faces = [
      { list: vi.fn(async () => [{ header, revision: 'seeded' }]), open: vi.fn(async () => openHandle) },
      { list: vi.fn(async () => [header]), inspect },
    ]
    const snapshots = []
    for (const persistence of faces) {
      const ctx = new Context()
      const sessionTable = table()
      const callTable = table()
      ctx.provide('storageDomain', { open: async () => ({
        table: (name: string) => name === 'sessions' ? sessionTable : callTable,
        close: async () => {},
      }) } as never)
      ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
      ctx.provide('sessionPersistence', persistence as never)

      const fiber = ctx.plugin(UsageLedgerService)
      await fiber.await()
      snapshots.push(await ctx.usageLedger.snapshot({ workspace: '/seeded', days: 366, timeZone: 'UTC' }))
      await fiber.dispose()
    }

    expect(inspect).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith(0, 256)
    expect(close).toHaveBeenCalledOnce()
    expect(openHandle.closed).toBe(true)
    const comparable = snapshots.map(({ updatedAt: _, ...snapshot }) => snapshot)
    expect(comparable[0]).toEqual(comparable[1])
    expect(comparable[0].models).toMatchObject([{
      provider: 'deepseek', model: 'deepseek-reasoner', requests: 1,
      inputTokens: 5, outputTokens: 3, meteredRequests: 1,
    }])
    expect(comparable[0].events).toHaveLength(1)
  })

  it('resets a stale cursor when a session id belongs to a new lifecycle', async () => {
    const sessionId = SessionId('usage-ledger-reused-session-id')
    const eventTime = Date.UTC(2026, 1, 5, 14)
    const historical = Session.create(sessionId, [
      {
        type: 'request/context',
        seq: 0,
        time: eventTime,
        data: { provider: 'deepseek', model: 'deepseek-chat' },
      },
      {
        type: 'assistant/chunk',
        seq: 1,
        time: eventTime + 1,
        data: {
          turn: 0,
          step: 0,
          chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 4 } },
        },
      },
    ] as never, {
      version: 0,
      id: sessionId,
      createdAt: eventTime,
      cwd: '/reused-session',
      isSeeded: false,
    })
    const sessionTable = table()
    const callTable = table()
    await sessionTable.put(sessionId, {
      createdAt: eventTime - 1,
      workspace: '/old-lifecycle',
      observedSeq: 100,
      activeAttempts: {},
      successfulAttempts: {},
    })
    const ctx = new Context()
    ctx.provide('storageDomain', { open: async () => ({
      table: (name: string) => name === 'sessions' ? sessionTable : callTable,
      close: async () => {},
    }) } as never)
    ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [{ header: historical.header, revision: 'new-lifecycle' }],
      open: async () => ({
        header: historical.header,
        inheritedEventCount: 0,
        read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) => historical.snapshotEvents().slice(offset, offset + length),
        close: async () => {},
      }),
    } as never)

    const fiber = ctx.plugin(UsageLedgerService)
    await fiber.await()
    const snapshot = await ctx.usageLedger.snapshot({ workspace: '/reused-session', days: 366, timeZone: 'UTC' })

    expect(snapshot.events).toMatchObject([{
      provider: 'deepseek', model: 'deepseek-chat', inputTokens: 7, outputTokens: 4,
    }])
    await fiber.dispose()
  })

  it('releases each cold session before inspecting the next history log', async () => {
    const first = Session.create(SessionId('usage-ledger-history-first'), undefined, {
      version: 0,
      id: SessionId('usage-ledger-history-first'),
      createdAt: Date.UTC(2026, 1, 1),
      cwd: '/history',
      isSeeded: false,
    })
    const second = Session.create(SessionId('usage-ledger-history-second'), undefined, {
      version: 0,
      id: SessionId('usage-ledger-history-second'),
      createdAt: Date.UTC(2026, 1, 2),
      cwd: '/history',
      isSeeded: false,
    })
    let releaseFirst!: () => void
    const firstMayLoad = new Promise<void>((resolve) => { releaseFirst = resolve })
    const state: { ctx?: Context } = {}
    let retainedBeforeSecondInspect = -1
    const persistence = {
      list: vi.fn(async () => [
        { header: first.header, revision: 'first' },
        { header: second.header, revision: 'second' },
      ]),
      open: vi.fn(async (id: SessionId) => {
        if (id === first.id) await firstMayLoad
        const session = id === first.id ? first : second
        if (id === second.id) {
          const ctx = state.ctx
          if (ctx === undefined) throw new Error('usage ledger test did not initialize before history inspection')
          retainedBeforeSecondInspect = (ctx.usageLedger as unknown as {
            coldSessions: ReadonlySet<Session>
          }).coldSessions.size
        }
        return {
          id,
          header: session.header,
          inheritedEventCount: 0,
          read: vi.fn(async (offset = 0, length = Number.MAX_SAFE_INTEGER) => session.snapshotEvents().slice(offset, offset + length)),
          close: vi.fn(async () => {}),
        }
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

  it('counts dispatches before chunks and closes them from official turn endings', async () => {
    const sessionId = SessionId('usage-ledger-terminal-accounting')
    const eventTime = Date.UTC(2026, 1, 6, 12)
    const historical = Session.create(sessionId, [
      { type: 'step/start', seq: 0, time: eventTime, data: { turn: 0, step: 0 } },
      { type: 'turn/end', seq: 1, time: eventTime + 1, data: { turn: 0, reason: { kind: 'error', error: { name: 'TestError', message: 'failed' } } } },
      { type: 'step/start', seq: 2, time: eventTime + 2, data: { turn: 1, step: 0 } },
      { type: 'turn/end', seq: 3, time: eventTime + 3, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ] as never, { version: 0, id: sessionId, createdAt: eventTime, cwd: '/terminal', isSeeded: false })
    const persistence = {
      list: vi.fn(async () => [{ header: historical.header }]),
      open: vi.fn(async () => ({ id: historical.id, header: historical.header, inheritedEventCount: 0,
        read: vi.fn(async (offset = 0, length = Number.MAX_SAFE_INTEGER) => historical.snapshotEvents().slice(offset, offset + length)),
        close: vi.fn(async () => {}) })),
    }
    const ctx = new Context()
    const sessionTable = table()
    const callTable = table()
    ctx.provide('storageDomain', { open: async () => ({ table: (name: string) => name === 'sessions' ? sessionTable : callTable, close: async () => {} }) } as never)
    ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
    ctx.provide('sessionPersistence', persistence as never)
    const fiber = ctx.plugin(UsageLedgerService)
    await fiber.await()
    const snapshot = await ctx.usageLedger.snapshot({ workspace: '/terminal', days: 366, timeZone: 'UTC' })
    expect(snapshot.models).toMatchObject([{ requests: 2, failedRequests: 2, unmeteredRequests: 2 }])
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'failure' }), expect.objectContaining({ outcome: 'aborted' }),
    ]))
    await fiber.dispose()
  })

})
