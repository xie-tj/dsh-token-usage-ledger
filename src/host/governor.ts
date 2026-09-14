/** Adaptive pacing policy for best-effort historical Usage Ledger replay. */

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

/** Configured workload limits used to derive one worker pacing command. */
export interface UsageLedgerAdaptiveConfig {
  readonly powerMode: 'ac-only' | 'always'
  readonly minDelayMs: number
  readonly maxDelayMs: number
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
  readonly reason?: 'battery' | 'event-loop' | 'memory'
}

/** Stateful fast-backoff / slow-recovery controller. */
export class UsageLedgerGovernor {
  private delayMs: number
  private healthySamples = 0

  constructor(private readonly config: UsageLedgerAdaptiveConfig) {
    this.delayMs = config.minDelayMs
  }

  /** Update the worker pace from one Host workload sample. */
  observe(sample: UsageLedgerLoadSample): UsageLedgerPace {
    if (this.config.powerMode === 'ac-only' && sample.powerSource !== 'ac') {
      this.healthySamples = 0
      return { mode: 'pause', delayMs: this.config.maxDelayMs, reason: 'battery' }
    }
    if (sample.rssMiB >= this.config.pauseRssMiB
      || (this.config.pauseAvailableMemoryMiB > 0
        && sample.availableMemoryMiB !== undefined
        && sample.availableMemoryMiB <= this.config.pauseAvailableMemoryMiB)) {
      this.healthySamples = 0
      return { mode: 'pause', delayMs: this.config.maxDelayMs, reason: 'memory' }
    }
    if (sample.eventLoopUtilization >= this.config.pauseEventLoopUtilization
      || sample.eventLoopDelayMs >= this.config.pauseEventLoopDelayMs) {
      this.healthySamples = 0
      return { mode: 'pause', delayMs: this.config.maxDelayMs, reason: 'event-loop' }
    }
    if (sample.eventLoopUtilization >= this.config.busyEventLoopUtilization
      || sample.eventLoopDelayMs >= this.config.busyEventLoopDelayMs) {
      this.healthySamples = 0
      this.delayMs = Math.min(
        this.config.maxDelayMs,
        Math.max(this.config.minDelayMs, Math.max(1, this.delayMs) * 2),
      )
      return { mode: 'run', delayMs: this.delayMs, reason: 'event-loop' }
    }
    this.healthySamples += 1
    if (this.healthySamples >= this.config.recoverySamples) {
      this.healthySamples = 0
      this.delayMs = Math.max(this.config.minDelayMs, Math.floor(this.delayMs * 0.75))
    }
    return { mode: 'run', delayMs: this.delayMs }
  }
}
