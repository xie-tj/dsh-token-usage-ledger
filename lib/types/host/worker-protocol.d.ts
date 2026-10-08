/** Versioned NDJSON protocol shared by the Host supervisor and backfill worker. */
import type { UsageSessionEvent } from './event-types.js';
import type { Branded } from '@deepseek-ai/dsh-brand';
export declare const USAGE_LEDGER_WORKER_PROTOCOL = 1;
/** JSON-safe isolated reader description, supplied by a provider or the released JSONL adapter. */
export interface WorkerReaderSpec {
    readonly protocolVersion: number;
    readonly workerModule: string;
    readonly options?: Readonly<Record<string, boolean | number | string>>;
    /** The worker module streams its own session headers without a Host list(). */
    readonly supportsSessionListing?: boolean;
}
/** Stable source configuration identity, independent of the plugin install directory. */
export type WorkerSourceIdentity = Branded<'UsageLedgerSourceIdentity'>;
/** Reader-owned metadata fingerprint usable across process restarts. */
export type WorkerSourceFingerprint = Branded<'UsageLedgerSourceFingerprint'>;
/** Metadata observation used to prove that a completed replay still describes the same source. */
export interface WorkerSourceStamp {
    readonly source: WorkerSourceIdentity;
    readonly fingerprint: WorkerSourceFingerprint;
}
/** Brand a reader-generated source identity. @param value - stable source description. @returns branded identity. */
export declare function workerSourceIdentity(value: string): WorkerSourceIdentity;
/** Brand a reader-generated fingerprint. @param value - durable metadata fingerprint. @returns branded fingerprint. */
export declare function workerSourceFingerprint(value: string): WorkerSourceFingerprint;
/** Runtime contract implemented by an isolated historical reader module. */
export interface WorkerReaderModule {
    /** A lookup may use this pass's listing snapshot; verify must observe fresh metadata after EOF. */
    getSourceStamp?: (options: Readonly<Record<string, boolean | number | string>> | undefined, request: {
        readonly session: {
            readonly id: string;
            readonly createdAt: number;
            readonly cwd?: string;
        };
        readonly phase: 'lookup' | 'verify';
    }, signal?: AbortSignal) => Promise<WorkerSourceStamp | undefined>;
    readSessionBatches(options: Readonly<Record<string, boolean | number | string>> | undefined, request: {
        readonly session: {
            readonly id: string;
            readonly cwd?: string;
        };
        readonly fromSeq: number;
        readonly batchEvents: number;
    }, signal?: AbortSignal): AsyncIterable<WorkerReaderBatch>;
    /** Iterate stored headers inside the worker; a public metadata list may be materialized there. */
    listSessionHeaders?: (options: Readonly<Record<string, boolean | number | string>> | undefined, request: {
        readonly createdAtAfter?: number;
        readonly createdAtBefore?: number;
    }, signal?: AbortSignal) => AsyncIterable<WorkerListedSession>;
}
/** Bounded reducer batch returned from an isolated historical reader. */
export interface WorkerReaderBatch {
    readonly meta: {
        readonly id: string;
    };
    readonly inheritedEventCount: number;
    readonly events: readonly UsageSessionEvent[];
}
/** One stored lifecycle discovered by an isolated background lister. */
export interface WorkerListedSession {
    readonly id: string;
    readonly createdAt: number;
    readonly cwd?: string;
}
/** Compact session identity sent over IPC. */
export interface WorkerSession {
    readonly id: string;
    readonly createdAt: number;
    readonly cwd?: string;
    readonly inheritedEventCount: number;
}
export interface WorkerInitFrame {
    readonly type: 'init';
    readonly protocolVersion: number;
    readonly config: {
        readonly databasePath: string;
        readonly backfillScope: 'all' | 'recent';
        readonly backfillDays: number;
        readonly workerBatchEvents: number;
        readonly workerSliceMs: number;
        readonly workerMaxHeapMiB: number;
        readonly workerMaxActiveAttempts: number;
    };
    readonly readerSpec?: WorkerReaderSpec;
    /** Fallback history for providers without streaming session listing. */
    readonly sessions: readonly WorkerSession[];
    readonly liveSessionIds: readonly string[];
}
export interface WorkerLiveFrame {
    readonly type: 'live';
    readonly session: WorkerSession;
    readonly event: UsageSessionEvent;
}
export interface WorkerDisposeFrame {
    readonly type: 'dispose';
    readonly session: WorkerSession;
}
export interface WorkerRescanFrame {
    readonly type: 'rescan';
    readonly session: WorkerSession;
}
export interface WorkerStopFrame {
    readonly type: 'stop';
}
/** Host workload signal controlling only historical scanning, never live events. */
export interface WorkerPaceFrame {
    readonly type: 'pace';
    readonly mode: 'run' | 'pause';
    readonly delayMs: number;
    readonly reason?: 'battery' | 'event-loop' | 'memory';
}
export type WorkerRequestFrame = WorkerInitFrame | WorkerLiveFrame | WorkerDisposeFrame | WorkerRescanFrame | WorkerPaceFrame | WorkerStopFrame;
export interface WorkerProgressFrame {
    readonly type: 'progress';
    readonly status: 'idle' | 'running' | 'paused' | 'failed';
    readonly totalSessions: number;
    readonly processedSessions: number;
    readonly processedEvents: number;
    readonly reusedSessions?: number;
    /** Selected historical lifecycles that still need a successful re-read. */
    readonly failedSessions?: number;
    readonly currentSessionId?: string;
    readonly backfillDays: number;
}
export interface WorkerCheckpointFrame {
    readonly type: 'checkpoint';
    readonly sessionId: string;
    readonly observedSeq: number;
}
export interface WorkerErrorFrame {
    readonly type: 'error';
    readonly message: string;
    readonly sessionId?: string;
    readonly fatal?: boolean;
}
export interface WorkerDoneFrame {
    readonly type: 'done';
    readonly sessionId?: string;
}
export type WorkerResponseFrame = WorkerProgressFrame | WorkerCheckpointFrame | WorkerErrorFrame | WorkerDoneFrame;
/** Serialize a single protocol frame with exactly one newline. */
export declare function encodeWorkerFrame(frame: WorkerRequestFrame | WorkerResponseFrame): string;
/** Parse and minimally validate an incoming NDJSON frame. */
export declare function decodeWorkerFrame(line: string): WorkerRequestFrame | undefined;
