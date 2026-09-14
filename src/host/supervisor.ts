/** Crash-contained child-process supervisor for the Usage Ledger reducer. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { encodeWorkerFrame } from './worker-protocol.ts'
import type {
  WorkerInitFrame,
  WorkerLiveFrame,
  WorkerRequestFrame,
  WorkerResponseFrame,
} from './worker-protocol.ts'

const RESTART_MIN_DELAY_MS = 250
const RESTART_MAX_DELAY_MS = 5000
const MAX_PENDING_SESSIONS = 1024

export interface WorkerSupervisorCallbacks {
  readonly onResponse: (frame: WorkerResponseFrame) => void
  readonly onFailure: (message: string) => void
}

function safeWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'NODE_OPTIONS' || key.startsWith('DSH_')) continue
    if (/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH)/i.test(key)) continue
    env[key] = value
  }
  return env
}

function defaultWorkerPath(): string {
  const url = import.meta.url.endsWith('.ts')
    ? new URL('../../lib/backfill-worker.js', import.meta.url)
    : new URL('./backfill-worker.js', import.meta.url)
  return fileURLToPath(url)
}

/**
 * Keep the main process responsive when the worker pipe is full. Live frames
 * are coalesced by session; the next provider-backed rescan repairs any
 * sequence gap after persistence catches up.
 */
export class UsageWorkerSupervisor {
  private child: ChildProcessWithoutNullStreams | undefined
  private output: Interface | undefined
  private initFrame: WorkerInitFrame | undefined
  private blocked = false
  private stopping = false
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private restartDelay = RESTART_MIN_DELAY_MS
  private refreshInit: (() => WorkerInitFrame) | undefined
  private restarting = false
  private readonly pendingLive = new Map<string, WorkerLiveFrame>()
  private readonly pendingControl = new Map<string, WorkerRequestFrame>()
  private exitPromise: Promise<void> | undefined
  private resolveExit: (() => void) | undefined

  constructor(
    private readonly callbacks: WorkerSupervisorCallbacks,
    private readonly workerPath = defaultWorkerPath(),
  ) {}

  /** Start or replace the child with a complete initialization snapshot. */
  start(frame: WorkerInitFrame, refreshInit?: () => WorkerInitFrame): void {
    this.initFrame = frame
    this.refreshInit = refreshInit
    this.stopping = false
    this.spawnWorker()
  }

  /** Send one compact live event, merging it when stdin applies backpressure. */
  sendLive(frame: WorkerLiveFrame): void {
    if (this.child === undefined || this.stopping || this.blocked || this.pendingLive.size > 0) {
      this.pendingLive.set(frame.session.id, frame)
      this.trimPending(this.pendingLive)
      return
    }
    this.write(frame)
  }

  /** Send a control frame, also coalesced per session while the pipe is full. */
  sendControl(frame: WorkerRequestFrame, key: string): void {
    if (this.child === undefined || this.stopping || this.blocked || this.pendingLive.size > 0) {
      this.pendingControl.set(key, frame)
      this.trimPending(this.pendingControl)
      return
    }
    this.write(frame)
  }

  /** Stop without making plugin disposal wait for a wedged worker. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const child = this.child
    if (child === undefined) return
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      this.write({ type: 'stop' })
      child.stdin.end()
    }
    const exit = this.exitPromise ?? Promise.resolve()
    await Promise.race([
      exit,
      new Promise<void>(resolve => setTimeout(resolve, 1000)),
    ])
    if (this.child !== undefined && !this.child.killed) this.child.kill('SIGTERM')
    this.child = undefined
    this.output?.close()
    this.output = undefined
  }

  private spawnWorker(): void {
    if (this.stopping || this.initFrame === undefined) return
    if (this.restarting && this.refreshInit !== undefined) {
      try {
        this.initFrame = this.refreshInit()
      } catch (error: unknown) {
        this.failed(`usage ledger worker restart snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.restarting = false
    const nodeArgs = [`--max-old-space-size=${String(this.initFrame.config.workerMaxHeapMiB ?? 512)}`, this.workerPath]
    const command = process.platform === 'win32' ? process.execPath : 'nice'
    const args = process.platform === 'win32'
      ? nodeArgs
      : ['-n', '10', process.execPath, ...nodeArgs]
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: safeWorkerEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error: unknown) {
      this.failed(error)
      return
    }
    this.child = child
    this.blocked = false
    this.exitPromise = new Promise<void>(resolve => { this.resolveExit = resolve })
    this.output = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.output.on('line', line => {
      let frame: WorkerResponseFrame
      try {
        frame = JSON.parse(line) as WorkerResponseFrame
      } catch {
        this.failed(new Error('usage ledger worker emitted invalid JSON'))
        return
      }
      this.callbacks.onResponse(frame)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text.length > 0) this.callbacks.onFailure(`usage ledger worker: ${text.slice(-500)}`)
    })
    child.stdin.on('error', error => { this.failed(error) })
    child.on('error', error => { this.failed(error) })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.output?.close()
      this.output = undefined
      this.resolveExit?.()
      this.resolveExit = undefined
      if (this.stopping) return
      this.callbacks.onFailure(`usage ledger worker exited (${String(code ?? signal ?? 'unknown')})`)
      this.restarting = true
      const delay = this.restartDelay
      this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_DELAY_MS)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined
        this.spawnWorker()
      }, delay)
    })
    this.restartDelay = RESTART_MIN_DELAY_MS
    this.write(this.initFrame)
    this.flushPending()
  }

  private write(frame: WorkerRequestFrame | undefined): void {
    if (frame === undefined || this.child === undefined || (this.stopping && frame.type !== 'stop')) return
    try {
      if (!this.child.stdin.write(encodeWorkerFrame(frame))) {
        this.blocked = true
        this.child.stdin.once('drain', () => {
          this.blocked = false
          this.flushPending()
        })
      }
    } catch (error: unknown) {
      this.failed(error)
    }
  }

  private flushPending(): void {
    if (this.blocked || this.child === undefined || this.stopping) return
    const control = this.pendingControl.values().next().value as WorkerRequestFrame | undefined
    if (control !== undefined) {
      const key = control.type === 'dispose' || control.type === 'rescan' ? control.session.id : control.type
      this.pendingControl.delete(key)
      this.write(control)
      if (this.blocked) return
    }
    const live = this.pendingLive.values().next().value as WorkerLiveFrame | undefined
    if (live !== undefined) {
      this.pendingLive.delete(live.session.id)
      this.write(live)
    }
  }

  private trimPending<T>(pending: Map<string, T>): void {
    while (pending.size > MAX_PENDING_SESSIONS) {
      const oldest = pending.keys().next().value as string | undefined
      if (oldest === undefined) return
      pending.delete(oldest)
    }
  }

  private failed(error: unknown): void {
    this.callbacks.onFailure(error instanceof Error ? error.message : String(error))
  }
}
