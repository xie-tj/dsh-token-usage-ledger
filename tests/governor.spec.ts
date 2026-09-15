import { describe, expect, it } from 'vitest'
import { UsageLedgerGovernor } from '../src/host/governor.ts'

const config = {
  powerMode: 'ac-only' as const,
  sliceMs: 25,
  maxDelayMs: 10_000,
  initialWorkShare: 0.1,
  minWorkShare: 0.05,
  maxWorkShare: 0.5,
  additiveIncrease: 0.05,
  multiplicativeDecrease: 0.5,
  recoverySamples: 2,
  busyEventLoopUtilization: 0.35,
  pauseEventLoopUtilization: 0.7,
  busyEventLoopDelayMs: 40,
  pauseEventLoopDelayMs: 150,
  pauseRssMiB: 1_024,
  pauseAvailableMemoryMiB: 512,
}

const idle = {
  powerSource: 'ac' as const,
  eventLoopUtilization: 0.05,
  eventLoopDelayMs: 2,
  rssMiB: 128,
  availableMemoryMiB: 4_096,
}

describe('UsageLedgerGovernor', () => {
  it('backs off immediately, pauses under pressure, and recovers only after sustained idle', () => {
    const governor = new UsageLedgerGovernor(config)
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 225, workShare: 0.1 })
    expect(governor.observe({ ...idle, eventLoopUtilization: 0.4 })).toEqual({
      mode: 'run',
      delayMs: 475,
      workShare: 0.05,
      reason: 'event-loop',
    })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 475, workShare: 0.05 })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 225, workShare: 0.1 })
    expect(governor.observe({ ...idle, eventLoopUtilization: 0.8 })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      workShare: 0.05,
      reason: 'event-loop',
    })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 475, workShare: 0.05 })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 225, workShare: 0.1 })
  })

  it('stops historical scans until AC power and memory headroom return', () => {
    const governor = new UsageLedgerGovernor(config)
    expect(governor.observe({ ...idle, powerSource: 'battery' })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      workShare: 0.05,
      reason: 'battery',
    })
    expect(governor.observe({ ...idle, availableMemoryMiB: 256 })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      workShare: 0.05,
      reason: 'memory',
    })
  })
})
