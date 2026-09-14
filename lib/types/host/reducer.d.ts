/** Pure bounded reducer used by the isolated Usage Ledger worker. */
import type { UsageSessionEvent } from './event-types.js';
import type { UsageLedgerCallRow, UsageLedgerSessionRow } from './spec.js';
/** Minimal session identity carried across the worker boundary. */
export interface LedgerSession {
    readonly id: string;
    readonly createdAt: number;
    readonly cwd?: string;
    readonly inheritedEventCount: number;
}
/** One idempotent record change committed by the worker's SQLite transaction. */
export type LedgerMutation = {
    readonly type: 'call-upsert';
    readonly key: string;
    readonly row: UsageLedgerCallRow;
} | {
    readonly type: 'cursor-upsert';
    readonly sessionId: string;
    readonly row: UsageLedgerSessionRow;
} | {
    readonly type: 'cursor-delete';
    readonly sessionId: string;
    readonly createdAt: number;
};
/** State loaded only for the session currently being reduced. */
export interface LedgerReducerSeed {
    readonly cursor?: UsageLedgerSessionRow | undefined;
    readonly calls?: readonly {
        readonly key: string;
        readonly row: UsageLedgerCallRow;
    }[] | undefined;
}
/**
 * Fold one session at a time. The reducer retains only active attempts, so a
 * multi-year ledger never becomes a worker heap.
 */
export declare class UsageLedgerReducer {
    private readonly maxActiveAttempts;
    private readonly calls;
    private cursorRow;
    constructor(seed?: LedgerReducerSeed, maxActiveAttempts?: number);
    /** Return the cursor for the session currently loaded into this reducer. */
    cursor(session: LedgerSession): UsageLedgerSessionRow | undefined;
    /** Return the first sequence that needs replay for this session lifecycle. */
    resumeSeq(session: LedgerSession): number;
    /** Apply one bounded event batch and return durable call/cursor changes. */
    applyBatch(session: LedgerSession, events: readonly UsageSessionEvent[]): readonly LedgerMutation[];
    /** Discard transient in-memory state after a live lifecycle is disposed. */
    dispose(): void;
    private emptySessionRow;
    private processEvent;
    private putCall;
    private removeCall;
    private createAttempt;
    private endAttempt;
    private updateActiveRoute;
    private recordFinish;
    private processAssistantMessage;
    private recordProvisionalUsage;
    private processRetry;
    private terminateActive;
}
