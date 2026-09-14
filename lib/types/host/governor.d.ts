/** Adaptive pacing policy for best-effort historical Usage Ledger replay. */
/** Power source as observed by the Host platform probe. */
export type UsageLedgerPowerSource = 'ac' | 'battery' | 'unknown';
/** One bounded workload sample from the Host process. */
export interface UsageLedgerLoadSample {
    readonly powerSource: UsageLedgerPowerSource;
    readonly eventLoopUtilization: number;
    readonly eventLoopDelayMs: number;
    readonly rssMiB: number;
    readonly availableMemoryMiB: number | undefined;
}
/** Configured workload limits used to derive one worker pacing command. */
export interface UsageLedgerAdaptiveConfig {
    readonly powerMode: 'ac-only' | 'always';
    readonly minDelayMs: number;
    readonly maxDelayMs: number;
    readonly recoverySamples: number;
    readonly busyEventLoopUtilization: number;
    readonly pauseEventLoopUtilization: number;
    readonly busyEventLoopDelayMs: number;
    readonly pauseEventLoopDelayMs: number;
    readonly pauseRssMiB: number;
    readonly pauseAvailableMemoryMiB: number;
}
/** A pace applied only between bounded historical reader slices. */
export interface UsageLedgerPace {
    readonly mode: 'run' | 'pause';
    readonly delayMs: number;
    readonly reason?: 'battery' | 'event-loop' | 'memory';
}
/** Stateful fast-backoff / slow-recovery controller. */
export declare class UsageLedgerGovernor {
    private readonly config;
    private delayMs;
    private healthySamples;
    constructor(config: UsageLedgerAdaptiveConfig);
    /** Update the worker pace from one Host workload sample. */
    observe(sample: UsageLedgerLoadSample): UsageLedgerPace;
}
