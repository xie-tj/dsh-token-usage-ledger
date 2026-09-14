import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { UsageWorkerSupervisor } from '../src/host/supervisor.ts'
import type { WorkerInitFrame, WorkerResponseFrame } from '../src/host/worker-protocol.ts'

const marker = join(tmpdir(), 'dsh-usage-ledger-restart-fixture.marker')

describe('UsageWorkerSupervisor', () => {
  it('restarts a crashed child with a refreshed initialization snapshot', async () => {
    await rm(marker, { force: true })
    const responses: WorkerResponseFrame[] = []
    const failures: string[] = []
    const init: WorkerInitFrame = {
      type: 'init',
      protocolVersion: 1,
      config: { backfillDays: 30, workerBatchEvents: 256, workerSliceMs: 25, workerMaxHeapMiB: 512 },
      sessions: [],
      liveSessionIds: [],
      cursors: [],
      calls: [],
    }
    const supervisor = new UsageWorkerSupervisor({
      onResponse: frame => { responses.push(frame) },
      onFailure: message => { failures.push(message) },
    }, fileURLToPath(new URL('./fixtures/restart-worker.mjs', import.meta.url)))
    supervisor.start(init, () => init)
    const deadline = Date.now() + 4000
    while (!responses.some(frame => frame.type === 'progress' && frame.status === 'idle') && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    expect(responses.some(frame => frame.type === 'progress' && frame.status === 'idle')).toBe(true)
    expect(failures.some(message => message.includes('exited'))).toBe(true)
    await supervisor.stop()
    await rm(marker, { force: true })
  })
})
