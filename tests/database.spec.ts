import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { USAGE_LEDGER_SQLITE_SCHEMA_VERSION, openUsageLedgerDatabase } from '../src/host/database.ts'
import type { LedgerMutation } from '../src/host/reducer.ts'
import { createUsageAttemptId } from '../src/host/event-types.ts'
import { workerSourceIdentity,workerSourceFingerprint } from '../src/host/worker-protocol.ts'

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
  it('adds source checkpoints and unreadable-source records to schema 4 without replacing calls or replay cursors', async () => {
    const temporary=await mkdtemp(join(tmpdir(),'usage-schema-four-'))
    const path=join(temporary,'usage-ledger-v4.sqlite')
    let database=await openUsageLedgerDatabase(path)
    try {
      database.applyMutations([callMutation('saved','saved'),{type:'cursor-upsert',sessionId:'session',row:{createdAt:1,observedSeq:123,activeAttempts:{}}}])
      database.close()
      const legacy=new DatabaseSync(path)
      try {legacy.exec('DROP TABLE source_checkpoints; PRAGMA user_version=4')} finally {legacy.close()}
      database=await openUsageLedgerDatabase(path)
      expect(database.sessionSeed('session',1,256).cursor?.observedSeq).toBe(123)
      const calls=database.callsPage({startedAtInclusive:0,startedAtExclusive:1000,workspace:null,provider:null,model:null,limit:10})
      expect(calls.rows).toHaveLength(1)
      expect(calls.rows[0].row.finalUsage).toEqual({inputTokens:7,outputTokens:3,cacheReadTokens:2,cacheWriteTokens:1})
      const raw=new DatabaseSync(path,{readOnly:true})
      try {
        expect(raw.prepare('PRAGMA user_version').get()).toEqual({user_version:USAGE_LEDGER_SQLITE_SCHEMA_VERSION})
        expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='unreadable_sources'").get()).toEqual({name:'unreadable_sources'})
      } finally {raw.close()}
    } finally {database.close();await rm(temporary,{recursive:true,force:true})}
  })

  it('invalidates completed-source records when the cursor changes and refuses a stale completion',async()=>{
    const database=await openUsageLedgerDatabase(':memory:')
    const session={id:'session',createdAt:1}
    const stamp={source:workerSourceIdentity('fixture-source'),fingerprint:workerSourceFingerprint('fixture-fingerprint')}
    try {
      database.completeSource(session,stamp,-1)
      expect(database.sourceUnchanged(session,stamp,-1)).toBe(true)
      expect(database.sourceUnchangedAtSavedCursor(session,stamp)).toBe(true)
      database.applyMutations([{type:'cursor-upsert',sessionId:'session',row:{createdAt:1,observedSeq:2,activeAttempts:{}}}])
      expect(database.sourceUnchanged(session,stamp,2)).toBe(false)
      expect(database.sourceUnchangedAtSavedCursor(session,stamp)).toBe(false)
      database.completeSource(session,stamp,2)
      expect(database.sourceUnchanged(session,stamp,2)).toBe(true)
      expect(database.sourceUnchangedAtSavedCursor(session,stamp)).toBe(true)
      expect(database.sourceUnchangedAtSavedCursor({...session,createdAt:2},stamp)).toBe(false)
      expect(database.sourceUnchangedAtSavedCursor(session,{...stamp,fingerprint:workerSourceFingerprint('changed')})).toBe(false)
      expect(database.sourceUnchanged(session,{...stamp,fingerprint:workerSourceFingerprint('changed')},2)).toBe(false)
      database.applyMutations([{type:'cursor-upsert',sessionId:'session',row:{createdAt:1,observedSeq:3,activeAttempts:{}}}])
      database.completeSource(session,stamp,2)
      expect(database.sourceUnchanged(session,stamp,3)).toBe(false)
    } finally {database.close()}
  })

  it('refuses a newer schema rather than downgrading it',async()=>{
    const temporary=await mkdtemp(join(tmpdir(),'usage-newer-schema-'))
    const path=join(temporary,'ledger.sqlite')
    const database=await openUsageLedgerDatabase(path)
    database.close()
    const newer=USAGE_LEDGER_SQLITE_SCHEMA_VERSION+1
    const raw=new DatabaseSync(path)
    try {raw.exec('PRAGMA user_version='+String(newer))} finally {raw.close()}
    try {await expect(openUsageLedgerDatabase(path)).rejects.toThrow('schema '+String(newer))} finally {await rm(temporary,{recursive:true,force:true})}
  })

  it('remembers a refused source revision until that generation is rewritten',async()=>{
    const database=await openUsageLedgerDatabase(':memory:')
    const session={id:'session',createdAt:1}
    const stamp={source:workerSourceIdentity('fixture-source'),fingerprint:workerSourceFingerprint('refused')}
    try {
      expect(database.unreadableSourceReason(session,stamp)).toBeUndefined()
      database.markSourceUnreadable(session,stamp,'turn/start 2 does not close the prior turn')
      expect(database.unreadableSourceReason(session,stamp)).toBe('turn/start 2 does not close the prior turn')
      // A rewritten generation carries a new fingerprint, so the stale refusal does not match it.
      expect(database.unreadableSourceReason(session,{...stamp,fingerprint:workerSourceFingerprint('rewritten')})).toBeUndefined()
      database.completeSource(session,stamp,-1)
      expect(database.unreadableSourceReason(session,stamp)).toBeUndefined()
    } finally {database.close()}
  })

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
