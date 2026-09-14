import { describe, expect, it } from 'vitest'
import { UsageLedgerReducer, type LedgerSession } from '../src/host/reducer.ts'
import type { UsageSessionEvent } from '../src/host/event-types.ts'

const session: LedgerSession = {
  id: 'reducer-session',
  createdAt: Date.UTC(2026, 8, 10),
  cwd: '/reducer',
  inheritedEventCount: 0,
}

function event(seq: number, type: string, data: unknown): UsageSessionEvent {
  return { type, seq, time: session.createdAt + seq, data } as never
}

describe('UsageLedgerReducer', () => {
  it('emits idempotent compact call and cursor mutations', () => {
    const reducer = new UsageLedgerReducer()
    const mutations = reducer.applyBatch(session, [
      event(0, 'request/context', { provider: 'deepseek', model: 'chat' }),
      event(1, 'step/start', { turn: 0, step: 0 }),
      event(2, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 4 } } }),
      event(3, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }),
      event(4, 'assistant/message', { turn: 0, step: 0, usage: { inputTokens: 7, outputTokens: 4 } }),
    ])
    const calls = [...reducer.callEntries()].map(([, row]) => row)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'deepseek',
      model: 'chat',
      outcome: 'success',
      finalUsage: { inputTokens: 7, outputTokens: 4 },
    })
    expect(mutations.some(mutation => mutation.type === 'cursor-upsert')).toBe(true)
    expect(reducer.cursor(session.id)?.observedSeq).toBe(4)
    expect(reducer.applyBatch(session, [event(4, 'assistant/message', { turn: 0, step: 0 })])).toEqual([])
  })

  it('keeps failed attempts and retry accounting separate', () => {
    const reducer = new UsageLedgerReducer()
    reducer.applyBatch(session, [
      event(0, 'request/context', { provider: 'deepseek', model: 'chat' }),
      event(1, 'step/start', { turn: 0, step: 0 }),
      event(2, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } }),
      event(3, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'finish', reason: { kind: 'error' } } }),
      event(4, 'llm/retry', { turn: 0, step: 0 }),
      event(5, 'llm/retry-started', { retryId: 'retry-1', turn: 0, step: 0, retry: 1 }),
      event(6, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } } }),
      event(7, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }),
      event(8, 'assistant/message', { turn: 0, step: 0, usage: { inputTokens: 5, outputTokens: 3 } }),
    ])
    const calls = [...reducer.callEntries()].map(([, row]) => row).sort((left, right) => left.startedAt - right.startedAt)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ outcome: 'failure', retryScheduled: true, provisionalUsage: { inputTokens: 3 } })
    expect(calls[1]).toMatchObject({ outcome: 'success', finalUsage: { inputTokens: 5 } })
  })
})
