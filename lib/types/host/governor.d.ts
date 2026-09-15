/** Additive-increase/multiplicative-decrease pacing for historical replay. */
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
/** Configured workload limits and AIMD parameters. */
export interface UsageLedgerAdaptiveConfig {
    readonly powerMode: 'ac-only' | 'always';
    /** Worker compute budget used to turn a share into a pause interval. */
    readonly sliceMs: number;
    readonly maxDelayMs: number;
    readonly initialWorkShare: number;
    readonly minWorkShare: number;
    readonly maxWorkShare: number;
    /** Additive increase applied after each healthy window. */
    readonly additiveIncrease: number;
    /** Multiplicative decrease applied when the Host is busy. */
    readonly multiplicativeDecrease: number;
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
    readonly workShare: number;
    readonly reason?: 'battery' | 'event-loop' | 'memory';
}
/** Stateful AIMD controller with hard pause gates for power and memory. */
export declare class UsageLedgerGovernor {
    private readonly config;
    private workShare;
    private healthySamples;
    constructor(config: UsageLedgerAdaptiveConfig);
    /** Update the worker pace from one Host workload sample. */
    observe(sample: UsageLedgerLoadSample): UsageLedgerPace;
    private paused;
    private current;
}
