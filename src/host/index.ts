/**
 * Host-side ledger that persists provider attempts and rebuilds usage from session history.
 * @module dsh-plugin-usage-ledger
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
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

/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
export const USAGE_LEDGER_SETTINGS_NAMESPACE = settingsNamespace('usage-ledger')
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

/** Resolve the latest provider/model route recorded before one historical event. */
function routeBefore(session: Session, throughSeq: number): UsageRoute {
  let route: UsageRoute = { provider: 'unknown', model: 'unknown' }
  for (const event of session.events) {
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

    this.ctx.on('session/created', (session) => { this.adopt(session) })
    this.ctx.on('session/event', (session, event) => { this.schedule(session, event.seq) })
    this.ctx.on('session/disposed', (session) => {
      this.enqueue(session, async () => {
        this.cursors.delete(session)
        this.routes.delete(session)
        const row = this.requireSessions().get(session.id)
        if (sameLifecycle(row, session)) await this.requireSessions().delete(session.id)
      })
    })
    this.ctx.on('session/flush', session => this.flushSession(session))
    for (const session of this.ctx.sessions.list()) this.adopt(session)
    this.backfillPromise = this.backfill(this.ctx.sessionPersistence)
  }

  /** Replay cold persisted sessions without publishing them as live sessions. */
  private async backfill(persistence: SessionPersistence): Promise<void> {
    let headers: Awaited<ReturnType<SessionPersistence['list']>>
    try {
      headers = await persistence.list()
    } catch (error: unknown) {
      this.ctx.logger.warn(`usage ledger: historical session listing failed: ${String(error)}`)
      return
    }
    for (const header of headers) {
      if (!this.accepting) return
      const live = this.ctx.sessions.get(header.id)
      if (live !== undefined) {
        this.adopt(live)
        continue
      }
      try {
        const loaded = await persistence.inspect(header.id)
        const historical = Session.create(header.id, loaded.events, loaded.meta)
        this.coldSessions.add(historical)
        try {
          this.adopt(historical)
          await this.flushSession(historical)
        } finally {
          this.coldSessions.delete(historical)
          this.cursors.delete(historical)
          this.routes.delete(historical)
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`usage ledger: historical session '${header.id}' skipped: ${String(error)}`)
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
    await this.backfillPromise
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
    const firstLiveSeq = session.header.seedLength ?? 0
    const startSeq = Math.max(firstLiveSeq, current.observedSeq + 1)
    // Detached Session.create(seed) adds an in-memory seed boundary; cold replay must not advance past persisted events.
    const eventCount = this.coldSessions.has(session) ? session.firstLiveSeq : session.events.length
    let route = this.routes.get(session) ?? routeBefore(session, startSeq)
    for (let seq = startSeq; seq <= throughSeq && seq < eventCount; seq += 1) {
      const event = session.events[seq]
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
      case 'llm/request-attempt':
        return this.processAttempt(session, current, event)
      case 'llm/retry-started':
        return this.markRetry(session, current, event.data.turn, event.data.step)
      case 'assistant/chunk':
        return event.data.chunk.type === 'usage'
          ? this.replaceProvisionalUsage(session, current, event.data.turn, event.data.step, event.data.chunk.usage)
          : current
      case 'assistant/message':
        return this.processAssistantMessage(session, current, event, route)
      default:
        return current
    }
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
      return event.data.usage === undefined
        ? current
        : this.replaceFinalUsage(session, current, event.data.turn, event.data.step, event.data.usage)
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
        outcome: 'success',
        ...event.data.usage === undefined ? {} : { finalUsage: usageOf(event.data.usage) },
      })
    } else if (existing.finalUsage === undefined && event.data.usage !== undefined) {
      await calls.put(key, { ...existing, finalUsage: usageOf(event.data.usage), outcome: 'success' })
    }
    return {
      ...current,
      successfulAttempts: { ...current.successfulAttempts, [stepId]: attemptId },
    }
  }

  /** Create one idempotent call row or record its terminal outcome. */
  private async processAttempt(
    session: Session,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'llm/request-attempt' }>,
  ): Promise<UsageLedgerSessionRow> {
    const { attemptId, turn, step } = event.data
    const key = callKey(session, attemptId)
    const calls = this.requireCalls()
    const stepId = stepKey(turn, step)
    if (event.data.phase === 'start') {
      if (calls.get(key) === undefined) {
        await calls.put(key, {
          sessionId: session.id,
          createdAt: session.header.createdAt,
          ...(session.header.cwd === undefined ? {} : { workspace: session.header.cwd }),
          day: utcDay(event.data.startedAt),
          attemptId,
          startedAt: event.data.startedAt,
          turn,
          step,
          provider: event.data.provider,
          model: event.data.model,
        })
      }
      return {
        ...current,
        activeAttempts: { ...current.activeAttempts, [stepId]: attemptId },
      }
    }
    const row = calls.get(key)
    if (row === undefined) return current
    await calls.put(key, { ...row, outcome: event.data.outcome })
    const activeAttempts = { ...current.activeAttempts }
    Reflect.deleteProperty(activeAttempts, stepId)
    const successfulAttempts = event.data.outcome === 'success'
      ? { ...current.successfulAttempts, [stepId]: attemptId }
      : current.successfulAttempts
    return { ...current, activeAttempts, successfulAttempts }
  }

  /** Mark the failed attempt that a completed retry wait is about to repeat. */
  private async markRetry(
    session: Session,
    current: UsageLedgerSessionRow,
    turn: number,
    step: number,
  ): Promise<UsageLedgerSessionRow> {
    const candidates = [...this.requireCalls().entries()]
      .map(([, row]) => row)
      .filter(row => row.sessionId === session.id
        && row.createdAt === session.header.createdAt
        && row.turn === turn
        && row.step === step
        && (row.outcome === 'failure' || row.outcome === 'aborted')
        && row.retryScheduled !== true)
      .sort((left, right) => left.startedAt - right.startedAt)
    const row = candidates.at(-1)
    if (row !== undefined) {
      await this.requireCalls().put(callKey(session, row.attemptId), { ...row, retryScheduled: true })
    }
    return current
  }

  /** Replace one active attempt's latest provisional stream metering. */
  private async replaceProvisionalUsage(
    session: Session,
    current: UsageLedgerSessionRow,
    turn: number,
    step: number,
    usage: TokenUsage,
  ): Promise<UsageLedgerSessionRow> {
    const attemptId = current.activeAttempts[stepKey(turn, step)]
    if (attemptId === undefined) return current
    const key = callKey(session, attemptId)
    const row = this.requireCalls().get(key)
    if (row !== undefined) await this.requireCalls().put(key, { ...row, provisionalUsage: usageOf(usage) })
    return current
  }

  /** Replace the successful attempt's provisional metering with final message usage. */
  private async replaceFinalUsage(
    session: Session,
    current: UsageLedgerSessionRow,
    turn: number,
    step: number,
    usage: TokenUsage,
  ): Promise<UsageLedgerSessionRow> {
    const attemptId = current.successfulAttempts[stepKey(turn, step)]
    if (attemptId === undefined) return current
    const key = callKey(session, attemptId)
    const row = this.requireCalls().get(key)
    if (row !== undefined) await this.requireCalls().put(key, { ...row, finalUsage: usageOf(usage) })
    return current
  }

  /** Create the initial cursor at the first live sequence after a fork prefix. */
  private emptySessionRow(session: Session): UsageLedgerSessionRow {
    return {
      createdAt: session.header.createdAt,
      ...(session.header.cwd === undefined ? {} : { workspace: session.header.cwd }),
      observedSeq: (session.header.seedLength ?? 0) - 1,
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
