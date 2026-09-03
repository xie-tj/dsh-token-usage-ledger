/**
 * Host-side ledger that persists provider attempts and rebuilds usage from session history.
 * @module dsh-plugin-usage-ledger
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { UsageLedgerSnapshot, UsageLedgerSnapshotRequest } from './types.js';
export type * from './types.js';
export { usageLedgerCallRowSchema, usageLedgerDomainSpec, usageLedgerSessionRowSchema, } from './spec.js';
export type { UsageAttemptId } from './event-types.js';
export type { UsageLedgerAttemptOutcome, UsageLedgerCallRow, UsageLedgerSessionRow, UsageLedgerTokenUsage, } from './spec.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        usageLedger: UsageLedgerService;
    }
}
/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
export declare const USAGE_LEDGER_SETTINGS_NAMESPACE: "usage-ledger";
/** Host service that persists each final, failed, aborted, and retried provider call. */
export declare class UsageLedgerService extends TypertRemoteService {
    static inject: string[];
    private sessions?;
    private calls?;
    private readonly cursors;
    private readonly routes;
    private readonly coldSessions;
    private readonly tails;
    private readonly pendingThrough;
    private readonly scheduled;
    private backfillPromise?;
    private accepting;
    constructor(ctx: Context);
    /** Open the ledger and attach lifecycle-bound post-append observers. */
    protected [Service.init](): Promise<void>;
    /** Replay cold persisted sessions without publishing them as live sessions. */
    private backfill;
    /**
     * Return a bounded, read-only summary derived from idempotent call records.
     * @param request - optional workspace, calendar-day, and timezone filters.
     * @returns the usage snapshot after all queued session events are applied.
     */
    snapshot(request?: UsageLedgerSnapshotRequest): Promise<UsageLedgerSnapshot>;
    /** Replay a session tail after startup or HMR, excluding a fork's inherited prefix. */
    private adopt;
    /** Coalesce committed events into one ordered replay; defer the cursor to flush. */
    private schedule;
    /** Wait until all work already observed for one session has been processed. */
    private waitForSession;
    /** Persist one session cursor at its durable session checkpoint. */
    private flushSession;
    /** Persist all cursors before the ledger domain closes. */
    private persistCursors;
    /** Drain all session queues before closing the ledger domain. */
    private drainTails;
    /** Process every missing committed event through one ordered session sequence. */
    private processThrough;
    /** Apply one committed event without persisting the cursor between events. */
    private processEvent;
    /** Record the terminal result of the official provider stream. */
    private recordFinish;
    /** Attach final or legacy historical usage to the step's successful attempt. */
    private processAssistantMessage;
    /** Create one idempotent unmetered row for the first event of a provider dispatch. */
    private createAttempt;
    /** Apply the route discovered after dispatch creation to its active row. */
    private updateActiveRoute;
    /** Terminate only unresolved attempts in the ended turn. */
    private terminateActive;
    /** Mark a known failed provider request when the official retry event schedules another dispatch. */
    private processRetry;
    /** Record official usage from an assistant stream chunk. */
    private recordProvisionalUsage;
    /** Replace the successful attempt's provisional metering with final message usage. */
    private replaceFinalUsage;
    /** Create the initial cursor immediately before this session's owned event suffix. */
    private emptySessionRow;
    /** Serialize one session's best-effort observer work without delaying append. */
    private enqueue;
    /** Return the opened lifecycle-cursor table. */
    private requireSessions;
    /** Return the opened idempotent provider-call table. */
    private requireCalls;
}
export default UsageLedgerService;
