import { describe, expect, it } from 'vitest'
import { UsageLedgerGovernor } from '../src/host/governor.ts'

const config = {
  powerMode: 'ac-only' as const,
  sliceMs: 50,
  maxDelayMs: 10_000,
  initialWorkShare: 0.25,
  minWorkShare: 0.1,
  maxWorkShare: 0.8,
  additiveIncrease: 0.1,
  multiplicativeDecrease: 0.5,
  recoverySamples: 2,
  pauseSamples: 2,
  busyEventLoopUtilization: 0.5,
  pauseEventLoopUtilization: 0.9,
  busyEventLoopDelayMs: 100,
  pauseEventLoopDelayMs: 400,
  pauseRssMiB: 2_048,
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
  it('backs off on pressure, pauses only after sustained pressure, and recovers on sustained idle', () => {
    const governor = new UsageLedgerGovernor(config)
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 150, workShare: 0.25 })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 93, workShare: 0.35 })
    expect(governor.observe({ ...idle, eventLoopUtilization: 0.6 })).toEqual({
      mode: 'run',
      delayMs: 236,
      workShare: 0.175,
      reason: 'event-loop',
    })
    expect(governor.observe({ ...idle, eventLoopUtilization: 0.95 })).toEqual({
      mode: 'run',
      delayMs: 450,
      workShare: 0.1,
      reason: 'event-loop',
    })
    expect(governor.observe({ ...idle, eventLoopUtilization: 0.95 })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      workShare: 0.1,
      reason: 'event-loop',
    })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 450, workShare: 0.1 })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 200, workShare: 0.2 })
  })

  it('requires consecutive over-limit samples before pausing historical replay', () => {
    const governor = new UsageLedgerGovernor(config)
    expect(governor.observe({ ...idle, eventLoopDelayMs: 500 })).toEqual({
      mode: 'run',
      delayMs: 350,
      workShare: 0.125,
      reason: 'event-loop',
    })
    expect(governor.observe({ ...idle, eventLoopDelayMs: 500 })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      workShare: 0.1,
      reason: 'event-loop',
    })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 450, workShare: 0.1 })
  })

  it('pauses only on confirmed battery power and restores scanning afterwards', () => {
    const governor = new UsageLedgerGovernor(config)
    expect(governor.observe({ ...idle, powerSource: 'unknown' })).toEqual({ mode: 'run', delayMs: 150, workShare: 0.25 })
    expect(governor.observe({ ...idle, powerSource: 'battery' })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      workShare: 0.1,
      reason: 'battery',
    })
    expect(governor.observe(idle)).toEqual({ mode: 'run', delayMs: 450, workShare: 0.1 })
    expect(governor.observe({ ...idle, availableMemoryMiB: 256 })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      workShare: 0.1,
      reason: 'memory',
    })
  })

  it('ignores power state when the deployment runs unconditionally', () => {
    const governor = new UsageLedgerGovernor({ ...config, powerMode: 'always', pauseRssMiB: 1_024 })
    expect(governor.observe({ ...idle, powerSource: 'battery' })).toEqual({ mode: 'run', delayMs: 150, workShare: 0.25 })
    expect(governor.observe({ ...idle, rssMiB: 4_096 })).toEqual({
      mode: 'pause',
      delayMs: 10_000,
      workShare: 0.1,
      reason: 'memory',
    })
  })
})
