import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { openUsageLedgerDatabase } from '../src/host/database.ts'
import { createUsageAttemptId } from '../src/host/event-types.ts'
import type { LedgerMutation } from '../src/host/reducer.ts'
import type {} from '../lib/types/host/index.js'
// @ts-expect-error built Host entry
import Ledger from '../lib/index.js'

const ROWS = 100_000

describe('Usage snapshot sweep', () => {
  it('reads a full-history snapshot in one pass instead of re-seeking per page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usage-snapshot-sweep-'))
    const databasePath = join(root, 'ledger.sqlite')
    const database = await openUsageLedgerDatabase(databasePath)
    const firstStartedAt = Date.parse('2026-08-01T00:00:00Z')
    try {
      for (let offset = 0; offset < ROWS; offset += 1_000) {
        const batch: LedgerMutation[] = []
        for (let index = offset; index < offset + 1_000; index += 1) {
          batch.push({
            type: 'call-upsert',
            key: 'call-' + String(index),
            row: {
              sessionId: 'session-' + String(index % 100),
              createdAt: 1,
              workspace: '/workspace',
              day: '2026-08-01',
              attemptId: createUsageAttemptId('attempt-' + String(index)),
              turn: 0,
              step: 0,
              provider: 'deepseek',
              model: 'chat',
              startedAt: firstStartedAt + index * 1_000,
              outcome: 'success',
              finalUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0 },
            },
          })
        }
        database.applyMutations(batch)
      }
    } finally {
      database.close()
    }
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    const fiber = ctx.plugin(Ledger, { databasePath, backfillMode: 'off' })
    try {
      await fiber.await()
      // The replaced implementation prepared one keyset statement per 256-row page, so counting
      // statements prepared during the call pins the sweep to one pass without timing the machine.
      const prepared = DatabaseSync.prototype.prepare
      let statements = 0
      DatabaseSync.prototype.prepare = function countingPrepare(this: DatabaseSync, sql: string) {
        statements += 1
        return prepared.call(this, sql)
      }
      let snapshot
      try {
        snapshot = await ctx.usageLedger.snapshot({ all: true, timeZone: 'UTC' })
      } finally {
        DatabaseSync.prototype.prepare = prepared
      }
      expect(snapshot.models).toHaveLength(1)
      expect(snapshot.models[0]).toMatchObject({
        provider: 'deepseek', model: 'chat', requests: ROWS, inputTokens: ROWS * 10, outputTokens: ROWS * 5,
      })
      expect(snapshot.events).toHaveLength(256)
      expect(snapshot.eventsTruncated).toBe(true)
      // One page read for the event list plus one sweep; a keyset sweep needed a statement per page.
      expect(statements).toBeLessThanOrEqual(4)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
