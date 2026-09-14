/** Host-side Usage Ledger coordinator with an adaptive isolated history worker. */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { UsageLedgerAdaptiveConfig } from './governor.js';
import type { UsageLedgerExportRequest, UsageLedgerExportResult, UsageLedgerSnapshot, UsageLedgerSnapshotRequest, UsageLedgerStatus } from './types.js';
export type * from './types.js';
export { usageLedgerCallRowSchema, usageLedgerSessionRowSchema, } from './spec.js';
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
/** Select automatic replay for all retained history or only the priority window. */
export type UsageLedgerBackfillScope = 'all' | 'recent';
/** Runtime configuration for the background ledger coordinator. */
export interface Config {
    /** Private SQLite path supplied by the bundle patch through dshHomePath(). */
    readonly databasePath?: string;
    readonly backfillMode?: UsageLedgerBackfillMode;
    /** All scans older retained sessions after the recent priority window. */
    readonly backfillScope?: UsageLedgerBackfillScope;
    /** Recent window processed before older history. */
    readonly backfillDays?: number;
    readonly workerMaxHeapMiB?: number;
    /** Maximum unfinished attempts retained for one malformed or stalled session. */
    readonly workerMaxActiveAttempts?: number;
    readonly workerBatchEvents?: number;
    readonly workerSliceMs?: number;
    /** Pause historical scanning when the Mac is not confirmed to be on AC power. */
    readonly backfillPowerMode?: UsageLedgerAdaptiveConfig['powerMode'];
    readonly loadSampleIntervalMs?: number;
    readonly backfillMinDelayMs?: number;
    readonly backfillMaxDelayMs?: number;
    readonly backfillRecoverySamples?: number;
    readonly backfillBusyEventLoopUtilization?: number;
    readonly backfillPauseEventLoopUtilization?: number;
    readonly backfillBusyEventLoopDelayMs?: number;
    readonly backfillPauseEventLoopDelayMs?: number;
    readonly backfillPauseRssMiB?: number;
    readonly backfillPauseAvailableMemoryMiB?: number;
    /** Maximum detailed call rows returned by one snapshot. Aggregates remain complete. */
    readonly snapshotEventLimit?: number;
    /** Rows read per event-loop turn while projecting one snapshot. */
    readonly snapshotScanBatchRows?: number;
}
/** Host service that keeps all heavyweight ledger work outside the task process. */
export declare class UsageLedgerService extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private readonly resolvedConfig;
    private readonly worker;
    private readonly loopDelay;
    private readonly governor;
    private lastUtilization;
    private hasLoadSample;
    private database;
    private sampleTimer;
    private powerSource;
    private lastPowerProbe;
    private powerProbe;
    private pace;
    private status;
    constructor(ctx: Context, config?: Config);
    /** Open only a bounded SQLite connection; no call rows enter the Host heap. */
    protected [Service.init](): Promise<void>;
    /** Start independently of task initialization and keep fallback listing out of capable providers. */
    private startWorker;
    /** Return complete aggregates and a bounded event page without materializing the SQLite ledger. */
    snapshot(request?: UsageLedgerSnapshotRequest): Promise<UsageLedgerSnapshot>;
    /** Write all matching call rows in bounded SQLite pages to an owner-only CSV. */
    exportCsv(request?: UsageLedgerExportRequest): Promise<UsageLedgerExportResult>;
    /** Non-blocking worker and workload state for the Usage page. */
    statusSnapshot(): UsageLedgerStatus;
    private handleWorkerResponse;
    private startGovernor;
    private stopGovernor;
    private sampleLoad;
    private recordFailure;
    private resolveRange;
    private requireDatabase;
}
export default UsageLedgerService;
