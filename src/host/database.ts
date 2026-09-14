/** Bounded SQLite reader and writer for the private Usage Ledger database. */

import { mkdir, open as openFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { createUsageAttemptId } from './event-types.ts'
import type { LedgerMutation } from './reducer.ts'
import type {
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
  UsageLedgerTokenUsage,
} from './spec.ts'

/** Dedicated SQLite file format. It intentionally does not read v2/v3 stores. */
export const USAGE_LEDGER_SQLITE_SCHEMA_VERSION = 4

/** SQLite application id used to reject unrelated user files. */
export const USAGE_LEDGER_SQLITE_APPLICATION_ID = 0x44534c34

const CALL_COLUMNS = `
  key, session_id, created_at, workspace, attempt_id, turn, step, provider, model,
  started_at, outcome, retry_scheduled,
  provisional_input_tokens, provisional_output_tokens, provisional_cache_read_tokens, provisional_cache_write_tokens,
  final_input_tokens, final_output_tokens, final_cache_read_tokens, final_cache_write_tokens
`

type SqlCallRow = {
  readonly key: string
  readonly session_id: string
  readonly created_at: number
  readonly workspace: string | null
  readonly attempt_id: string
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly model: string
  readonly started_at: number
  readonly outcome: UsageLedgerCallRow['outcome'] | null
  readonly retry_scheduled: number
  readonly provisional_input_tokens: number | null
  readonly provisional_output_tokens: number | null
  readonly provisional_cache_read_tokens: number | null
  readonly provisional_cache_write_tokens: number | null
  readonly final_input_tokens: number | null
  readonly final_output_tokens: number | null
  readonly final_cache_read_tokens: number | null
  readonly final_cache_write_tokens: number | null
}

type SqlSessionRow = {
  readonly session_id: string
  readonly created_at: number
  readonly workspace: string | null
  readonly observed_seq: number
  readonly active_attempts: string
  readonly route_provider: string | null
  readonly route_model: string | null
}

/** One page of call rows scanned in timestamp/key order. */
export interface UsageLedgerCallPage {
  readonly rows: readonly { readonly key: string; readonly row: UsageLedgerCallRow }[]
  readonly next: Readonly<{ startedAt: number; key: string }> | undefined
}

/** SQL filters used by a bounded call-page scan. */
export interface UsageLedgerCallPageRequest {
  readonly startedAtInclusive: number
  readonly startedAtExclusive: number
  readonly workspace: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly after?: Readonly<{ startedAt: number; key: string }> | undefined
  readonly limit: number
}

/** State loaded only for the session currently being reduced. */
export interface UsageLedgerSessionSeed {
  readonly cursor: UsageLedgerSessionRow | undefined
  readonly calls: readonly { readonly key: string; readonly row: UsageLedgerCallRow }[]
}

/**
 * Create a missing private database file with owner-only permissions.
 * Existing files retain their permissions.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await openFile(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Open and validate the private SQLite file without touching legacy ledger files. */
export async function openUsageLedgerDatabase(path: string): Promise<UsageLedgerDatabase> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const db = new DatabaseSync(actual)
  try {
    configureDatabase(db, actual)
    return new UsageLedgerDatabase(db)
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string): void {
  const applicationId = db.prepare('PRAGMA application_id').get() as { application_id: number }
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const userTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  if (applicationId.application_id !== 0 && applicationId.application_id !== USAGE_LEDGER_SQLITE_APPLICATION_ID) {
    throw new Error(`usage ledger database at "${path}" belongs to another application`)
  }
  if (applicationId.application_id === 0 && userTables.length > 0) {
    throw new Error(`usage ledger database at "${path}" is not empty`)
  }
  if (applicationId.application_id === USAGE_LEDGER_SQLITE_APPLICATION_ID && version.user_version !== USAGE_LEDGER_SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `usage ledger database at "${path}" has schema ${String(version.user_version)}, expected ${String(USAGE_LEDGER_SQLITE_SCHEMA_VERSION)}`,
    )
  }
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  // Each connection has a fixed, small page cache. Historical volume stays on disk.
  db.exec('PRAGMA cache_size = -8192')
  db.exec('PRAGMA temp_store = FILE')
  db.exec('PRAGMA mmap_size = 0')
  db.exec(`PRAGMA application_id = ${String(USAGE_LEDGER_SQLITE_APPLICATION_ID)}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id      TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      workspace       TEXT,
      observed_seq    INTEGER NOT NULL,
      active_attempts TEXT NOT NULL,
      route_provider  TEXT,
      route_model     TEXT,
      PRIMARY KEY (session_id, created_at)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      key                            TEXT PRIMARY KEY,
      session_id                     TEXT NOT NULL,
      created_at                     INTEGER NOT NULL,
      workspace                      TEXT,
      attempt_id                     TEXT NOT NULL,
      turn                           INTEGER NOT NULL,
      step                           INTEGER NOT NULL,
      provider                       TEXT NOT NULL,
      model                          TEXT NOT NULL,
      started_at                     INTEGER NOT NULL,
      outcome                        TEXT CHECK (outcome IN ('success', 'failure', 'aborted')),
      retry_scheduled                INTEGER NOT NULL CHECK (retry_scheduled IN (0, 1)),
      provisional_input_tokens       INTEGER,
      provisional_output_tokens      INTEGER,
      provisional_cache_read_tokens  INTEGER,
      provisional_cache_write_tokens INTEGER,
      final_input_tokens             INTEGER,
      final_output_tokens            INTEGER,
      final_cache_read_tokens        INTEGER,
      final_cache_write_tokens       INTEGER
    ) STRICT
  `)
  db.exec('CREATE INDEX IF NOT EXISTS calls_started_at ON calls (started_at, key)')
  db.exec('CREATE INDEX IF NOT EXISTS calls_session ON calls (session_id, created_at, attempt_id)')
  db.exec(`PRAGMA user_version = ${String(USAGE_LEDGER_SQLITE_SCHEMA_VERSION)}`)
}

function decodeUsage(
  input: number | null,
  output: number | null,
  cacheRead: number | null,
  cacheWrite: number | null,
): UsageLedgerTokenUsage | undefined {
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

function callFromSql(row: SqlCallRow): UsageLedgerCallRow {
  return {
    sessionId: row.session_id,
    createdAt: row.created_at,
    ...(row.workspace === null ? {} : { workspace: row.workspace }),
    day: new Date(row.started_at).toISOString().slice(0, 10),
    attemptId: createUsageAttemptId(row.attempt_id),
    turn: row.turn,
    step: row.step,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.retry_scheduled === 0 ? {} : { retryScheduled: true }),
    ...(decodeUsage(
      row.provisional_input_tokens,
      row.provisional_output_tokens,
      row.provisional_cache_read_tokens,
      row.provisional_cache_write_tokens,
    ) === undefined ? {} : {
      provisionalUsage: decodeUsage(
        row.provisional_input_tokens,
        row.provisional_output_tokens,
        row.provisional_cache_read_tokens,
        row.provisional_cache_write_tokens,
      ),
    }),
    ...(decodeUsage(
      row.final_input_tokens,
      row.final_output_tokens,
      row.final_cache_read_tokens,
      row.final_cache_write_tokens,
    ) === undefined ? {} : {
      finalUsage: decodeUsage(
        row.final_input_tokens,
        row.final_output_tokens,
        row.final_cache_read_tokens,
        row.final_cache_write_tokens,
      ),
    }),
  }
}

function sessionFromSql(row: SqlSessionRow): UsageLedgerSessionRow {
  const active = JSON.parse(row.active_attempts) as Record<string, string>
  return {
    createdAt: row.created_at,
    ...(row.workspace === null ? {} : { workspace: row.workspace }),
    observedSeq: row.observed_seq,
    activeAttempts: Object.fromEntries(Object.entries(active).map(([key, value]) => [key, createUsageAttemptId(value)])),
    ...(row.route_provider === null || row.route_model === null ? {} : {
      route: { provider: row.route_provider, model: row.route_model },
    }),
  }
}

function usageBindings(usage: UsageLedgerTokenUsage | undefined): readonly (number | null)[] {
  return usage === undefined
    ? [null, null, null, null]
    : [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
}

/** Dedicated, bounded access to the private ledger database. */
export class UsageLedgerDatabase {
  private readonly putCall: StatementSync
  private readonly putSession: StatementSync

  constructor(private readonly db: DatabaseSync) {
    this.putCall = db.prepare(`
    INSERT INTO calls (${CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      session_id = excluded.session_id,
      created_at = excluded.created_at,
      workspace = excluded.workspace,
      attempt_id = excluded.attempt_id,
      turn = excluded.turn,
      step = excluded.step,
      provider = excluded.provider,
      model = excluded.model,
      started_at = excluded.started_at,
      outcome = excluded.outcome,
      retry_scheduled = excluded.retry_scheduled,
      provisional_input_tokens = excluded.provisional_input_tokens,
      provisional_output_tokens = excluded.provisional_output_tokens,
      provisional_cache_read_tokens = excluded.provisional_cache_read_tokens,
      provisional_cache_write_tokens = excluded.provisional_cache_write_tokens,
      final_input_tokens = excluded.final_input_tokens,
      final_output_tokens = excluded.final_output_tokens,
      final_cache_read_tokens = excluded.final_cache_read_tokens,
      final_cache_write_tokens = excluded.final_cache_write_tokens
  `)
    this.putSession = db.prepare(`
    INSERT INTO sessions (session_id, created_at, workspace, observed_seq, active_attempts, route_provider, route_model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, created_at) DO UPDATE SET
      workspace = excluded.workspace,
      observed_seq = excluded.observed_seq,
      active_attempts = excluded.active_attempts,
      route_provider = excluded.route_provider,
      route_model = excluded.route_model
  `)
  }

  /** Apply a bounded mutation batch as one durable SQLite transaction. */
  applyMutations(mutations: readonly LedgerMutation[]): void {
    if (mutations.length === 0) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const mutation of mutations) {
        if (mutation.type === 'call-upsert') {
          const row = mutation.row
          this.putCall.run(
            mutation.key,
            row.sessionId,
            row.createdAt,
            row.workspace ?? null,
            row.attemptId,
            row.turn,
            row.step,
            row.provider,
            row.model,
            row.startedAt,
            row.outcome ?? null,
            row.retryScheduled === true ? 1 : 0,
            ...usageBindings(row.provisionalUsage),
            ...usageBindings(row.finalUsage),
          )
        } else if (mutation.type === 'cursor-upsert') {
          const row = mutation.row
          this.putSession.run(
            mutation.sessionId,
            row.createdAt,
            row.workspace ?? null,
            row.observedSeq,
            JSON.stringify(row.activeAttempts),
            row.route?.provider ?? null,
            row.route?.model ?? null,
          )
        }
      }
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The original mutation failure explains the durable-write outcome.
      }
      throw error
    }
  }

  /** Load only one session's cursor and currently active call rows. */
  sessionSeed(sessionId: string, createdAt: number, maxActiveAttempts: number): UsageLedgerSessionSeed {
    const stored = this.db.prepare(`
      SELECT session_id, created_at, workspace, observed_seq, active_attempts, route_provider, route_model
      FROM sessions WHERE session_id = ? AND created_at = ?
    `).get(sessionId, createdAt) as SqlSessionRow | undefined
    const cursor = stored === undefined ? undefined : sessionFromSql(stored)
    const attemptIds = cursor === undefined ? [] : [...new Set(Object.values(cursor.activeAttempts))]
    if (attemptIds.length > maxActiveAttempts) {
      throw new Error('usage ledger session active attempt count exceeds workerMaxActiveAttempts')
    }
    const calls: Array<{ key: string; row: UsageLedgerCallRow }> = []
    for (const attemptId of attemptIds) {
      const row = this.db.prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE session_id = ? AND created_at = ? AND attempt_id = ?`).get(
        sessionId,
        createdAt,
        attemptId,
      ) as SqlCallRow | undefined
      if (row !== undefined) calls.push({ key: row.key, row: callFromSql(row) })
    }
    return { cursor, calls }
  }

  /** Read one bounded chronological page without materializing the ledger. */
  callsPage(request: UsageLedgerCallPageRequest): UsageLedgerCallPage {
    const clauses = ['started_at >= ?', 'started_at < ?']
    const values: Array<string | number> = [request.startedAtInclusive, request.startedAtExclusive]
    if (request.workspace !== null) {
      clauses.push('workspace = ?')
      values.push(request.workspace)
    }
    if (request.provider !== null) {
      clauses.push('provider = ?')
      values.push(request.provider)
    }
    if (request.model !== null) {
      clauses.push('model = ?')
      values.push(request.model)
    }
    if (request.after !== undefined) {
      clauses.push('(started_at > ? OR (started_at = ? AND key > ?))')
      values.push(request.after.startedAt, request.after.startedAt, request.after.key)
    }
    values.push(request.limit)
    const sql = `SELECT ${CALL_COLUMNS} FROM calls WHERE ${clauses.join(' AND ')} ORDER BY started_at, key LIMIT ?`
    const rows = (this.db.prepare(sql).all(...values) as SqlCallRow[])
      .map(row => ({ key: row.key, row: callFromSql(row) }))
    const tail = rows.at(-1)
    return {
      rows,
      next: rows.length < request.limit || tail === undefined ? undefined : { startedAt: tail.row.startedAt, key: tail.key },
    }
  }

  /** Return the earliest matching attempt timestamp without loading call rows. */
  firstCallTime(
    workspace: string | null,
    provider: string | null,
    model: string | null,
  ): number | undefined {
    const clauses: string[] = []
    const values: string[] = []
    if (workspace !== null) {
      clauses.push('workspace = ?')
      values.push(workspace)
    }
    if (provider !== null) {
      clauses.push('provider = ?')
      values.push(provider)
    }
    if (model !== null) {
      clauses.push('model = ?')
      values.push(model)
    }
    const where = clauses.length === 0 ? '' : ' WHERE ' + clauses.join(' AND ')
    const row = this.db.prepare('SELECT MIN(started_at) AS started_at FROM calls' + where).get(...values) as { started_at: number | null }
    return row.started_at === null ? undefined : row.started_at
  }

  /** Close this connection after the owning service or worker reaches quiescence. */
  close(): void {
    this.db.close()
  }
}
