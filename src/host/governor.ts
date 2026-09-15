/** Additive-increase/multiplicative-decrease pacing for historical replay. */

/** Power source as observed by the Host platform probe. */
export type UsageLedgerPowerSource = 'ac' | 'battery' | 'unknown'

/** One bounded workload sample from the Host process. */
export interface UsageLedgerLoadSample {
  readonly powerSource: UsageLedgerPowerSource
  readonly eventLoopUtilization: number
  readonly eventLoopDelayMs: number
  readonly rssMiB: number
  readonly availableMemoryMiB: number | undefined
}

/** Configured workload limits and AIMD parameters. */
export interface UsageLedgerAdaptiveConfig {
  readonly powerMode: 'ac-only' | 'always'
  /** Worker compute budget used to turn a share into a pause interval. */
  readonly sliceMs: number
  readonly maxDelayMs: number
  readonly initialWorkShare: number
  readonly minWorkShare: number
  readonly maxWorkShare: number
  /** Additive increase applied after each healthy window. */
  readonly additiveIncrease: number
  /** Multiplicative decrease applied when the Host is busy. */
  readonly multiplicativeDecrease: number
  readonly recoverySamples: number
  readonly busyEventLoopUtilization: number
  readonly pauseEventLoopUtilization: number
  readonly busyEventLoopDelayMs: number
  readonly pauseEventLoopDelayMs: number
  readonly pauseRssMiB: number
  readonly pauseAvailableMemoryMiB: number
}

/** A pace applied only between bounded historical reader slices. */
export interface UsageLedgerPace {
  readonly mode: 'run' | 'pause'
  readonly delayMs: number
  readonly workShare: number
  readonly reason?: 'battery' | 'event-loop' | 'memory'
}

/** Stateful AIMD controller with hard pause gates for power and memory. */
export class UsageLedgerGovernor {
  private workShare: number
  private healthySamples = 0

  constructor(private readonly config: UsageLedgerAdaptiveConfig) {
    this.workShare = config.initialWorkShare
  }

  /** Update the worker pace from one Host workload sample. */
  observe(sample: UsageLedgerLoadSample): UsageLedgerPace {
    if (this.config.powerMode === 'ac-only' && sample.powerSource !== 'ac') {
      return this.paused('battery')
    }
    if (sample.rssMiB >= this.config.pauseRssMiB
      || (this.config.pauseAvailableMemoryMiB > 0
        && sample.availableMemoryMiB !== undefined
        && sample.availableMemoryMiB <= this.config.pauseAvailableMemoryMiB)) {
      return this.paused('memory')
    }
    if (sample.eventLoopUtilization >= this.config.pauseEventLoopUtilization
      || sample.eventLoopDelayMs >= this.config.pauseEventLoopDelayMs) {
      return this.paused('event-loop')
    }
    if (sample.eventLoopUtilization >= this.config.busyEventLoopUtilization
      || sample.eventLoopDelayMs >= this.config.busyEventLoopDelayMs) {
      this.healthySamples = 0
      this.workShare = Math.max(
        this.config.minWorkShare,
        this.workShare * this.config.multiplicativeDecrease,
      )
      return this.current('run', 'event-loop')
    }
    this.healthySamples += 1
    if (this.healthySamples >= this.config.recoverySamples) {
      this.healthySamples = 0
      this.workShare = Math.min(
        this.config.maxWorkShare,
        this.workShare + this.config.additiveIncrease,
      )
    }
    return this.current('run')
  }

  private paused(reason: 'battery' | 'event-loop' | 'memory'): UsageLedgerPace {
    this.healthySamples = 0
    this.workShare = this.config.minWorkShare
    return this.current('pause', reason)
  }

  private current(
    mode: 'run' | 'pause',
    reason?: 'battery' | 'event-loop' | 'memory',
  ): UsageLedgerPace {
    const delayMs = mode === 'pause'
      ? this.config.maxDelayMs
      : Math.min(
        this.config.maxDelayMs,
        Math.max(0, Math.ceil(this.config.sliceMs * (1 / this.workShare - 1))),
      )
    return {
      mode,
      delayMs,
      workShare: this.workShare,
      ...(reason === undefined ? {} : { reason }),
    }
  }
}
