/**
 * Pure usage-ledger reducer used by the isolated backfill worker.
 *
 * It owns only compact call/cursor state and emits idempotent mutations. The
 * Host process applies those mutations to SQLite; no session payload or
 * storage write is needed on the model-request path.
 * @module dsh-plugin-usage-ledger/reducer
 */
import type { UsageSessionEvent } from './event-types.js';
import type { UsageLedgerCallRow, UsageLedgerSessionRow } from './spec.js';
/** Minimal session identity carried across the worker boundary. */
export interface LedgerSession {
    readonly id: string;
    readonly createdAt: number;
    readonly cwd?: string;
    readonly inheritedEventCount: number;
}
/** One idempotent call/cursor change returned to the Host process. */
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
/** Serializable state used to resume a worker after a crash. */
export interface LedgerReducerSeed {
    readonly calls?: readonly {
        readonly key: string;
        readonly row: UsageLedgerCallRow;
    }[];
    readonly cursors?: readonly {
        readonly sessionId: string;
        readonly row: UsageLedgerSessionRow;
    }[];
}
/** Fold one or more compact events and emit only derived storage mutations. */
export declare class UsageLedgerReducer {
    private readonly calls;
    private readonly cursors;
    private readonly routes;
    private readonly routeTimes;
    constructor(seed?: LedgerReducerSeed);
    /** Return a copy of the current durable call rows for Host snapshots/tests. */
    callEntries(): IterableIterator<[string, UsageLedgerCallRow]>;
    /** Return the reducer cursor for one lifecycle, if one has been observed. */
    cursor(sessionId: string): UsageLedgerSessionRow | undefined;
    /** Return the first sequence that needs to be replayed for this lifecycle. */
    resumeSeq(session: LedgerSession): number;
    /** Apply one bounded event batch in sequence order. */
    applyBatch(session: LedgerSession, events: readonly UsageSessionEvent[]): readonly LedgerMutation[];
    /** Remove a disposed lifecycle cursor while retaining its historical calls. */
    dispose(session: LedgerSession): readonly LedgerMutation[];
    private emptySessionRow;
    private processEvent;
    private putCall;
    private createAttempt;
    private endAttempt;
    private updateActiveRoute;
    private recordFinish;
    private processAssistantMessage;
    private recordProvisionalUsage;
    private replaceFinalUsage;
    private processRetry;
    private terminateActive;
}
