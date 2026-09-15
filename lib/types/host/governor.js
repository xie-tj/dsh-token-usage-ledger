/** Additive-increase/multiplicative-decrease pacing for historical replay. */
/** Stateful AIMD controller with hard pause gates for power and memory. */
export class UsageLedgerGovernor {
    config;
    workShare;
    healthySamples = 0;
    constructor(config) {
        this.config = config;
        this.workShare = config.initialWorkShare;
    }
    /** Update the worker pace from one Host workload sample. */
    observe(sample) {
        if (this.config.powerMode === 'ac-only' && sample.powerSource !== 'ac') {
            return this.paused('battery');
        }
        if (sample.rssMiB >= this.config.pauseRssMiB
            || (this.config.pauseAvailableMemoryMiB > 0
                && sample.availableMemoryMiB !== undefined
                && sample.availableMemoryMiB <= this.config.pauseAvailableMemoryMiB)) {
            return this.paused('memory');
        }
        if (sample.eventLoopUtilization >= this.config.pauseEventLoopUtilization
            || sample.eventLoopDelayMs >= this.config.pauseEventLoopDelayMs) {
            return this.paused('event-loop');
        }
        if (sample.eventLoopUtilization >= this.config.busyEventLoopUtilization
            || sample.eventLoopDelayMs >= this.config.busyEventLoopDelayMs) {
            this.healthySamples = 0;
            this.workShare = Math.max(this.config.minWorkShare, this.workShare * this.config.multiplicativeDecrease);
            return this.current('run', 'event-loop');
        }
        this.healthySamples += 1;
        if (this.healthySamples >= this.config.recoverySamples) {
            this.healthySamples = 0;
            this.workShare = Math.min(this.config.maxWorkShare, this.workShare + this.config.additiveIncrease);
        }
        return this.current('run');
    }
    paused(reason) {
        this.healthySamples = 0;
        this.workShare = this.config.minWorkShare;
        return this.current('pause', reason);
    }
    current(mode, reason) {
        const delayMs = mode === 'pause'
            ? this.config.maxDelayMs
            : Math.min(this.config.maxDelayMs, Math.max(0, Math.ceil(this.config.sliceMs * (1 / this.workShare - 1))));
        return {
            mode,
            delayMs,
            workShare: this.workShare,
            ...(reason === undefined ? {} : { reason }),
        };
    }
}
