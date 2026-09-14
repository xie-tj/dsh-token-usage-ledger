import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openUsageLedgerDatabase } from '../src/host/database.ts'
import type { LedgerMutation } from '../src/host/reducer.ts'
import { createUsageAttemptId } from '../src/host/event-types.ts'

function callMutation(key: string, attempt: string): LedgerMutation {
  return {
    type: 'call-upsert',
    key,
    row: {
      sessionId: 'session',
      createdAt: 1,
      workspace: '/workspace',
      day: '2026-09-14',
      attemptId: createUsageAttemptId(attempt),
      turn: 0,
      step: 0,
      provider: 'deepseek',
      model: 'chat',
      startedAt: 100,
      outcome: 'success',
      finalUsage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
    },
  }
}

describe('UsageLedgerDatabase', () => {
  it('reads only active calls for one session and pages complete history from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-db-'))
    const database = await openUsageLedgerDatabase(join(root, 'usage-ledger-v4.sqlite'))
    try {
      database.applyMutations([
        callMutation('completed', 'completed'),
        {
          type: 'cursor-upsert',
          sessionId: 'session',
          row: { createdAt: 1, workspace: '/workspace', observedSeq: 1, activeAttempts: {} },
        },
      ])
      expect(database.sessionSeed('session', 1, 256).calls).toEqual([])
      database.applyMutations([
        callMutation('active', 'active'),
        {
          type: 'cursor-upsert',
          sessionId: 'session',
          row: {
            createdAt: 1,
            workspace: '/workspace',
            observedSeq: 2,
            activeAttempts: { '0:0': createUsageAttemptId('active') },
          },
        },
      ])
      expect(database.sessionSeed('session', 1, 256).calls).toHaveLength(1)
      const first = database.callsPage({
        startedAtInclusive: 0,
        startedAtExclusive: 1_000,
        workspace: null,
        provider: null,
        model: null,
        limit: 1,
      })
      expect(first.rows).toHaveLength(1)
      expect(first.next).toBeDefined()
      const second = database.callsPage({
        startedAtInclusive: 0,
        startedAtExclusive: 1_000,
        workspace: null,
        provider: null,
        model: null,
        after: first.next,
        limit: 1,
      })
      expect(second.rows).toHaveLength(1)
    } finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
