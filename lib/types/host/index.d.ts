/** Host-side Usage Ledger coordinator; heavy replay runs in a private worker. */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { UsageLedgerSnapshot, UsageLedgerSnapshotRequest, UsageLedgerStatus } from './types.js';
export type * from './types.js';
export { usageLedgerCallRowSchema, usageLedgerDomainSpec, usageLedgerSessionRowSchema, } from './spec.js';
export type { UsageLedgerAttemptOutcome, UsageLedgerCallRow, UsageLedgerSessionRow, UsageLedgerTokenUsage, } from './spec.js';
export type { UsageAttemptId, UsageRequestAttemptEvent } from './event-types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        usageLedger: UsageLedgerService;
    }
}
/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
export declare const USAGE_LEDGER_SETTINGS_NAMESPACE: "usage-ledger";
/** Enable or disable the isolated historical reader process. */
export type UsageLedgerBackfillMode = 'process' | 'off';
/** Runtime configuration for the background ledger coordinator. */
export interface Config {
    readonly backfillMode?: UsageLedgerBackfillMode;
    readonly backfillDays?: number;
    readonly workerMaxHeapMiB?: number;
    readonly workerBatchEvents?: number;
    readonly workerSliceMs?: number;
}
/** Host service that coordinates compact live events and isolated history replay. */
export declare class UsageLedgerService extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private readonly resolvedConfig;
    private readonly worker;
    private sessions?;
    private calls?;
    private accepting;
    private pendingCalls;
    private pendingCursors;
    private pendingDeletes;
    private writeScheduled;
    private writing;
    private retryTimer;
    private status;
    constructor(ctx: Context, config?: Config);
    /** Open SQLite-backed tables and install non-blocking observers. */
    protected [Service.init](): Promise<void>;
    /** Start asynchronously so listing and worker startup never delay a task. */
    private startWorker;
    /** Return committed SQLite data immediately; backfill state is independent. */
    snapshot(request?: UsageLedgerSnapshotRequest): Promise<UsageLedgerSnapshot>;
    /** Non-blocking worker state for the Usage page. */
    statusSnapshot(): UsageLedgerStatus;
    private handleWorkerResponse;
    private recordFailure;
    private scheduleWrites;
    private drainWrites;
    private requireSessions;
    private requireCalls;
}
export default UsageLedgerService;
