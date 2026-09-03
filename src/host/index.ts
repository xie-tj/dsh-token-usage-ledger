/**
 * Host-side ledger that persists provider attempts and rebuilds usage from session history.
 * @module dsh-plugin-usage-ledger
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { usageLedgerDomainSpec } from './spec.ts'
import type {
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
  UsageLedgerTokenUsage,
} from './spec.ts'
import type {
  UsageLedgerDailyRow,
  UsageLedgerEvent,
  UsageLedgerModelRow,
  UsageLedgerSnapshot,
  UsageLedgerSnapshotRequest,
} from './types.ts'
import { createUsageAttemptId } from './event-types.ts'
import type { UsageAttemptId, UsageSessionEvent } from './event-types.ts'

export type * from './types.ts'
export {
  usageLedgerCallRowSchema,
  usageLedgerDomainSpec,
  usageLedgerSessionRowSchema,
} from './spec.ts'
export type { UsageAttemptId } from './event-types.ts'
export type {
  UsageLedgerAttemptOutcome,
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
  UsageLedgerTokenUsage,
} from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    usageLedger: UsageLedgerService
  }
}

const DEFAULT_DAYS = 30
const MAX_DAYS = 366
const HISTORICAL_READ_BATCH_SIZE = 256

/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
export const USAGE_LEDGER_SETTINGS_NAMESPACE = 'usage-ledger' as const
type UsageLedgerSettings = Readonly<Record<string, never>>
const UsageLedgerSettingsSchema = z.object({}) as unknown as z<UsageLedgerSettings>

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

/** Format an epoch timestamp as its UTC calendar day. */
function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
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
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`usage ledger could not format date in timezone '${timeZone}'`)
  }
  return `${year}-${month}-${day}`
}

/** Return the calendar date `offset` days before `day`. */
function shiftDay(day: string, offset: number): string {
  const instant = new Date(`${day}T00:00:00.000Z`)
  instant.setUTCDate(instant.getUTCDate() + offset)
  return utcDay(instant.getTime())
}

/** Keep untrusted Remote requests within the bounded read this package supports. */
function resolveSnapshotRequest(request: UsageLedgerSnapshotRequest | undefined): ResolvedSnapshotRequest {
  const workspace = request?.workspace ?? null
  const days = request?.days ?? DEFAULT_DAYS
  const timeZone = request?.timeZone ?? 'UTC'
  if (workspace !== null && typeof workspace !== 'string') {
    throw new TypeError('usage ledger workspace must be a string or null')
  }
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new TypeError('usage ledger timeZone must be a non-empty IANA timezone')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new RangeError(`usage ledger timeZone is invalid: '${timeZone}'`)
  }
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new RangeError(`usage ledger days must be a safe integer from 1 through ${MAX_DAYS}`)
  }
  return { workspace, days, throughDay: zoneDay(Date.now(), timeZone), timeZone }
}

/** Stable storage key for one attempt in one exact session lifecycle. */
function callKey(session: Session, attemptId: UsageAttemptId): string {
  return JSON.stringify([session.id, session.header.createdAt, attemptId])
}

/** Stable per-step lookup key stored on the lifecycle cursor. */
function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/** Whether a cursor belongs to the same session lifecycle. */
function sameLifecycle(row: UsageLedgerSessionRow | undefined, session: Session): row is UsageLedgerSessionRow {
  return row !== undefined
    && row.createdAt === session.header.createdAt
    && row.workspace === session.header.cwd
}

/** Copy provider usage into the ledger's complete, JSON-safe counters. */
function usageOf(usage: TokenUsage): UsageLedgerTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

/** Final usage takes precedence over the latest provisional stream sample. */
function usageFor(row: UsageLedgerCallRow): UsageLedgerTokenUsage | undefined {
  return row.finalUsage ?? row.provisionalUsage
}

/** Stable synthetic attempt id for a historical log without request-attempt events. */
function legacyAttemptId(turn: number, step: number): UsageAttemptId {
  return createUsageAttemptId(`legacy:${turn}:${step}`)
}

type UsageRoute = { provider: string; model: string }

type PersistenceRuntime = {
  list(): Promise<unknown>
  open?: (id: SessionId, access: 'read') => Promise<unknown>
  inspect?: (id: SessionId) => Promise<unknown>
}

type HistoricalDescriptor = {
  readonly id: SessionId
  readonly header: Session['header']
}

type HistoricalSession = HistoricalDescriptor & {
  readonly inheritedEventCount: number
  readonly read: (offset?: number, length?: number) => Promise<readonly UsageSessionEvent[]>
  readonly close: () => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validate persistence metadata before it enters the ledger's session model. */
function sessionHeader(value: unknown): Session['header'] {
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
  return value as unknown as Session['header']
}

function inheritedCount(value: unknown, eventCount: number, seeded: boolean): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > eventCount
    || (!seeded && value !== 0)) {
    throw new TypeError('usage ledger received invalid inherited event count')
  }
  return value
}

/** Adapt the two alpha.5 persistence runtimes to one bounded historical reader. */
async function historicalListing(persistence: SessionPersistence): Promise<readonly HistoricalDescriptor[]> {
  const runtime = persistence as unknown as PersistenceRuntime
  const listed = await runtime.list()
  if (!Array.isArray(listed)) throw new TypeError('usage ledger received an invalid session listing')
  return listed.map((entry): HistoricalDescriptor => {
    const record = isRecord(entry) && isRecord(entry.header) ? entry : undefined
    const header = sessionHeader(record === undefined ? entry : record.header)
    return { id: header.id, header }
  })
}

async function openHistorical(persistence: SessionPersistence, descriptor: HistoricalDescriptor): Promise<HistoricalSession> {
  const runtime = persistence as unknown as PersistenceRuntime
  if (typeof runtime.open === 'function') {
    const raw = await runtime.open(descriptor.id, 'read')
    if (!isRecord(raw) || typeof raw.close !== 'function') {
      throw new TypeError('usage ledger received an invalid session read handle')
    }
    const close = async (): Promise<void> => {
      await (raw.close as () => Promise<void>).call(raw)
    }
    let closed = false
    const closeOnce = async (): Promise<void> => {
      if (closed) return
      closed = true
      await close()
    }
    let transferred = false
    try {
      if (typeof raw.read !== 'function') {
        throw new TypeError('usage ledger received an invalid session read handle')
      }
      const read = raw.read as (offset?: number, length?: number) => Promise<unknown>
      const header = sessionHeader(raw.header)
      if (header.id !== descriptor.id) throw new TypeError('usage ledger session metadata id mismatch')
      const cut = inheritedCount(raw.inheritedEventCount, Number.MAX_SAFE_INTEGER, header.isSeeded)
      transferred = true
      return {
        id: descriptor.id,
        header,
        inheritedEventCount: cut,
        read: async (offset = 0, length = HISTORICAL_READ_BATCH_SIZE) => {
          const events = await read.call(raw, offset, length)
          if (!Array.isArray(events)) throw new TypeError('usage ledger received an invalid session event batch')
          return events as UsageSessionEvent[]
        },
        close: closeOnce,
      }
    } finally {
      if (!transferred) await closeOnce()
    }
  }
  if (typeof runtime.inspect !== 'function') throw new TypeError('usage ledger persistence has no historical reader')
  const raw = await runtime.inspect(descriptor.id)
  if (!isRecord(raw) || !('meta' in raw) || !Array.isArray(raw.events)) {
    throw new TypeError('usage ledger received an invalid session inspection')
  }
  const events = raw.events as readonly unknown[]
  const header = sessionHeader(raw.meta)
  if (header.id !== descriptor.id) throw new TypeError('usage ledger session metadata id mismatch')
  const cut = inheritedCount(raw.inheritedEventCount, events.length, header.isSeeded)
  return {
    id: descriptor.id,
    header,
    inheritedEventCount: cut,
    read: async (offset = 0, length = HISTORICAL_READ_BATCH_SIZE) => events.slice(offset, offset + length) as UsageSessionEvent[],
    close: async () => {},
  }
}

/** Resolve the latest provider/model route recorded before one historical event. */
function routeBefore(session: Session, throughSeq: number): UsageRoute {
  let route: UsageRoute = { provider: 'unknown', model: 'unknown' }
  for (const event of session.snapshotEvents()) {
    if (event.seq >= throughSeq) break
    route = routeAfter(route, event)
  }
  return route
}

/** Advance a historical provider/model route when a request event records one. */
function routeAfter(route: UsageRoute, event: UsageSessionEvent): UsageRoute {
  if (event.type === 'request/header') return {
    provider: event.data.header.config.provider,
    model: event.data.header.config.model,
  }
  if (event.type === 'request/context') return { provider: event.data.provider, model: event.data.model }
  return route
}

/** Host service that persists each final, failed, aborted, and retried provider call. */
export class UsageLedgerService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessions', 'sessionPersistence']

  private sessions?: KvTable<SessionId, UsageLedgerSessionRow>
  private calls?: KvTable<string, UsageLedgerCallRow>
  private readonly cursors = new Map<Session, UsageLedgerSessionRow>()
  private readonly routes = new Map<Session, UsageRoute>()
  private readonly coldSessions = new Set<Session>()
  private readonly tails = new Map<Session, Promise<void>>()
  private readonly pendingThrough = new Map<Session, number>()
  private readonly scheduled = new Set<Session>()
  private backfillPromise?: Promise<void>
  private accepting = true

  constructor(ctx: Context) {
    super(ctx, 'usageLedger', { namespace: 'usageLedgerPlugin' })
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(USAGE_LEDGER_SETTINGS_NAMESPACE, UsageLedgerSettingsSchema)
    })
  }

  /** Open the ledger and attach lifecycle-bound post-append observers. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(usageLedgerDomainSpec)
    this.sessions = domain.table('sessions')
    this.calls = domain.table('calls')
    this.ctx.effect(() => async () => {
      this.accepting = false
      await this.backfillPromise
      await this.drainTails()
      await this.persistCursors()
      await domain.close()
    }, 'usage-ledger.domain-close')

    this.ctx.on('session/created', (session) => { this.adopt(session) }, { global: true })
    this.ctx.on('session/event', (session, event) => { this.schedule(session, event.seq) }, { global: true })
    this.ctx.on('session/disposed', (session) => {
      this.enqueue(session, async () => {
        this.cursors.delete(session)
        this.routes.delete(session)
        const row = this.requireSessions().get(session.id)
        if (sameLifecycle(row, session)) await this.requireSessions().delete(session.id)
      })
    }, { global: true })
    this.ctx.on('session/flush', session => this.flushSession(session), { global: true })
    for (const session of this.ctx.sessions.list()) this.adopt(session)
    this.backfillPromise = this.backfill(this.ctx.sessionPersistence)
  }

  /** Replay cold persisted sessions without publishing them as live sessions. */
  private async backfill(persistence: SessionPersistence): Promise<void> {
    let snapshots: readonly HistoricalDescriptor[]
    try {
      snapshots = await historicalListing(persistence)
    } catch (error: unknown) {
      this.ctx.logger.warn(`usage ledger: historical session listing failed: ${String(error)}`)
      return
    }
    for (const snapshot of snapshots) {
      if (!this.accepting) return
      const id = snapshot.id
      const live = this.ctx.sessions.get(id)
      if (live !== undefined) {
        this.adopt(live)
        continue
      }
      try {
        const handle = await openHistorical(persistence, snapshot)
        try {
          const liveAfterOpen = this.ctx.sessions.get(id)
          if (liveAfterOpen !== undefined) {
            this.adopt(liveAfterOpen)
            continue
          }
          // Read in bounded batches. A cold session is represented locally while
          // its events are folded, so the complete persisted log is never retained.
          const historical = { id, header: handle.header, inheritedEventCount: handle.inheritedEventCount } as Session
          this.coldSessions.add(historical)
          try {
            const stored = this.requireSessions().get(id)
            let current = sameLifecycle(stored, historical) ? stored : this.emptySessionRow(historical)
            let route = this.routes.get(historical) ?? { provider: 'unknown', model: 'unknown' }
            let offset = 0
            while (this.accepting) {
              const events = await handle.read(offset, HISTORICAL_READ_BATCH_SIZE)
              if (events.length === 0) {
                if (handle.inheritedEventCount > offset) {
                  throw new TypeError('usage ledger inherited event count exceeds the persisted event stream')
                }
                break
              }
              if (events.length > HISTORICAL_READ_BATCH_SIZE) {
                throw new TypeError('usage ledger received an oversized session event batch')
              }
              for (const event of events) {
                if (!Number.isSafeInteger(event.seq) || event.seq !== offset) {
                  throw new TypeError('usage ledger received a non-sequential session event stream')
                }
                route = routeAfter(route, event)
                if (event.seq >= handle.inheritedEventCount && event.seq > current.observedSeq) {
                  current = { ...await this.processEvent(historical, current, event, route), observedSeq: event.seq }
                }
                offset += 1
              }
            }
            this.routes.set(historical, route)
            if (current.observedSeq >= 0) this.cursors.set(historical, current)
            await this.flushSession(historical)
          } finally {
            this.coldSessions.delete(historical)
            this.cursors.delete(historical)
            this.routes.delete(historical)
          }
        } finally {
          await handle.close()
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`usage ledger: historical session '${id}' skipped: ${String(error)}`)
      }
    }
    await this.drainTails()
    await this.persistCursors()
  }

  /**
   * Return a bounded, read-only summary derived from idempotent call records.
   * @param request - optional workspace, calendar-day, and timezone filters.
   * @returns the usage snapshot after all queued session events are applied.
   */
  @Remote('snapshot')
  async snapshot(request?: UsageLedgerSnapshotRequest): Promise<UsageLedgerSnapshot> {
    if (this.backfillPromise === undefined) this.backfillPromise = this.backfill(this.ctx.sessionPersistence)
    for (const session of this.ctx.sessions.list()) this.adopt(session)
    await this.drainTails()
    const resolved = resolveSnapshotRequest(request)
    const fromDay = shiftDay(resolved.throughDay, 1 - resolved.days)
    const models = new Map<string, UsageLedgerModelRow>()
    const daily = new Map<string, UsageLedgerDailyRow>()
    const selected: UsageLedgerCallRow[] = []
    for (let offset = 0; offset < resolved.days; offset++) {
      const day = shiftDay(fromDay, offset)
      daily.set(day, { day, ...ZERO_TOTALS })
    }
    for (const [, row] of this.requireCalls().entries()) {
      const localDay = zoneDay(row.startedAt, resolved.timeZone)
      if (localDay < fromDay || localDay > resolved.throughDay) continue
      if (resolved.workspace !== null && row.workspace !== resolved.workspace) continue
      selected.push(row)
      const workspace = row.workspace ?? null
      const modelKey = JSON.stringify([workspace, row.provider, row.model])
      const prior = models.get(modelKey) ?? {
        workspace,
        provider: row.provider,
        model: row.model,
        ...ZERO_TOTALS,
      }
      const nextModel = addAttempt(prior, row)
      models.set(modelKey, nextModel)
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

  /** Replay a session tail after startup or HMR, excluding a fork's inherited prefix. */
  private adopt(session: Session): void {
    this.schedule(session, Number.MAX_SAFE_INTEGER)
  }

  /** Coalesce committed events into one ordered replay; defer the cursor to flush. */
  private schedule(session: Session, throughSeq: number): void {
    if (!this.accepting) return
    const pending = this.pendingThrough.get(session)
    if (pending === undefined || throughSeq > pending) this.pendingThrough.set(session, throughSeq)
    if (this.scheduled.has(session)) return
    this.scheduled.add(session)
    this.enqueue(session, async () => {
      this.scheduled.delete(session)
      const target = this.pendingThrough.get(session)
      if (target === undefined) return
      try {
        await this.processThrough(session, target)
        if (this.pendingThrough.get(session) === target) this.pendingThrough.delete(session)
      } finally {
        const next = this.pendingThrough.get(session)
        if (next !== undefined && this.accepting) this.schedule(session, next)
      }
    })
  }

  /** Wait until all work already observed for one session has been processed. */
  private async waitForSession(session: Session): Promise<void> {
    while (true) {
      const tail = this.tails.get(session)
      if (tail === undefined) {
        const pending = this.pendingThrough.get(session)
        if (pending === undefined) return
        this.schedule(session, pending)
        continue
      }
      await tail
      if (this.tails.get(session) === tail && !this.pendingThrough.has(session)) return
    }
  }

  /** Persist one session cursor at its durable session checkpoint. */
  private async flushSession(session: Session): Promise<void> {
    await this.waitForSession(session)
    const cursor = this.cursors.get(session)
    if (cursor === undefined) return
    try {
      await this.requireSessions().put(session.id, cursor)
    } catch (error: unknown) {
      this.ctx.logger.warn(`usage ledger: session '${session.id}' cursor flush failed: ${String(error)}`)
    }
  }

  /** Persist all cursors before the ledger domain closes. */
  private async persistCursors(): Promise<void> {
    for (const [session, cursor] of this.cursors) {
      try {
        await this.requireSessions().put(session.id, cursor)
      } catch (error: unknown) {
        this.ctx.logger.warn(`usage ledger: session '${session.id}' cursor close flush failed: ${String(error)}`)
      }
    }
  }

  /** Drain all session queues before closing the ledger domain. */
  private async drainTails(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()])
  }

  /** Process every missing committed event through one ordered session sequence. */
  private async processThrough(session: Session, throughSeq: number): Promise<void> {
    const sessions = this.requireSessions()
    const stored = this.cursors.get(session) ?? sessions.get(session.id)
    const initial = sameLifecycle(stored, session) ? stored : this.emptySessionRow(session)
    let current = initial
    const inheritedEventCount = session.inheritedEventCount
    const startSeq = this.coldSessions.has(session)
      ? current.observedSeq + 1
      : Math.max(inheritedEventCount, current.observedSeq + 1)
    // Detached Session.create(seed) adds an in-memory seed boundary; cold replay reads the persisted prefix.
    const events = session.snapshotEvents()
    const eventCount = this.coldSessions.has(session) ? session.firstLiveSeq : events.length
    let route = this.routes.get(session) ?? routeBefore(session, startSeq)
    for (let seq = startSeq; seq <= throughSeq && seq < eventCount; seq += 1) {
      const event = events[seq]
      if (event === undefined) continue
      route = routeAfter(route, event)
      current = { ...await this.processEvent(session, current, event, route), observedSeq: event.seq }
    }
    this.routes.set(session, route)
    if (current.observedSeq !== initial.observedSeq) this.cursors.set(session, current)
  }

  /** Apply one committed event without persisting the cursor between events. */
  private async processEvent(
    session: Session,
    current: UsageLedgerSessionRow,
    event: UsageSessionEvent,
    route: UsageRoute,
  ): Promise<UsageLedgerSessionRow> {
    switch (event.type) {
      case 'llm/retry-started': {
        return await this.createAttempt(session, current, event.data.turn, event.data.step, event.time, route, `retry:${String(event.data.retryId)}:${event.data.retry}`)
      }
      case 'step/start':
        return this.createAttempt(session, current, event.data.turn, event.data.step, event.time, route, `step:${event.data.turn}:${event.data.step}`)
      case 'request/header':
      case 'request/context':
        return this.updateActiveRoute(session, current, route)
      case 'turn/end':
        if (event.data.reason.kind === 'error' || event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted') {
          return this.terminateActive(session, current, event.data.turn, event.data.reason.kind === 'error' ? 'failure' : 'aborted')
        }
        return current
      case 'llm/retry':
        return this.processRetry(session, current, event)
      case 'assistant/chunk':
        if (event.data.chunk.type === 'usage') {
          return this.recordProvisionalUsage(session, current, event, route, event.data.chunk.usage)
        }
        if (event.data.chunk.type === 'finish') {
          return this.recordFinish(session, current, event, route, event.data.chunk.reason.kind)
        }
        return current
      case 'assistant/message':
        return this.processAssistantMessage(session, current, event, route)
      default:
        return current
    }
  }

  /** Record the terminal result of the official provider stream. */
  private async recordFinish(
    session: Session,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'assistant/chunk' }>,
    _route: UsageRoute,
    kind: string,
  ): Promise<UsageLedgerSessionRow> {
    const attemptId = current.activeAttempts[stepKey(event.data.turn, event.data.step)]
    if (attemptId === undefined) return current
    const key = callKey(session, attemptId)
    const row = this.requireCalls().get(key)
    if (row === undefined) return current
    let outcome: UsageLedgerCallRow['outcome']
    switch (kind) {
      case 'error': outcome = 'failure'; break
      case 'aborted': outcome = 'aborted'; break
      case 'stop':
      case 'tool-calls':
      case 'max-tokens': outcome = 'success'; break
      default: return current
    }
    if (row.outcome === undefined) await this.requireCalls().put(key, { ...row, outcome })
    return current
  }
  /** Attach final or legacy historical usage to the step's successful attempt. */
  private async processAssistantMessage(
    session: Session,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'assistant/message' }>,
    route: UsageRoute,
  ): Promise<UsageLedgerSessionRow> {
    const stepId = stepKey(event.data.turn, event.data.step)
    const existingAttemptId = current.successfulAttempts[stepId] ?? current.activeAttempts[stepId]
    if (existingAttemptId !== undefined) {
      const next = event.data.usage === undefined
        ? current
        : await this.replaceFinalUsage(session, current, event.data.turn, event.data.step, event.data.usage)
      const activeAttempts = { ...next.activeAttempts }
      Reflect.deleteProperty(activeAttempts, stepId)
      const existing = this.requireCalls().get(callKey(session, existingAttemptId))
      const outcome = existing?.outcome ?? (event.data.interrupted === true ? 'aborted' : 'success')
      if (existing !== undefined && existing.outcome !== outcome) {
        await this.requireCalls().put(callKey(session, existingAttemptId), { ...existing, outcome })
      }
      return {
        ...next,
        activeAttempts,
        successfulAttempts: { ...next.successfulAttempts, [stepId]: existingAttemptId },
      }
    }

    const attemptId = legacyAttemptId(event.data.turn, event.data.step)
    const key = callKey(session, attemptId)
    const calls = this.requireCalls()
    const existing = calls.get(key)
    if (existing === undefined) {
      await calls.put(key, {
        sessionId: session.id,
        createdAt: session.header.createdAt,
        ...(session.header.cwd === undefined ? {} : { workspace: session.header.cwd }),
        day: utcDay(event.time),
        attemptId,
        turn: event.data.turn,
        step: event.data.step,
        provider: route.provider,
        model: route.model,
        startedAt: event.time,
        outcome: event.data.interrupted === true ? 'aborted' : 'success',
        ...event.data.usage === undefined ? {} : { finalUsage: usageOf(event.data.usage) },
      })
    } else if (existing.finalUsage === undefined && event.data.usage !== undefined) {
      await calls.put(key, { ...existing, finalUsage: usageOf(event.data.usage), outcome: existing.outcome ?? 'success' })
    }
    return {
      ...current,
      successfulAttempts: event.data.interrupted === true
        ? current.successfulAttempts
        : { ...current.successfulAttempts, [stepId]: attemptId },
    }
  }

  /** Create one idempotent unmetered row for the first event of a provider dispatch. */
  private async createAttempt(
    session: Session,
    current: UsageLedgerSessionRow,
    turn: number,
    step: number,
    startedAt: number,
    route: UsageRoute,
    seed: string,
  ): Promise<UsageLedgerSessionRow> {
    const stepId = stepKey(turn, step)
    const attemptId = createUsageAttemptId(seed)
    const key = callKey(session, attemptId)
    if (this.requireCalls().get(key) === undefined) {
      await this.requireCalls().put(key, {
        sessionId: session.id,
        createdAt: session.header.createdAt,
        ...(session.header.cwd === undefined ? {} : { workspace: session.header.cwd }),
        day: utcDay(startedAt), attemptId, turn, step,
        provider: route.provider, model: route.model, startedAt,
      })
    }
    return { ...current, activeAttempts: { ...current.activeAttempts, [stepId]: attemptId } }
  }

  /** Apply the route discovered after dispatch creation to its active row. */
  private async updateActiveRoute(
    session: Session,
    current: UsageLedgerSessionRow,
    route: UsageRoute,
  ): Promise<UsageLedgerSessionRow> {
    for (const attemptId of Object.values(current.activeAttempts)) {
      const key = callKey(session, attemptId)
      const row = this.requireCalls().get(key)
      if (row !== undefined && (row.provider !== route.provider || row.model !== route.model)) {
        await this.requireCalls().put(key, { ...row, provider: route.provider, model: route.model })
      }
    }
    return current
  }

  /** Terminate only unresolved attempts in the ended turn. */
  private async terminateActive(
    session: Session,
    current: UsageLedgerSessionRow,
    turn: number,
    outcome: 'failure' | 'aborted',
  ): Promise<UsageLedgerSessionRow> {
    for (const [stepId, attemptId] of Object.entries(current.activeAttempts)) {
      const row = this.requireCalls().get(callKey(session, attemptId))
      if (row === undefined || row.turn !== turn) continue
      if (row.outcome === undefined) {
        await this.requireCalls().put(callKey(session, attemptId), { ...row, outcome })
      }
      const activeAttempts = { ...current.activeAttempts }
      Reflect.deleteProperty(activeAttempts, stepId)
      current = { ...current, activeAttempts }
    }
    return current
  }
  /** Mark a known failed provider request when the official retry event schedules another dispatch. */
  private async processRetry(
    session: Session,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'llm/retry' }>,
  ): Promise<UsageLedgerSessionRow> {
    const stepId = stepKey(event.data.turn, event.data.step)
    const activeAttemptId = current.activeAttempts[stepId]
    if (activeAttemptId === undefined) return current
    const key = callKey(session, activeAttemptId)
    const row = this.requireCalls().get(key)
    if (row !== undefined) {
      await this.requireCalls().put(key, { ...row, ...(row.outcome === undefined ? { outcome: 'failure' as const } : {}), retryScheduled: true })
    }
    return current
  }

  /** Record official usage from an assistant stream chunk. */
  private async recordProvisionalUsage(
    session: Session,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'assistant/chunk' }>,
    route: UsageRoute,
    usage: TokenUsage,
  ): Promise<UsageLedgerSessionRow> {
    const stepId = stepKey(event.data.turn, event.data.step)
    const attemptId = current.activeAttempts[stepId] ?? createUsageAttemptId(`stream:${event.data.turn}:${event.data.step}:${event.seq}`)
    const key = callKey(session, attemptId)
    const calls = this.requireCalls()
    const row = calls.get(key)
    if (row === undefined) {
      await calls.put(key, {
        sessionId: session.id,
        createdAt: session.header.createdAt,
        ...(session.header.cwd === undefined ? {} : { workspace: session.header.cwd }),
        day: utcDay(event.time), attemptId, turn: event.data.turn, step: event.data.step,
        provider: route.provider, model: route.model, startedAt: event.time,
        provisionalUsage: usageOf(usage),
      })
    } else {
      await calls.put(key, { ...row, provisionalUsage: usageOf(usage) })
    }
    return { ...current, activeAttempts: { ...current.activeAttempts, [stepId]: attemptId } }
  }

  /** Replace the successful attempt's provisional metering with final message usage. */
  private async replaceFinalUsage(
    session: Session,
    current: UsageLedgerSessionRow,
    turn: number,
    step: number,
    usage: TokenUsage,
  ): Promise<UsageLedgerSessionRow> {
    const attemptId = current.successfulAttempts[stepKey(turn, step)] ?? current.activeAttempts[stepKey(turn, step)]
    if (attemptId === undefined) return current
    const key = callKey(session, attemptId)
    const row = this.requireCalls().get(key)
    if (row !== undefined) await this.requireCalls().put(key, { ...row, finalUsage: usageOf(usage) })
    return current
  }

  /** Create the initial cursor immediately before this session's owned event suffix. */
  private emptySessionRow(session: Session): UsageLedgerSessionRow {
    return {
      createdAt: session.header.createdAt,
      ...(session.header.cwd === undefined ? {} : { workspace: session.header.cwd }),
      observedSeq: this.coldSessions.has(session) ? -1 : session.inheritedEventCount - 1,
      activeAttempts: {},
      successfulAttempts: {},
    }
  }

  /** Serialize one session's best-effort observer work without delaying append. */
  private enqueue(session: Session, operation: () => Promise<void>): void {
    if (!this.accepting) return
    const prior = this.tails.get(session) ?? Promise.resolve()
    const tail = prior.then(operation).catch((error: unknown) => {
      this.ctx.logger.warn(`usage ledger: session '${session.id}' update failed: ${String(error)}`)
    })
    this.tails.set(session, tail)
    void tail.then(() => {
      if (this.tails.get(session) === tail) this.tails.delete(session)
    })
  }

  /** Return the opened lifecycle-cursor table. */
  private requireSessions(): KvTable<SessionId, UsageLedgerSessionRow> {
    if (this.sessions === undefined) throw new Error('usage ledger is not initialized')
    return this.sessions
  }

  /** Return the opened idempotent provider-call table. */
  private requireCalls(): KvTable<string, UsageLedgerCallRow> {
    if (this.calls === undefined) throw new Error('usage ledger is not initialized')
    return this.calls
  }
}

/** Project persisted call rows into the small browser event vocabulary. */
function projectEvents(rows: readonly UsageLedgerCallRow[]): UsageLedgerEvent[] {
  return [...rows]
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((row) => {
      const usage = usageFor(row)
      return {
        at: row.startedAt,
        workspace: row.workspace ?? null,
        provider: row.provider,
        model: row.model,
        outcome: row.outcome ?? 'started',
        retried: row.retryScheduled === true,
        ...usage === undefined ? {} : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
      }
    })
}

/** Add one request attempt and its current known usage to an aggregate row. */
function addAttempt<T extends UsageLedgerModelRow | UsageLedgerDailyRow>(row: T, call: UsageLedgerCallRow): T {
  const usage = usageFor(call)
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

/** Sort grouped model rows into deterministic Remote output. */
function compareModels(left: UsageLedgerModelRow, right: UsageLedgerModelRow): number {
  return (left.workspace ?? '').localeCompare(right.workspace ?? '')
    || left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model)
}

export default UsageLedgerService
