/** Persistent `usage_ledger` domain declaration and stored-record schemas. */

import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUsageAttemptId } from './event-types.ts'
import type { UsageAttemptId } from './event-types.ts'

/** Final status known for one provider request attempt. */
export type UsageLedgerAttemptOutcome = 'success' | 'failure' | 'aborted'

/** Lifecycle cursor plus attempt lookups required while replaying one session. */
export interface UsageLedgerSessionRow {
  /** Session header creation time, distinguishing reused session ids. */
  readonly createdAt: number
  /** Session workspace, absent when the header recorded none. */
  readonly workspace?: string | undefined
  /** Last append sequence the ledger observed. */
  readonly observedSeq: number
  /** Open attempt id by `turn:step`. */
  readonly activeAttempts: Readonly<Record<string, UsageAttemptId>>
  /** Most recent successful attempt id by `turn:step`. */
  readonly successfulAttempts: Readonly<Record<string, UsageAttemptId>>
}

/** One independently idempotent provider call, including provisional and final metering. */
export interface UsageLedgerCallRow {
  /** Owning session id. */
  readonly sessionId: string
  /** Session header creation time, distinguishing reused session ids. */
  readonly createdAt: number
  /** Workspace path, absent when the header recorded none. */
  readonly workspace?: string | undefined
  /** UTC date on which the attempt started. */
  readonly day: string
  /** Durable request attempt id. */
  readonly attemptId: UsageAttemptId
  /** Owning turn number. */
  readonly turn: number
  /** Owning step number. */
  readonly step: number
  /** Provider route reconstructed from official request events. */
  readonly provider: string
  /** Provider-owned model identifier reconstructed from official request events. */
  readonly model: string
  /** Unix epoch milliseconds when the provider dispatch started. */
  readonly startedAt: number
  /** Terminal outcome, absent while the durable log has only the start. */
  readonly outcome?: UsageLedgerAttemptOutcome | undefined
  /** A retry was durably scheduled after this attempt failed. */
  readonly retryScheduled?: boolean | undefined
  /** Latest usage chunk received while the attempt streamed. */
  readonly provisionalUsage?: UsageLedgerTokenUsage | undefined
  /** Final assistant-message usage, replacing provisional usage for totals. */
  readonly finalUsage?: UsageLedgerTokenUsage | undefined
}

/** JSON-safe token counters retained inside one call record. */
export interface UsageLedgerTokenUsage {
  /** Disjoint uncached input tokens. */
  readonly inputTokens: number
  /** Response tokens. */
  readonly outputTokens: number
  /** Cached-input read tokens. */
  readonly cacheReadTokens: number
  /** Cached-input write tokens. */
  readonly cacheWriteTokens: number
}

const nonNegativeInteger = z.number().int().nonnegative()
const tokenUsageSchema = z.object({
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  cacheReadTokens: nonNegativeInteger,
  cacheWriteTokens: nonNegativeInteger,
})
const attemptIdSchema = z.string().transform(createUsageAttemptId)

/** Zod schema for the lifecycle cursor and attempt lookup tables. */
export const usageLedgerSessionRowSchema = z.object({
  createdAt: nonNegativeInteger,
  workspace: z.string().optional(),
  observedSeq: z.number().int().min(-1),
  activeAttempts: z.record(z.string(), attemptIdSchema),
  successfulAttempts: z.record(z.string(), attemptIdSchema),
})

/** Zod schema for one persisted provider attempt. */
export const usageLedgerCallRowSchema = z.object({
  sessionId: z.string(),
  createdAt: nonNegativeInteger,
  workspace: z.string().optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  attemptId: attemptIdSchema,
  startedAt: nonNegativeInteger,
  turn: nonNegativeInteger,
  step: nonNegativeInteger,
  provider: z.string(),
  model: z.string(),
  outcome: z.enum(['success', 'failure', 'aborted']).optional(),
  retryScheduled: z.boolean().optional(),
  provisionalUsage: tokenUsageSchema.optional(),
  finalUsage: tokenUsageSchema.optional(),
})

/** Versioned persistent storage layout for the usage-ledger service. */
export const usageLedgerDomainSpec = defineDomain({
  name: 'usage_ledger',
  version: 2,
  tables: {
    sessions: domainTable<SessionId, UsageLedgerSessionRow>(usageLedgerSessionRowSchema),
    calls: domainTable<string, UsageLedgerCallRow>(usageLedgerCallRowSchema),
  },
})
