/** Crash-contained child-process supervisor for the Usage Ledger reducer. */
import type { WorkerInitFrame, WorkerLiveFrame, WorkerRequestFrame, WorkerResponseFrame } from './worker-protocol.js';
export interface WorkerSupervisorCallbacks {
    readonly onResponse: (frame: WorkerResponseFrame) => void;
    readonly onFailure: (message: string) => void;
}
/**
 * Keep the main process responsive when the worker pipe is full. Live frames
 * are coalesced by session; the next provider-backed rescan repairs any
 * sequence gap after persistence catches up.
 */
export declare class UsageWorkerSupervisor {
    private readonly callbacks;
    private readonly workerPath;
    private child;
    private output;
    private initFrame;
    private blocked;
    private stopping;
    private restartTimer;
    private restartDelay;
    private readonly pendingLive;
    private readonly pendingControl;
    private exitPromise;
    private resolveExit;
    constructor(callbacks: WorkerSupervisorCallbacks, workerPath?: string);
    /** Start or replace the child with a complete initialization snapshot. */
    start(frame: WorkerInitFrame): void;
    /** Send one compact live event, merging it when stdin applies backpressure. */
    sendLive(frame: WorkerLiveFrame): void;
    /** Send a control frame, also coalesced per session while the pipe is full. */
    sendControl(frame: WorkerRequestFrame, key: string): void;
    /** Stop without making plugin disposal wait for a wedged worker. */
    stop(): Promise<void>;
    private spawnWorker;
    private write;
    private flushPending;
    private trimPending;
    private failed;
}
