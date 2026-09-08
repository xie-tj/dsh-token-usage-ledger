/**
 * Provider-attempt event types consumed by the usage ledger.
 *
 * The ledger reads only the durable fields it stores and does not augment
 * `SessionEventMap`, so it accepts the core record when that record is present.
 * @module dsh-plugin-usage-ledger/event-types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Opaque identity shared by the start and terminal records of one provider request. */
export type UsageAttemptId = Branded<'RequestAttemptId'>

/** Start or terminal record for one provider request attempt. */
export type UsageRequestAttemptEventData =
  | {
    readonly attemptId: UsageAttemptId
    readonly turn: number
    readonly step: number
    readonly provider: string
    readonly model: string
    readonly phase: 'start'
    readonly startedAt: number
  }
  | {
    readonly attemptId: UsageAttemptId
    readonly turn: number
    readonly step: number
    readonly provider: string
    readonly model: string
    readonly phase: 'end'
    readonly startedAt: number
    readonly outcome: 'success' | 'failure' | 'aborted'
    readonly failure?: LlmFailure
  }

/** Session events understood by the ledger, including a provider request attempt. */
export type UsageSessionEvent = SessionEvent | {
  readonly type: 'llm/request-attempt'
  readonly data: UsageRequestAttemptEventData
}

/**
 * Brand a legacy synthetic attempt id used when a historical log lacks attempt records.
 * @param value - Stable synthetic request-attempt identifier.
 * @returns The same identifier with its attempt-id brand.
 */
export function createUsageAttemptId(value: string): UsageAttemptId {
  return value as UsageAttemptId
}
