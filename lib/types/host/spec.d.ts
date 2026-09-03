/** Persistent `usage_ledger` domain declaration and stored-record schemas. */
import { z } from 'zod';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { UsageAttemptId } from './event-types.js';
/** Final status known for one provider request attempt. */
export type UsageLedgerAttemptOutcome = 'success' | 'failure' | 'aborted';
/** Lifecycle cursor plus attempt lookups required while replaying one session. */
export interface UsageLedgerSessionRow {
    /** Session header creation time, distinguishing reused session ids. */
    readonly createdAt: number;
    /** Session workspace, absent when the header recorded none. */
    readonly workspace?: string | undefined;
    /** Last append sequence the ledger observed. */
    readonly observedSeq: number;
    /** Open attempt id by `turn:step`. */
    readonly activeAttempts: Readonly<Record<string, UsageAttemptId>>;
    /** Most recent successful attempt id by `turn:step`. */
    readonly successfulAttempts: Readonly<Record<string, UsageAttemptId>>;
}
/** One independently idempotent provider call, including provisional and final metering. */
export interface UsageLedgerCallRow {
    /** Owning session id. */
    readonly sessionId: string;
    /** Session header creation time, distinguishing reused session ids. */
    readonly createdAt: number;
    /** Workspace path, absent when the header recorded none. */
    readonly workspace?: string | undefined;
    /** UTC date on which the attempt started. */
    readonly day: string;
    /** Durable request attempt id. */
    readonly attemptId: UsageAttemptId;
    /** Owning turn number. */
    readonly turn: number;
    /** Owning step number. */
    readonly step: number;
    /** Provider route reconstructed from official request events. */
    readonly provider: string;
    /** Provider-owned model identifier reconstructed from official request events. */
    readonly model: string;
    /** Unix epoch milliseconds when the provider dispatch started. */
    readonly startedAt: number;
    /** Terminal outcome, absent while the durable log has only the start. */
    readonly outcome?: UsageLedgerAttemptOutcome | undefined;
    /** A retry was durably scheduled after this attempt failed. */
    readonly retryScheduled?: boolean | undefined;
    /** Latest usage chunk received while the attempt streamed. */
    readonly provisionalUsage?: UsageLedgerTokenUsage | undefined;
    /** Final assistant-message usage, replacing provisional usage for totals. */
    readonly finalUsage?: UsageLedgerTokenUsage | undefined;
}
/** JSON-safe token counters retained inside one call record. */
export interface UsageLedgerTokenUsage {
    /** Disjoint uncached input tokens. */
    readonly inputTokens: number;
    /** Response tokens. */
    readonly outputTokens: number;
    /** Cached-input read tokens. */
    readonly cacheReadTokens: number;
    /** Cached-input write tokens. */
    readonly cacheWriteTokens: number;
}
/** Zod schema for the lifecycle cursor and attempt lookup tables. */
export declare const usageLedgerSessionRowSchema: z.ZodObject<{
    createdAt: z.ZodNumber;
    workspace: z.ZodOptional<z.ZodString>;
    observedSeq: z.ZodNumber;
    activeAttempts: z.ZodRecord<z.ZodString, z.ZodPipe<z.ZodString, z.ZodTransform<UsageAttemptId, string>>>;
    successfulAttempts: z.ZodRecord<z.ZodString, z.ZodPipe<z.ZodString, z.ZodTransform<UsageAttemptId, string>>>;
}, z.core.$strip>;
/** Zod schema for one persisted provider attempt. */
export declare const usageLedgerCallRowSchema: z.ZodObject<{
    sessionId: z.ZodString;
    createdAt: z.ZodNumber;
    workspace: z.ZodOptional<z.ZodString>;
    day: z.ZodString;
    attemptId: z.ZodPipe<z.ZodString, z.ZodTransform<UsageAttemptId, string>>;
    startedAt: z.ZodNumber;
    turn: z.ZodNumber;
    step: z.ZodNumber;
    provider: z.ZodString;
    model: z.ZodString;
    outcome: z.ZodOptional<z.ZodEnum<{
        success: "success";
        failure: "failure";
        aborted: "aborted";
    }>>;
    retryScheduled: z.ZodOptional<z.ZodBoolean>;
    provisionalUsage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheWriteTokens: z.ZodNumber;
    }, z.core.$strip>>;
    finalUsage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cacheReadTokens: z.ZodNumber;
        cacheWriteTokens: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Versioned persistent storage layout for the usage-ledger service. */
export declare const usageLedgerDomainSpec: {
    name: string;
    version: number;
    tables: {
        sessions: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<SessionId, UsageLedgerSessionRow>;
        calls: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, UsageLedgerCallRow>;
    };
};
