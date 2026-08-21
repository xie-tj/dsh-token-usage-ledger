import { describe, expect, it, vi } from 'vitest'
import { projectSnapshot } from '../src/client/UsageDashboard.tsx'
import type { UsageLedgerSnapshot } from '../src/types.ts'

vi.mock('../src/client/UsageDashboard.module.css', () => ({
  default: {},
  install: vi.fn(() => vi.fn()),
}))

describe('Usage dashboard snapshot projection', () => {
  it('maps only the published Host fields and combines both KV-cache counters', () => {
    const snapshot: UsageLedgerSnapshot = {
      workspace: null,
      days: 2,
      fromDay: '2026-01-01',
      throughDay: '2026-01-02',
      timeZone: 'UTC',
      updatedAt: '2026-01-02T00:00:00.000Z',
      events: [{
        at: Date.UTC(2026, 0, 2, 12),
        workspace: null,
        provider: 'deepseek',
        model: 'chat',
        outcome: 'success',
        retried: false,
        inputTokens: 7,
        outputTokens: 11,
        cacheReadTokens: 13,
        cacheWriteTokens: 17,
      }],
      models: [{
        workspace: null,
        provider: 'deepseek',
        model: 'chat',
        inputTokens: 7,
        outputTokens: 11,
        cacheReadTokens: 13,
        cacheWriteTokens: 17,
        requests: 1,
        successfulRequests: 1,
        failedRequests: 0,
        retryRequests: 0,
        meteredRequests: 1,
        unmeteredRequests: 0,
      }],
      daily: [{
        day: '2026-01-02',
        inputTokens: 7,
        outputTokens: 11,
        cacheReadTokens: 13,
        cacheWriteTokens: 17,
        requests: 1,
        successfulRequests: 1,
        failedRequests: 0,
        retryRequests: 0,
        meteredRequests: 1,
        unmeteredRequests: 0,
      }],
    }

    const projected = projectSnapshot(snapshot)
    expect(projected.events).toEqual([{
      at: Date.UTC(2026, 0, 2, 12),
      model: 'deepseek / chat',
      input: 7,
      output: 11,
      cached: 30,
      metered: true,
      outcome: 'success',
      retried: false,
    }])
    expect(projected.models).toEqual([{
      model: 'deepseek / chat',
      requests: 1,
      input: 7,
      output: 11,
      cached: 30,
      metered: 1,
      unmetered: 0,
      failed: 0,
      retried: 0,
    }])
    expect(projected.daily[0]).toMatchObject({ date: '2026-01-02', cached: 30 })
  })

  it('keeps an unmetered request distinct when the Host omits all usage counters', () => {
    const snapshot = {
      workspace: null,
      days: 1,
      fromDay: '2026-01-02',
      throughDay: '2026-01-02',
      timeZone: 'UTC',
      updatedAt: '2026-01-02T00:00:00.000Z',
      events: [{
        at: Date.UTC(2026, 0, 2, 12),
        workspace: null,
        provider: 'openai',
        model: 'gpt',
        outcome: 'failure' as const,
        retried: true,
      }],
      models: [{
        workspace: null,
        provider: 'openai',
        model: 'gpt',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 1,
        successfulRequests: 0,
        failedRequests: 1,
        retryRequests: 1,
        meteredRequests: 0,
        unmeteredRequests: 1,
      }],
      daily: [],
    } satisfies UsageLedgerSnapshot

    expect(projectSnapshot(snapshot).events[0]).toMatchObject({
      model: 'openai / gpt',
      input: 0,
      output: 0,
      cached: 0,
      metered: false,
      outcome: 'failure',
      retried: true,
    })
  })
})
