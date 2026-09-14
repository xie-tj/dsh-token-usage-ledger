/** Pure bounded reducer used by the isolated Usage Ledger worker. */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import { createUsageAttemptId } from './event-types.ts'
import type { UsageAttemptId, UsageSessionEvent } from './event-types.ts'
import type {
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
  UsageLedgerTokenUsage,
} from './spec.ts'

/** Minimal session identity carried across the worker boundary. */
export interface LedgerSession {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly inheritedEventCount: number
}

/** One idempotent record change committed by the worker's SQLite transaction. */
export type LedgerMutation =
  | { readonly type: 'call-upsert'; readonly key: string; readonly row: UsageLedgerCallRow }
  | { readonly type: 'cursor-upsert'; readonly sessionId: string; readonly row: UsageLedgerSessionRow }
  | { readonly type: 'cursor-delete'; readonly sessionId: string; readonly createdAt: number }

/** State loaded only for the session currently being reduced. */
export interface LedgerReducerSeed {
  readonly cursor?: UsageLedgerSessionRow | undefined
  readonly calls?: readonly { readonly key: string; readonly row: UsageLedgerCallRow }[] | undefined
}

type UsageRoute = { readonly provider: string; readonly model: string }
type MutationSink = (mutation: LedgerMutation) => void

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function usageOf(usage: TokenUsage): UsageLedgerTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

function callKey(session: LedgerSession, attemptId: UsageAttemptId): string {
  return JSON.stringify([session.id, session.createdAt, attemptId])
}

function legacyAttemptId(turn: number, step: number): UsageAttemptId {
  return createUsageAttemptId(`legacy:${turn}:${step}`)
}

function sameLifecycle(row: UsageLedgerSessionRow | undefined, session: LedgerSession): row is UsageLedgerSessionRow {
  return row !== undefined && row.createdAt === session.createdAt && row.workspace === session.cwd
}

function routeAfter(route: UsageRoute, event: UsageSessionEvent): UsageRoute {
  if (event.type === 'request/header') {
    const data = event.data as { header: { config: { provider: string; model: string } } }
    return { provider: data.header.config.provider, model: data.header.config.model }
  }
  if (event.type === 'request/context') return { provider: event.data.provider, model: event.data.model }
  return route
}

/**
 * Fold one session at a time. The reducer retains only active attempts, so a
 * multi-year ledger never becomes a worker heap.
 */
export class UsageLedgerReducer {
  private readonly calls = new Map<string, UsageLedgerCallRow>()
  private cursorRow: UsageLedgerSessionRow | undefined

  constructor(
    seed: LedgerReducerSeed = {},
    private readonly maxActiveAttempts = 256,
  ) {
    this.cursorRow = seed.cursor
    if (Object.keys(seed.cursor?.activeAttempts ?? {}).length > maxActiveAttempts) {
      throw new Error('usage ledger session active attempt count exceeds workerMaxActiveAttempts')
    }
    for (const entry of seed.calls ?? []) this.calls.set(entry.key, entry.row)
  }

  /** Return the cursor for the session currently loaded into this reducer. */
  cursor(session: LedgerSession): UsageLedgerSessionRow | undefined {
    return sameLifecycle(this.cursorRow, session) ? this.cursorRow : undefined
  }

  /** Return the first sequence that needs replay for this session lifecycle. */
  resumeSeq(session: LedgerSession): number {
    const stored = this.cursor(session)
    if (stored === undefined) return session.inheritedEventCount
    return Math.max(session.inheritedEventCount, stored.observedSeq + 1)
  }

  /** Apply one bounded event batch and return durable call/cursor changes. */
  applyBatch(session: LedgerSession, events: readonly UsageSessionEvent[]): readonly LedgerMutation[] {
    const mutations: LedgerMutation[] = []
    const sink: MutationSink = mutation => { mutations.push(mutation) }
    let current = this.cursor(session) ?? this.emptySessionRow(session)
    let route: UsageRoute = current.route ?? { provider: 'unknown', model: 'unknown' }
    const previousObserved = current.observedSeq

    for (const event of events) {
      if (event.seq < session.inheritedEventCount || event.seq <= current.observedSeq) continue
      route = routeAfter(route, event)
      current = {
        ...this.processEvent(session, current, event, route, sink),
        observedSeq: event.seq,
        route,
      }
    }
    if (current.observedSeq !== previousObserved) {
      this.cursorRow = current
      sink({ type: 'cursor-upsert', sessionId: session.id, row: current })
    }
    return mutations
  }

  /** Discard transient in-memory state after a live lifecycle is disposed. */
  dispose(): void {
    this.calls.clear()
  }

  private emptySessionRow(session: LedgerSession): UsageLedgerSessionRow {
    return {
      createdAt: session.createdAt,
      ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
      observedSeq: session.inheritedEventCount - 1,
      activeAttempts: {},
    }
  }

  private processEvent(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    event: UsageSessionEvent,
    route: UsageRoute,
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    switch (event.type) {
      case 'llm/request-attempt':
        return event.data.phase === 'start'
          ? this.createAttempt(session, current, event.data.turn, event.data.step, event.data.startedAt, event.data.provider, event.data.model, event.data.attemptId, sink)
          : this.endAttempt(session, current, event.data.attemptId, event.data.outcome, sink)
      case 'llm/retry-started':
        return this.createAttempt(
          session,
          current,
          event.data.turn,
          event.data.step,
          event.time,
          route.provider,
          route.model,
          createUsageAttemptId(`retry:${String(event.data.retryId)}:${event.data.retry}`),
          sink,
        )
      case 'step/start':
        return this.createAttempt(
          session,
          current,
          event.data.turn,
          event.data.step,
          event.time,
          route.provider,
          route.model,
          createUsageAttemptId(`step:${event.data.turn}:${event.data.step}`),
          sink,
        )
      case 'request/header':
      case 'request/context':
        return this.updateActiveRoute(session, current, route, sink)
      case 'turn/end':
        return event.data.reason.kind === 'error'
          ? this.terminateActive(session, current, event.data.turn, 'failure', sink)
          : event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted'
            ? this.terminateActive(session, current, event.data.turn, 'aborted', sink)
            : current
      case 'llm/retry':
        return this.processRetry(session, current, event, sink)
      case 'assistant/chunk':
        if (event.data.chunk.type === 'usage') {
          return this.recordProvisionalUsage(session, current, event, route, event.data.chunk.usage, sink)
        }
        if (event.data.chunk.type === 'finish') {
          return this.recordFinish(session, current, event, event.data.chunk.reason.kind, sink)
        }
        return current
      case 'assistant/message':
        return this.processAssistantMessage(session, current, event, route, sink)
      default:
        return current
    }
  }

  private putCall(key: string, row: UsageLedgerCallRow, sink: MutationSink): void {
    this.calls.set(key, row)
    sink({ type: 'call-upsert', key, row })
  }

  private removeCall(session: LedgerSession, attemptId: UsageAttemptId): void {
    this.calls.delete(callKey(session, attemptId))
  }

  private createAttempt(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    turn: number,
    step: number,
    startedAt: number,
    provider: string,
    model: string,
    attemptId: UsageAttemptId,
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    const stepId = stepKey(turn, step)
    const priorAttempt = current.activeAttempts[stepId]
    if (priorAttempt === undefined && Object.keys(current.activeAttempts).length >= this.maxActiveAttempts) {
      throw new Error('usage ledger session active attempt count exceeds workerMaxActiveAttempts')
    }
    if (priorAttempt !== undefined && priorAttempt !== attemptId) this.removeCall(session, priorAttempt)
    const key = callKey(session, attemptId)
    if (this.calls.get(key) === undefined) {
      this.putCall(key, {
        sessionId: session.id,
        createdAt: session.createdAt,
        ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
        day: new Date(startedAt).toISOString().slice(0, 10),
        attemptId,
        turn,
        step,
        provider,
        model,
        startedAt,
      }, sink)
    }
    return { ...current, activeAttempts: { ...current.activeAttempts, [stepId]: attemptId } }
  }

  private endAttempt(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    attemptId: UsageAttemptId,
    outcome: UsageLedgerCallRow['outcome'],
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    const key = callKey(session, attemptId)
    const row = this.calls.get(key)
    if (row !== undefined && row.outcome !== outcome) this.putCall(key, { ...row, outcome }, sink)
    const activeAttempts = { ...current.activeAttempts }
    for (const [step, active] of Object.entries(activeAttempts)) {
      if (active === attemptId) Reflect.deleteProperty(activeAttempts, step)
    }
    this.removeCall(session, attemptId)
    return { ...current, activeAttempts }
  }

  private updateActiveRoute(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    route: UsageRoute,
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    for (const attemptId of Object.values(current.activeAttempts)) {
      const key = callKey(session, attemptId)
      const row = this.calls.get(key)
      if (row !== undefined && (row.provider !== route.provider || row.model !== route.model)) {
        this.putCall(key, { ...row, provider: route.provider, model: route.model }, sink)
      }
    }
    return current
  }

  private recordFinish(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'assistant/chunk' }>,
    kind: string,
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    const attemptId = current.activeAttempts[stepKey(event.data.turn, event.data.step)]
    if (attemptId === undefined) return current
    const key = callKey(session, attemptId)
    const row = this.calls.get(key)
    if (row === undefined || row.outcome !== undefined) return current
    const outcome = kind === 'error'
      ? 'failure'
      : kind === 'aborted'
        ? 'aborted'
        : kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens'
          ? 'success'
          : undefined
    if (outcome !== undefined) this.putCall(key, { ...row, outcome }, sink)
    return current
  }

  private processAssistantMessage(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'assistant/message' }>,
    route: UsageRoute,
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    const data = event.data as { turn: number; step: number; usage?: TokenUsage; interrupted?: true }
    const step = stepKey(data.turn, data.step)
    const attemptId = current.activeAttempts[step]
    if (attemptId !== undefined) {
      const key = callKey(session, attemptId)
      const existing = this.calls.get(key)
      const row = existing ?? {
        sessionId: session.id,
        createdAt: session.createdAt,
        ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
        day: new Date(event.time).toISOString().slice(0, 10),
        attemptId,
        turn: data.turn,
        step: data.step,
        provider: route.provider,
        model: route.model,
        startedAt: event.time,
      }
      this.putCall(key, {
        ...row,
        ...(data.usage === undefined ? {} : { finalUsage: usageOf(data.usage) }),
        outcome: row.outcome ?? (data.interrupted === true ? 'aborted' : 'success'),
      }, sink)
      const activeAttempts = { ...current.activeAttempts }
      Reflect.deleteProperty(activeAttempts, step)
      this.removeCall(session, attemptId)
      return { ...current, activeAttempts }
    }

    const legacy = legacyAttemptId(data.turn, data.step)
    const key = callKey(session, legacy)
    this.putCall(key, {
      sessionId: session.id,
      createdAt: session.createdAt,
      ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
      day: new Date(event.time).toISOString().slice(0, 10),
      attemptId: legacy,
      turn: data.turn,
      step: data.step,
      provider: route.provider,
      model: route.model,
      startedAt: event.time,
      outcome: data.interrupted === true ? 'aborted' : 'success',
      ...(data.usage === undefined ? {} : { finalUsage: usageOf(data.usage) }),
    }, sink)
    this.removeCall(session, legacy)
    return current
  }

  private recordProvisionalUsage(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'assistant/chunk' }>,
    route: UsageRoute,
    usage: TokenUsage,
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    const step = stepKey(event.data.turn, event.data.step)
    const attemptId = current.activeAttempts[step] ?? createUsageAttemptId(`stream:${event.data.turn}:${event.data.step}:${event.seq}`)
    const key = callKey(session, attemptId)
    const existing = this.calls.get(key)
    const row = existing ?? {
      sessionId: session.id,
      createdAt: session.createdAt,
      ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
      day: new Date(event.time).toISOString().slice(0, 10),
      attemptId,
      turn: event.data.turn,
      step: event.data.step,
      provider: route.provider,
      model: route.model,
      startedAt: event.time,
    }
    this.putCall(key, { ...row, provisionalUsage: usageOf(usage) }, sink)
    return { ...current, activeAttempts: { ...current.activeAttempts, [step]: attemptId } }
  }

  private processRetry(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    event: Extract<UsageSessionEvent, { type: 'llm/retry' }>,
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    const attemptId = current.activeAttempts[stepKey(event.data.turn, event.data.step)]
    if (attemptId === undefined) return current
    const key = callKey(session, attemptId)
    const row = this.calls.get(key)
    if (row !== undefined) {
      this.putCall(key, {
        ...row,
        ...(row.outcome === undefined ? { outcome: 'failure' as const } : {}),
        retryScheduled: true,
      }, sink)
    }
    return current
  }

  private terminateActive(
    session: LedgerSession,
    current: UsageLedgerSessionRow,
    turn: number,
    outcome: 'failure' | 'aborted',
    sink: MutationSink,
  ): UsageLedgerSessionRow {
    const activeAttempts = { ...current.activeAttempts }
    for (const [step, attemptId] of Object.entries(activeAttempts)) {
      if (!step.startsWith(`${String(turn)}:`)) continue
      const key = callKey(session, attemptId)
      const row = this.calls.get(key)
      if (row !== undefined && row.outcome === undefined) this.putCall(key, { ...row, outcome }, sink)
      Reflect.deleteProperty(activeAttempts, step)
      this.removeCall(session, attemptId)
    }
    return { ...current, activeAttempts }
  }
}
