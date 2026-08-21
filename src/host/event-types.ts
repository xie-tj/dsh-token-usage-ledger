/** Compatibility event vocabulary for session versions with provider-attempt records. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** Opaque provider-dispatch identity used by the session event stream. */
export type UsageAttemptId = Branded<'RequestAttemptId'>

/**
 * Attach the provider-attempt brand to an id produced by a session-compatible source.
 * @param value - Runtime request-attempt identifier.
 * @returns The same identifier with its compile-time domain brand.
 */
export function createUsageAttemptId(value: string): UsageAttemptId {
  return value as UsageAttemptId
}

/** Fields shared by both records of one provider dispatch. */
interface UsageRequestAttemptBase {
  /** Stable provider-dispatch identity. */
  readonly attemptId: UsageAttemptId
  /** Session turn containing the dispatch. */
  readonly turn: number
  /** Session step containing the dispatch. */
  readonly step: number
  /** Provider route selected for the dispatch. */
  readonly provider: string
  /** Model selected for the dispatch. */
  readonly model: string
  /** Unix epoch milliseconds when the dispatch started. */
  readonly startedAt: number
}

/** The provider-attempt event used by newer session implementations. */
export type UsageRequestAttemptEventData = UsageRequestAttemptBase & (
  | {
    /** Whether the record opens the dispatch. */
    readonly phase: 'start'
  }
  | {
    /** Whether the record closes the dispatch. */
    readonly phase: 'end'
    /** Terminal provider outcome. */
    readonly outcome: 'success' | 'failure' | 'aborted'
  }
)

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable provider-dispatch lifecycle record used by the usage ledger. */
    'llm/request-attempt': UsageRequestAttemptEventData
  }
}

/** Session event vocabulary accepted by the ledger across supported session versions. */
export type UsageSessionEvent = SessionEvent
