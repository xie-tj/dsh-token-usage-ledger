/** Compatibility event vocabulary for session versions with provider-attempt records. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'

/** Opaque provider-dispatch identity used by persisted ledger rows. */
export type UsageAttemptId = Branded<'RequestAttemptId'>

/**
 * Attach the provider-attempt brand to an identifier derived by this plugin.
 * @param value - Stable identifier from an official session event.
 * @returns The same identifier with its compile-time domain brand.
 */
export function createUsageAttemptId(value: string): UsageAttemptId {
  return value as UsageAttemptId
}

/** Compatibility event emitted by older alpha.5 request-attempt producers. */
export interface UsageRequestAttemptEvent {
  readonly type: 'llm/request-attempt'
  readonly seq: number
  readonly time: number
  readonly data:
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
}

/** Session events produced by the supported DSH event vocabulary. */
export type UsageSessionEvent = SessionEvent | UsageRequestAttemptEvent
