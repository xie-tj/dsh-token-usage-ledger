/**
 * Public JSON-safe vocabulary for the persistent usage ledger.
 * @module dsh-plugin-usage-ledger/types
 */
/** One provider attempt projected into the selected date range. */
export interface UsageLedgerEvent {
    /** Unix epoch milliseconds when the provider attempt started. */
    readonly at: number;
    /** Workspace path, or `null` for sessions without a workspace. */
    readonly workspace: string | null;
    /** Provider route recorded for the attempt. */
    readonly provider: string;
    /** Provider-owned model identifier recorded for the attempt. */
    readonly model: string;
    /** Terminal status, or `started` when no terminal record arrived. */
    readonly outcome: 'started' | 'success' | 'failure' | 'aborted';
    /** Whether another attempt followed this one in the same step. */
    readonly retried: boolean;
    /** Provider-reported usage, when available. */
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}
/** One model route's accumulated usage over the selected period. */
export interface UsageLedgerModelRow {
    /** Workspace path, or `null` for sessions without a workspace. */
    readonly workspace: string | null;
    /** Provider route recorded in the official session events. */
    readonly provider: string;
    /** Provider-owned model identifier recorded in the official session events. */
    readonly model: string;
    /** Disjoint uncached input-token total. */
    readonly inputTokens: number;
    /** Response-token total. Reasoning tokens are included here. */
    readonly outputTokens: number;
    /** Cached-input read-token total. */
    readonly cacheReadTokens: number;
    /** Cached-input write-token total. */
    readonly cacheWriteTokens: number;
    /** Number of provider request attempts, including failures, aborts, and retries. */
    readonly requests: number;
    /** Attempts with a successful terminal response. */
    readonly successfulRequests: number;
    /** Attempts ending in a provider failure or abort. */
    readonly failedRequests: number;
    /** Attempts followed by a scheduled retry. */
    readonly retryRequests: number;
    /** Attempts with final or provisional provider token usage. */
    readonly meteredRequests: number;
    /** Attempts whose token usage was not reported. */
    readonly unmeteredRequests: number;
}
/** One GUI-timezone calendar day's usage over the selected workspaces and models. */
export interface UsageLedgerDailyRow {
    /** Calendar date in the requested IANA timezone, in `YYYY-MM-DD` form. */
    readonly day: string;
    /** Disjoint uncached input-token total. */
    readonly inputTokens: number;
    /** Response-token total. */
    readonly outputTokens: number;
    /** Cached-input read-token total. */
    readonly cacheReadTokens: number;
    /** Cached-input write-token total. */
    readonly cacheWriteTokens: number;
    /** Number of provider request attempts, including failures, aborts, and retries. */
    readonly requests: number;
    /** Attempts with a successful terminal response. */
    readonly successfulRequests: number;
    /** Attempts ending in a provider failure or abort. */
    readonly failedRequests: number;
    /** Attempts followed by a scheduled retry. */
    readonly retryRequests: number;
    /** Attempts with final or provisional provider token usage. */
    readonly meteredRequests: number;
    /** Attempts whose token usage was not reported. */
    readonly unmeteredRequests: number;
}
/** Optional filter for a ledger snapshot. Omitted fields select all workspaces and thirty local calendar days. */
export interface UsageLedgerSnapshotRequest {
    /** Exact workspace path, or omit to combine every workspace. */
    readonly workspace?: string | null;
    /** Number of calendar days ending today, from 1 through 366. */
    readonly days?: number;
    /** Select every retained ledger day through today instead of a fixed window. */
    readonly all?: boolean;
    /** IANA timezone used for the inclusive day range and daily grouping. */
    readonly timeZone?: string;
    /** Exact provider filter, or omit to combine providers. */
    readonly provider?: string | null;
    /** Exact model filter, or omit to combine models. */
    readonly model?: string | null;
}
/** Read-only usage summary returned by `usageLedgerPlugin/snapshot`. */
export interface UsageLedgerSnapshot {
    /** Resolved workspace filter: `null` means every workspace. */
    readonly workspace: string | null;
    /** Resolved inclusive calendar date range in `timeZone`. */
    readonly days: number;
    /** Whether this response aggregates every retained day through today. */
    readonly all: boolean;
    /** Date at the beginning of the range in `timeZone`. */
    readonly fromDay: string;
    /** Date at the end of the range in `timeZone`. */
    readonly throughDay: string;
    /** IANA timezone used for calendar grouping. */
    readonly timeZone: string;
    /** Host timestamp at which this response was assembled. */
    readonly updatedAt: string;
    /** One attempt per provider dispatch in the requested range. */
    readonly events: readonly UsageLedgerEvent[];
    /** Whether the bounded event detail page excludes additional matching calls. */
    readonly eventsTruncated: boolean;
    /** Totals grouped by workspace, provider, and model. */
    readonly models: readonly UsageLedgerModelRow[];
    /** Per-day totals for the requested range, including zero-usage days. */
    readonly daily: readonly UsageLedgerDailyRow[];
}
/** Filters applied to a streaming CSV ledger export. */
export interface UsageLedgerExportRequest extends UsageLedgerSnapshotRequest {
}
/** On-disk result of a completed bounded-memory CSV export. */
export interface UsageLedgerExportResult {
    /** Absolute path of the owner-only CSV file. */
    readonly path: string;
    /** Matching call rows written after the header row. */
    readonly rows: number;
    /** First calendar day included by the export. */
    readonly fromDay: string;
    /** Last calendar day included by the export. */
    readonly throughDay: string;
}
/** Non-blocking background worker state shown by the Usage page. */
export type UsageLedgerWorkerState = 'idle' | 'running' | 'paused' | 'failed';
/** Read-only status returned by `usageLedgerPlugin/status`. */
export interface UsageLedgerStatus {
    /** Current worker state; `paused` means historical replay is unsupported/off. */
    readonly state: UsageLedgerWorkerState;
    /** Number of sessions selected for the current automatic backfill pass. */
    readonly totalSessions: number;
    /** Sessions whose reader pass has completed. */
    readonly processedSessions: number;
    /** Logical events observed by the worker. */
    readonly processedEvents: number;
    /** Automatic historical window in days. */
    readonly backfillDays: number;
    /** Whether the worker scans all history or only the recent priority window. */
    readonly backfillScope: 'all' | 'recent';
    /** Current workload decision applied between historical reader slices. */
    readonly pace?: Readonly<{
        mode: 'run' | 'pause';
        delayMs: number;
        workShare: number;
        reason?: 'battery' | 'event-loop' | 'memory';
    }>;
    /** Session currently being read, when one is active. */
    readonly currentSessionId?: string;
    /** Most recent recoverable worker/storage error. */
    readonly lastError?: string;
    /** Host timestamp of the status update. */
    readonly updatedAt: string;
}
