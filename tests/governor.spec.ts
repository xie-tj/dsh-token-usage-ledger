import { describe, expect, it } from 'vitest'
import { UsageLedgerGovernor } from '../src/host/governor.ts'

const config = {
  powerMode: 'ac-only' as const,
  minDelayMs: 25,
  maxDelayMs: 10_000,
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
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 25 })
    expect(governor.observe({ ...idle, eventLoopUtilization: 0.4 })).toEqual({
      mode: 'run',
      delayMs: 50,
      reason: 'event-loop',
    })
    expect(governor.observe({ ...idle, eventLoopUtilization: 0.8 })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      reason: 'event-loop',
    })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 50 })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 37 })
  })

  it('stops historical scans until AC power and memory headroom return', () => {
    const governor = new UsageLedgerGovernor(config)
    expect(governor.observe({ ...idle, powerSource: 'battery' })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      reason: 'battery',
    })
    expect(governor.observe({ ...idle, availableMemoryMiB: 256 })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      reason: 'memory',
    })
  })
})
