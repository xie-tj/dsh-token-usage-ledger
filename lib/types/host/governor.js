/** Adaptive pacing policy for best-effort historical Usage Ledger replay. */
/** Stateful fast-backoff / slow-recovery controller. */
export class UsageLedgerGovernor {
    config;
    delayMs;
    healthySamples = 0;
    constructor(config) {
        this.config = config;
        this.delayMs = config.minDelayMs;
    }
    /** Update the worker pace from one Host workload sample. */
    observe(sample) {
        if (this.config.powerMode === 'ac-only' && sample.powerSource !== 'ac') {
            this.healthySamples = 0;
            return { mode: 'pause', delayMs: this.config.maxDelayMs, reason: 'battery' };
        }
        if (sample.rssMiB >= this.config.pauseRssMiB
            || (this.config.pauseAvailableMemoryMiB > 0
                && sample.availableMemoryMiB !== undefined
                && sample.availableMemoryMiB <= this.config.pauseAvailableMemoryMiB)) {
            this.healthySamples = 0;
            return { mode: 'pause', delayMs: this.config.maxDelayMs, reason: 'memory' };
        }
        if (sample.eventLoopUtilization >= this.config.pauseEventLoopUtilization
            || sample.eventLoopDelayMs >= this.config.pauseEventLoopDelayMs) {
            this.healthySamples = 0;
            return { mode: 'pause', delayMs: this.config.maxDelayMs, reason: 'event-loop' };
        }
        if (sample.eventLoopUtilization >= this.config.busyEventLoopUtilization
            || sample.eventLoopDelayMs >= this.config.busyEventLoopDelayMs) {
            this.healthySamples = 0;
            this.delayMs = Math.min(this.config.maxDelayMs, Math.max(this.config.minDelayMs, Math.max(1, this.delayMs) * 2));
            return { mode: 'run', delayMs: this.delayMs, reason: 'event-loop' };
        }
        this.healthySamples += 1;
        if (this.healthySamples >= this.config.recoverySamples) {
            this.healthySamples = 0;
            this.delayMs = Math.max(this.config.minDelayMs, Math.floor(this.delayMs * 0.75));
        }
        return { mode: 'run', delayMs: this.delayMs };
    }
}
