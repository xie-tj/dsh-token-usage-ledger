/** Host-side Usage Ledger coordinator; heavy replay runs in a private worker. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm-retry'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { usageLedgerDomainSpec } from './spec.ts'
import type {
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
} from './spec.ts'
import type {
  UsageLedgerDailyRow,
  UsageLedgerEvent,
  UsageLedgerModelRow,
  UsageLedgerSnapshot,
  UsageLedgerSnapshotRequest,
  UsageLedgerStatus,
} from './types.ts'
import type { UsageSessionEvent } from './event-types.ts'
import { USAGE_LEDGER_WORKER_PROTOCOL } from './worker-protocol.ts'
import type {
  WorkerInitFrame,
  WorkerReaderSpec,
  WorkerResponseFrame,
  WorkerSession,
} from './worker-protocol.ts'
import { UsageWorkerSupervisor } from './supervisor.ts'

export type * from './types.ts'
export {
  usageLedgerCallRowSchema,
  usageLedgerDomainSpec,
  usageLedgerSessionRowSchema,
} from './spec.ts'
export type {
  UsageLedgerAttemptOutcome,
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
  UsageLedgerTokenUsage,
} from './spec.ts'
export type { UsageAttemptId, UsageRequestAttemptEvent } from './event-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    usageLedger: UsageLedgerService
  }
}

const DEFAULT_DAYS = 30
const MAX_DAYS = 366
const DEFAULT_BATCH_EVENTS = 256
const DEFAULT_SLICE_MS = 25
const DEFAULT_HEAP_MIB = 512

/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
export const USAGE_LEDGER_SETTINGS_NAMESPACE = 'usage-ledger' as const
type UsageLedgerSettings = Readonly<Record<string, never>>
const UsageLedgerSettingsSchema = z.object({}) as unknown as z<UsageLedgerSettings>

/** Enable or disable the isolated historical reader process. */
export type UsageLedgerBackfillMode = 'process' | 'off'

/** Runtime configuration for the background ledger coordinator. */
export interface Config {
  readonly backfillMode?: UsageLedgerBackfillMode
  readonly backfillDays?: number
  readonly workerMaxHeapMiB?: number
  readonly workerBatchEvents?: number
  readonly workerSliceMs?: number
}

interface ResolvedConfig {
  readonly backfillMode: UsageLedgerBackfillMode
  readonly backfillDays: number
  readonly workerMaxHeapMiB: number
  readonly workerBatchEvents: number
  readonly workerSliceMs: number
}

const BackfillModeSchema = z.union([z.const('process'), z.const('off')])

const ZERO_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  retryRequests: 0,
  meteredRequests: 0,
  unmeteredRequests: 0,
} as const

interface ResolvedSnapshotRequest {
  readonly workspace: string | null
  readonly days: number
  readonly throughDay: string
  readonly timeZone: string
}

interface PersistenceReaderRuntime {
  list(): Promise<unknown>
  backgroundReaderSpec?: () => unknown
}

interface ListedSession {
  readonly header: SessionHeader
}

function resolveConfig(config: Config): ResolvedConfig {
  const backfillMode = config.backfillMode ?? 'process'
  const backfillDays = config.backfillDays ?? DEFAULT_DAYS
  const workerMaxHeapMiB = config.workerMaxHeapMiB ?? DEFAULT_HEAP_MIB
  const workerBatchEvents = config.workerBatchEvents ?? DEFAULT_BATCH_EVENTS
  const workerSliceMs = config.workerSliceMs ?? DEFAULT_SLICE_MS
  if (backfillMode !== 'process' && backfillMode !== 'off') throw new RangeError(`usage ledger backfillMode is invalid: '${String(backfillMode)}'`)
  for (const [name, value, min, max] of [
    ['backfillDays', backfillDays, 1, MAX_DAYS],
    ['workerMaxHeapMiB', workerMaxHeapMiB, 128, 4096],
    ['workerBatchEvents', workerBatchEvents, 1, 4096],
    ['workerSliceMs', workerSliceMs, 1, 1000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`usage ledger ${name} must be a safe integer from ${String(min)} through ${String(max)}`)
    }
  }
  return { backfillMode, backfillDays, workerMaxHeapMiB, workerBatchEvents, workerSliceMs }
}

/** Format an epoch timestamp as a calendar day in an IANA timezone. */
function zoneDay(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(time))
  const year = parts.find(part => part.type === 'year')?.value
  const month = parts.find(part => part.type === 'month')?.value
  const day = parts.find(part => part.type === 'day')?.value
  if (year === undefined || month === undefined || day === undefined) throw new Error(`usage ledger could not format date in timezone '${timeZone}'`)
  return `${year}-${month}-${day}`
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

function shiftDay(day: string, offset: number): string {
  const instant = new Date(`${day}T00:00:00.000Z`)
  instant.setUTCDate(instant.getUTCDate() + offset)
  return utcDay(instant.getTime())
}

function resolveSnapshotRequest(request: UsageLedgerSnapshotRequest | undefined): ResolvedSnapshotRequest {
  const workspace = request?.workspace ?? null
  const days = request?.days ?? DEFAULT_DAYS
  const timeZone = request?.timeZone ?? 'UTC'
  if (workspace !== null && typeof workspace !== 'string') throw new TypeError('usage ledger workspace must be a string or null')
  if (typeof timeZone !== 'string' || timeZone.length === 0) throw new TypeError('usage ledger timeZone must be a non-empty IANA timezone')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new RangeError(`usage ledger timeZone is invalid: '${timeZone}'`)
  }
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new RangeError(`usage ledger days must be a safe integer from 1 through ${MAX_DAYS}`)
  return { workspace, days, throughDay: zoneDay(Date.now(), timeZone), timeZone }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateHeader(value: unknown): SessionHeader {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.version)
    || typeof value.id !== 'string'
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || typeof value.isSeeded !== 'boolean'
    || (value.cwd !== undefined && typeof value.cwd !== 'string')
    || (value.parentSession !== undefined && typeof value.parentSession !== 'string')
    || (value.origin !== undefined && value.origin !== 'subagent')
    || (value.delegationDepth !== undefined && (typeof value.delegationDepth !== 'number' || !Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0))
    || (value.agentPreset !== undefined && typeof value.agentPreset !== 'string')) {
    throw new TypeError('usage ledger received invalid session metadata')
  }
  return value as unknown as SessionHeader
}

async function listRecentSessions(persistence: SessionPersistence, days: number): Promise<readonly ListedSession[]> {
  const runtime = persistence as unknown as PersistenceReaderRuntime
  const listed = await runtime.list()
  if (!Array.isArray(listed)) throw new TypeError('usage ledger received an invalid session listing')
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const result: ListedSession[] = []
  for (const value of listed) {
    const record = isRecord(value) && isRecord(value.header) ? value.header : value
    const header = validateHeader(record)
    if (header.createdAt >= cutoff) result.push({ header })
  }
  return result
}

function validateReaderSpec(value: unknown): WorkerReaderSpec | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.protocolVersion !== 'number' || typeof value.workerModule !== 'string' || value.workerModule.length === 0) {
    throw new TypeError('usage ledger received an invalid background reader spec')
  }
  if (value.options !== undefined && (!isRecord(value.options)
    || Object.values(value.options).some(option => typeof option !== 'string' && typeof option !== 'number' && typeof option !== 'boolean'))) {
    throw new TypeError('usage ledger background reader options must be JSON-safe primitives')
  }
  return value as unknown as WorkerReaderSpec
}

/** Copy only the usage-bearing fields across the process boundary. */
function compactEvent(event: SessionEvent): UsageSessionEvent | undefined {
  const base = { seq: event.seq, time: event.time }
  switch (event.type) {
    case 'step/start':
      return { ...base, type: event.type, data: event.data }
    case 'request/context':
      return { ...base, type: event.type, data: { provider: event.data.provider, model: event.data.model } }
    case 'request/header': {
      const { provider, model } = event.data.header.config
      return {
        ...base,
        type: event.type,
        data: { reason: event.data.reason, header: { config: { provider, model } } },
      } as unknown as UsageSessionEvent
    }
    case 'llm/retry':
      return { ...base, type: event.type, data: { turn: event.data.turn, step: event.data.step } } as UsageSessionEvent
    case 'llm/retry-started':
      return {
        ...base,
        type: event.type,
        data: { retryId: event.data.retryId, turn: event.data.turn, step: event.data.step, retry: event.data.retry },
      }
    case 'turn/end':
      return { ...base, type: event.type, data: { turn: event.data.turn, reason: { kind: event.data.reason.kind } } } as UsageSessionEvent
    case 'assistant/chunk':
      if (event.data.chunk.type === 'usage') {
        return {
          ...base,
          type: event.type,
          data: { turn: event.data.turn, step: event.data.step, chunk: { type: 'usage', usage: event.data.chunk.usage } },
        } as UsageSessionEvent
      }
      if (event.data.chunk.type === 'finish') {
        return {
          ...base,
          type: event.type,
          data: { turn: event.data.turn, step: event.data.step, chunk: { type: 'finish', reason: { kind: event.data.chunk.reason.kind } } },
        } as UsageSessionEvent
      }
      return undefined
    case 'assistant/message':
      return {
        ...base,
        type: event.type,
        data: {
          turn: event.data.turn,
          step: event.data.step,
          ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
          ...(event.data.interrupted === true ? { interrupted: true as const } : {}),
        },
      } as unknown as UsageSessionEvent
    default:
      return undefined
  }
}

function workerSession(session: Session): WorkerSession {
  return {
    id: session.id,
    createdAt: session.header.createdAt,
    ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
    inheritedEventCount: session.inheritedEventCount,
  }
}

function addAttempt<T extends UsageLedgerModelRow | UsageLedgerDailyRow>(row: T, call: UsageLedgerCallRow): T {
  const usage = call.finalUsage ?? call.provisionalUsage
  return {
    ...row,
    inputTokens: row.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: row.outputTokens + (usage?.outputTokens ?? 0),
    cacheReadTokens: row.cacheReadTokens + (usage?.cacheReadTokens ?? 0),
    cacheWriteTokens: row.cacheWriteTokens + (usage?.cacheWriteTokens ?? 0),
    requests: row.requests + 1,
    successfulRequests: row.successfulRequests + (call.outcome === 'success' ? 1 : 0),
    failedRequests: row.failedRequests + (call.outcome === 'failure' || call.outcome === 'aborted' ? 1 : 0),
    retryRequests: row.retryRequests + (call.retryScheduled === true ? 1 : 0),
    meteredRequests: row.meteredRequests + (usage === undefined ? 0 : 1),
    unmeteredRequests: row.unmeteredRequests + (usage === undefined ? 1 : 0),
  }
}

function projectEvents(rows: readonly UsageLedgerCallRow[]): UsageLedgerEvent[] {
  return [...rows].sort((left, right) => left.startedAt - right.startedAt).map((row) => {
    const usage = row.finalUsage ?? row.provisionalUsage
    return {
      at: row.startedAt,
      workspace: row.workspace ?? null,
      provider: row.provider,
      model: row.model,
      outcome: row.outcome ?? 'started',
      retried: row.retryScheduled === true,
      ...(usage === undefined ? {} : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      }),
    }
  })
}

function compareModels(left: UsageLedgerModelRow, right: UsageLedgerModelRow): number {
  return (left.workspace ?? '').localeCompare(right.workspace ?? '')
    || left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model)
}

/** Host service that coordinates compact live events and isolated history replay. */
export class UsageLedgerService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessions', 'sessionPersistence']
  static Config: z<Config> = z.object({
    backfillMode: BackfillModeSchema.default('process'),
    backfillDays: z.number().step(1).min(1).max(MAX_DAYS).default(DEFAULT_DAYS),
    workerMaxHeapMiB: z.number().step(1).min(128).max(4096).default(DEFAULT_HEAP_MIB),
    workerBatchEvents: z.number().step(1).min(1).max(4096).default(DEFAULT_BATCH_EVENTS),
    workerSliceMs: z.number().step(1).min(1).max(1000).default(DEFAULT_SLICE_MS),
  })

  private readonly resolvedConfig: ResolvedConfig
  private readonly worker: UsageWorkerSupervisor
  private sessions?: KvTable<SessionId, UsageLedgerSessionRow>
  private calls?: KvTable<string, UsageLedgerCallRow>
  private accepting = true
  private pendingCalls = new Map<string, UsageLedgerCallRow>()
  private pendingCursors = new Map<string, UsageLedgerSessionRow>()
  private pendingDeletes = new Map<string, number>()
  private writeScheduled = false
  private writing = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private status: UsageLedgerStatus

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'usageLedger', { namespace: 'usageLedgerPlugin' })
    this.resolvedConfig = resolveConfig(config)
    this.status = {
      state: this.resolvedConfig.backfillMode === 'off' ? 'paused' : 'idle',
      totalSessions: 0,
      processedSessions: 0,
      processedEvents: 0,
      backfillDays: this.resolvedConfig.backfillDays,
      updatedAt: new Date().toISOString(),
    }
    this.worker = new UsageWorkerSupervisor({
      onResponse: frame => this.handleWorkerResponse(frame),
      onFailure: message => this.recordFailure(message),
    })
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(USAGE_LEDGER_SETTINGS_NAMESPACE, UsageLedgerSettingsSchema)
    })
  }

  /** Open SQLite-backed tables and install non-blocking observers. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(usageLedgerDomainSpec)
    this.sessions = domain.table('sessions')
    this.calls = domain.table('calls')
    this.ctx.effect(() => async () => {
      this.accepting = false
      await this.worker.stop()
      await this.drainWrites()
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
      await domain.close()
    }, 'usage-ledger.domain-close')

    this.ctx.on('session/created', session => {
      this.worker.sendControl({ type: 'rescan', session: workerSession(session) }, session.id)
    }, { global: true })
    this.ctx.on('session/event', (session, event) => {
      const compact = compactEvent(event)
      if (compact !== undefined) this.worker.sendLive({ type: 'live', session: workerSession(session), event: compact })
    }, { global: true })
    this.ctx.on('session/disposed', session => {
      this.worker.sendControl({ type: 'dispose', session: workerSession(session) }, session.id)
    }, { global: true })

    if (this.resolvedConfig.backfillMode === 'off') return
    void this.startWorker(this.ctx.sessionPersistence)
  }

  /** Start asynchronously so listing and worker startup never delay a task. */
  private async startWorker(persistence: SessionPersistence): Promise<void> {
    let listed: readonly ListedSession[] = []
    try {
      listed = await listRecentSessions(persistence, this.resolvedConfig.backfillDays)
    } catch (error: unknown) {
      this.recordFailure(`historical session listing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    let readerSpec: WorkerReaderSpec | undefined
    try {
      const runtime = persistence as unknown as PersistenceReaderRuntime
      readerSpec = validateReaderSpec(typeof runtime.backgroundReaderSpec === 'function' ? runtime.backgroundReaderSpec() : undefined)
    } catch (error: unknown) {
      this.recordFailure(`provider-owned reader unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const liveSessions = this.ctx.sessions.list().map(workerSession)
      const sessions = [...listed.map(({ header }) => ({
        id: header.id,
        createdAt: header.createdAt,
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        inheritedEventCount: 0,
      })), ...liveSessions]
      const unique = new Map(sessions.map(session => [session.id, session]))
      const frame: WorkerInitFrame = {
        type: 'init',
        protocolVersion: USAGE_LEDGER_WORKER_PROTOCOL,
        config: this.resolvedConfig,
        ...(readerSpec === undefined ? {} : { readerSpec }),
        sessions: [...unique.values()],
        liveSessionIds: liveSessions.map(session => session.id),
        cursors: [...this.requireSessions().entries()].map(([sessionId, row]) => ({ sessionId, row })),
        calls: [...this.requireCalls().entries()].map(([key, row]) => ({ key, row })),
      }
      this.status = {
        ...this.status,
        state: readerSpec === undefined ? 'paused' : 'running',
        totalSessions: listed.length,
        updatedAt: new Date().toISOString(),
        ...(readerSpec === undefined ? { lastError: 'session persistence does not expose backgroundReaderSpec; historical backfill is paused' } : {}),
      }
      if (readerSpec === undefined) this.ctx.logger.warn('usage ledger: persistence has no provider-owned background reader; live ledger remains enabled')
      this.worker.start(frame)
    } catch (error: unknown) {
      this.recordFailure(`background worker initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Return committed SQLite data immediately; backfill state is independent. */
  @Remote('snapshot')
  async snapshot(request?: UsageLedgerSnapshotRequest): Promise<UsageLedgerSnapshot> {
    const resolved = resolveSnapshotRequest(request)
    const fromDay = shiftDay(resolved.throughDay, 1 - resolved.days)
    const models = new Map<string, UsageLedgerModelRow>()
    const daily = new Map<string, UsageLedgerDailyRow>()
    const selected: UsageLedgerCallRow[] = []
    for (let offset = 0; offset < resolved.days; offset += 1) {
      const day = shiftDay(fromDay, offset)
      daily.set(day, { day, ...ZERO_TOTALS })
    }
    for (const [, row] of this.requireCalls().entries()) {
      const localDay = zoneDay(row.startedAt, resolved.timeZone)
      if (localDay < fromDay || localDay > resolved.throughDay) continue
      if (resolved.workspace !== null && row.workspace !== resolved.workspace) continue
      selected.push(row)
      const workspace = row.workspace ?? null
      const key = JSON.stringify([workspace, row.provider, row.model])
      const prior = models.get(key) ?? { workspace, provider: row.provider, model: row.model, ...ZERO_TOTALS }
      models.set(key, addAttempt(prior, row))
      const day = daily.get(localDay)
      if (day !== undefined) daily.set(localDay, addAttempt(day, row))
    }
    return Object.freeze({
      workspace: resolved.workspace,
      days: resolved.days,
      fromDay,
      throughDay: resolved.throughDay,
      timeZone: resolved.timeZone,
      updatedAt: new Date().toISOString(),
      events: Object.freeze(projectEvents(selected).map(row => Object.freeze(row))),
      models: Object.freeze([...models.values()].sort(compareModels).map(row => Object.freeze(row))),
      daily: Object.freeze([...daily.values()].map(row => Object.freeze(row))),
    })
  }

  /** Non-blocking worker state for the Usage page. */
  @Remote('status')
  statusSnapshot(): UsageLedgerStatus {
    return Object.freeze({ ...this.status })
  }

  private handleWorkerResponse(frame: WorkerResponseFrame): void {
    switch (frame.type) {
      case 'progress':
        this.status = {
          ...this.status,
          state: frame.status,
          totalSessions: frame.totalSessions,
          processedSessions: frame.processedSessions,
          processedEvents: frame.processedEvents,
          updatedAt: new Date().toISOString(),
          ...(frame.currentSessionId === undefined ? { currentSessionId: undefined } : { currentSessionId: frame.currentSessionId }),
        }
        return
      case 'mutation':
        for (const mutation of frame.mutations) {
          if (mutation.type === 'call-upsert') {
            this.pendingCalls.set(mutation.key, mutation.row)
          } else if (mutation.type === 'cursor-upsert') {
            this.pendingCursors.set(mutation.sessionId, mutation.row)
            this.pendingDeletes.delete(mutation.sessionId)
          } else {
            this.pendingDeletes.set(mutation.sessionId, mutation.createdAt)
            this.pendingCursors.delete(mutation.sessionId)
          }
        }
        this.scheduleWrites()
        return
      case 'checkpoint':
      case 'done':
        return
      case 'error':
        this.recordFailure(frame.sessionId === undefined ? frame.message : `session '${frame.sessionId}': ${frame.message}`)
        return
    }
  }

  private recordFailure(message: string): void {
    this.status = { ...this.status, state: 'failed', lastError: message, updatedAt: new Date().toISOString() }
    this.ctx.logger.warn(`usage ledger: ${message}`)
  }

  private scheduleWrites(): void {
    if (this.writeScheduled || this.writing) return
    this.writeScheduled = true
    setImmediate(() => {
      this.writeScheduled = false
      void this.drainWrites()
    })
  }

  private async drainWrites(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      const calls = this.requireCalls()
      const sessions = this.requireSessions()
      const callBatch = [...this.pendingCalls.entries()].slice(0, 64)
      for (const [key] of callBatch) this.pendingCalls.delete(key)
      for (let index = 0; index < callBatch.length; index += 1) {
        const [key, row] = callBatch[index] as [string, UsageLedgerCallRow]
        try {
          await calls.put(key, row)
        } catch (error: unknown) {
          for (const [remainingKey, remainingRow] of callBatch.slice(index)) this.pendingCalls.set(remainingKey, remainingRow)
          this.recordFailure(`call write failed: ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
      const cursorBatch = [...this.pendingCursors.entries()].slice(0, 64)
      for (const [key] of cursorBatch) this.pendingCursors.delete(key)
      for (let index = 0; index < cursorBatch.length; index += 1) {
        const [key, row] = cursorBatch[index] as [string, UsageLedgerSessionRow]
        try {
          await sessions.put(key as SessionId, row)
        } catch (error: unknown) {
          for (const [remainingKey, remainingRow] of cursorBatch.slice(index)) this.pendingCursors.set(remainingKey, remainingRow)
          this.recordFailure(`cursor write failed: ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
      const deleteBatch = [...this.pendingDeletes.entries()].slice(0, 64)
      for (const [key] of deleteBatch) this.pendingDeletes.delete(key)
      for (let index = 0; index < deleteBatch.length; index += 1) {
        const [key, createdAt] = deleteBatch[index] as [string, number]
        const row = sessions.get(key as SessionId)
        if (row?.createdAt !== createdAt) continue
        try {
          await sessions.delete(key as SessionId)
        } catch (error: unknown) {
          for (const [remainingKey, remainingCreatedAt] of deleteBatch.slice(index)) this.pendingDeletes.set(remainingKey, remainingCreatedAt)
          this.recordFailure(`cursor delete failed: ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
    } finally {
      this.writing = false
    }
    if (this.pendingCalls.size > 0 || this.pendingCursors.size > 0 || this.pendingDeletes.size > 0) {
      if (this.retryTimer === undefined) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined
          this.scheduleWrites()
        }, 250)
      }
    }
  }

  private requireSessions(): KvTable<SessionId, UsageLedgerSessionRow> {
    if (this.sessions === undefined) throw new Error('usage ledger is not initialized')
    return this.sessions
  }

  private requireCalls(): KvTable<string, UsageLedgerCallRow> {
    if (this.calls === undefined) throw new Error('usage ledger is not initialized')
    return this.calls
  }
}

export default UsageLedgerService
