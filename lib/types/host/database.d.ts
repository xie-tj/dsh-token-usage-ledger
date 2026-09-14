/** Bounded SQLite reader and writer for the private Usage Ledger database. */
import { DatabaseSync } from 'node:sqlite';
import type { LedgerMutation } from './reducer.js';
import type { UsageLedgerCallRow, UsageLedgerSessionRow } from './spec.js';
/** Dedicated SQLite file format. It intentionally does not read v2/v3 stores. */
export declare const USAGE_LEDGER_SQLITE_SCHEMA_VERSION = 4;
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
