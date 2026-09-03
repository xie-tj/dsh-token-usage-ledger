/** Session event vocabulary used by the usage ledger. */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
/** Opaque provider-dispatch identity used by persisted ledger rows. */
export type UsageAttemptId = Branded<'RequestAttemptId'>;
/**
 * Attach the provider-attempt brand to an identifier derived by this plugin.
 * @param value - Stable identifier from an official session event.
 * @returns The same identifier with its compile-time domain brand.
 */
export declare function createUsageAttemptId(value: string): UsageAttemptId;
/** Session events produced by the supported DSH event vocabulary. */
export type UsageSessionEvent = SessionEvent;
