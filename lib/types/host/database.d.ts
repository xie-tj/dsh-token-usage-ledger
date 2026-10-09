/** Bounded SQLite reader and writer for the private Usage Ledger database. */
import { DatabaseSync } from 'node:sqlite';
import type { LedgerMutation } from './reducer.js';
import type { WorkerSourceStamp } from './worker-protocol.js';
import type { UsageLedgerCallRow, UsageLedgerSessionRow } from './spec.js';
/** Dedicated SQLite file format. It intentionally does not read v2/v3 stores. */
export declare const USAGE_LEDGER_SQLITE_SCHEMA_VERSION = 6;
/** SQLite application id used to reject unrelated user files. */
export declare const USAGE_LEDGER_SQLITE_APPLICATION_ID = 1146309684;
/** One page of call rows scanned in timestamp/key order. */
export interface UsageLedgerCallPage {
    readonly rows: readonly {
        readonly key: string;
        readonly row: UsageLedgerCallRow;
    }[];
    readonly next: Readonly<{
        startedAt: number;
        key: string;
    }> | undefined;
}
/** SQL filters used by a bounded call-page scan. */
export interface UsageLedgerCallPageRequest {
    readonly startedAtInclusive: number;
    readonly startedAtExclusive: number;
    readonly workspace: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly after?: Readonly<{
        startedAt: number;
        key: string;
    }> | undefined;
    readonly limit: number;
}
/** State loaded only for the session currently being reduced. */
export interface UsageLedgerSessionSeed {
    readonly cursor: UsageLedgerSessionRow | undefined;
    readonly calls: readonly {
        readonly key: string;
        readonly row: UsageLedgerCallRow;
    }[];
}
/** Open and validate the private SQLite file without touching legacy ledger files. */
export declare function openUsageLedgerDatabase(path: string): Promise<UsageLedgerDatabase>;
/** Dedicated, bounded access to the private ledger database. */
export declare class UsageLedgerDatabase {
    private readonly db;
    private readonly putCall;
    private readonly putSession;
    constructor(db: DatabaseSync);
    /**
     * Check whether an EOF observation still matches the persisted replay cursor.
     * @param session - stored lifecycle identity.
     * @param stamp - current reader source observation.
     * @param observedSeq - last event represented by the loaded cursor; -1 for an empty log.
     * @returns true only when source metadata and the saved ledger position both match.
     */
    sourceUnchanged(session: {
        readonly id: string;
        readonly createdAt: number;
    }, stamp: WorkerSourceStamp, observedSeq: number): boolean;
    /**
     * Classify a source before creating a replay task or decoding cursor state.
     * @param session - stored lifecycle identity.
     * @param stamp - freshly observed source metadata.
     * @returns true when the EOF proof matches both the source and the cursor currently on disk.
     */
    sourceUnchangedAtSavedCursor(session: {
        readonly id: string;
        readonly createdAt: number;
    }, stamp: WorkerSourceStamp): boolean;
    /**
     * Save EOF only for the cursor that is still stored by this connection.
     * @param session - stored lifecycle identity.
     * @param stamp - stable observation verified after the reader finishes.
     * @param observedSeq - last event applied and persisted before this checkpoint.
     */
    completeSource(session: {
        readonly id: string;
        readonly createdAt: number;
    }, stamp: WorkerSourceStamp, observedSeq: number): void;
    /**
     * Read the stored refusal for a source revision this reader could not decode.
     * @param session - stored lifecycle identity.
     * @param stamp - current reader source observation.
     * @returns the recorded refusal text, or undefined when the revision is not marked.
     */
    unreadableSourceReason(session: {
        readonly id: string;
        readonly createdAt: number;
    }, stamp: WorkerSourceStamp): string | undefined;
    /**
     * Remember a refused generation so later passes skip it without decoding it again.
     * @param session - stored lifecycle identity.
     * @param stamp - observation of the refused source revision.
     * @param reason - reader refusal retained for diagnostics.
     */
    markSourceUnreadable(session: {
        readonly id: string;
        readonly createdAt: number;
    }, stamp: WorkerSourceStamp, reason: string): void;
    /** Drop a stale refusal once the stored generation is readable again. */
    private clearUnreadableSource;
    /** Apply a bounded mutation batch as one durable SQLite transaction. */
    applyMutations(mutations: readonly LedgerMutation[]): void;
    /** Load only one session's cursor and currently active call rows. */
    sessionSeed(sessionId: string, createdAt: number, maxActiveAttempts: number): UsageLedgerSessionSeed;
    /** Read one bounded chronological page without materializing the ledger. */
    callsPage(request: UsageLedgerCallPageRequest): UsageLedgerCallPage;
    /** Return the earliest matching attempt timestamp without loading call rows. */
    firstCallTime(workspace: string | null, provider: string | null, model: string | null): number | undefined;
    /** Close this connection after the owning service or worker reaches quiescence. */
    close(): void;
}
