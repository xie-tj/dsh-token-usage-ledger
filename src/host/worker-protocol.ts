/** Versioned NDJSON protocol shared by the Host supervisor and backfill worker. */

import type { UsageSessionEvent } from './event-types.ts'

export const USAGE_LEDGER_WORKER_PROTOCOL = 1

/** JSON-safe provider-owned reader description (kept structural for alpha.5 peers). */
export interface WorkerReaderSpec {
  readonly protocolVersion: number
  readonly workerModule: string
  readonly options?: Readonly<Record<string, boolean | number | string>>
  /** The worker module streams its own session headers without a Host list(). */
  readonly supportsSessionListing?: boolean
}

/** Runtime contract implemented by a provider-owned reader module. */
export interface WorkerReaderModule {
  readSessionBatches(
    options: Readonly<Record<string, boolean | number | string>> | undefined,
    request: { readonly session: { readonly id: string; readonly cwd?: string }; readonly fromSeq: number; readonly batchEvents: number },
    signal?: AbortSignal,
  ): AsyncIterable<WorkerReaderBatch>
  /** Stream stored session headers without materializing the provider's catalog. */
  listSessionHeaders?: (
    options: Readonly<Record<string, boolean | number | string>> | undefined,
    request: { readonly createdAtAfter?: number; readonly createdAtBefore?: number },
    signal?: AbortSignal,
  ) => AsyncIterable<WorkerListedSession>
}

/** Bounded event batch returned from a provider-owned reader. */
export interface WorkerReaderBatch {
  readonly meta: { readonly id: string }
  readonly inheritedEventCount: number
  readonly events: readonly UsageSessionEvent[]
}

/** One stored lifecycle discovered by a provider-owned background lister. */
export interface WorkerListedSession {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
}

/** Compact session identity sent over IPC. */
export interface WorkerSession {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly inheritedEventCount: number
}

export interface WorkerInitFrame {
  readonly type: 'init'
  readonly protocolVersion: number
  readonly config: {
    readonly databasePath: string
    readonly backfillScope: 'all' | 'recent'
    readonly backfillDays: number
    readonly workerBatchEvents: number
    readonly workerSliceMs: number
    readonly workerMaxHeapMiB: number
    readonly workerMaxActiveAttempts: number
  }
  readonly readerSpec?: WorkerReaderSpec
  /** Fallback history for providers without streaming session listing. */
  readonly sessions: readonly WorkerSession[]
  readonly liveSessionIds: readonly string[]
}

export interface WorkerLiveFrame {
  readonly type: 'live'
  readonly session: WorkerSession
  readonly event: UsageSessionEvent
}

export interface WorkerDisposeFrame {
  readonly type: 'dispose'
  readonly session: WorkerSession
}

export interface WorkerRescanFrame {
  readonly type: 'rescan'
  readonly session: WorkerSession
}

export interface WorkerStopFrame {
  readonly type: 'stop'
}

/** Host workload signal controlling only historical scanning, never live events. */
export interface WorkerPaceFrame {
  readonly type: 'pace'
  readonly mode: 'run' | 'pause'
  readonly delayMs: number
  readonly reason?: 'battery' | 'event-loop' | 'memory'
}

export type WorkerRequestFrame =
  | WorkerInitFrame
  | WorkerLiveFrame
  | WorkerDisposeFrame
  | WorkerRescanFrame
  | WorkerPaceFrame
  | WorkerStopFrame

export interface WorkerProgressFrame {
  readonly type: 'progress'
  readonly status: 'idle' | 'running' | 'paused' | 'failed'
  readonly totalSessions: number
  readonly processedSessions: number
  readonly processedEvents: number
  readonly currentSessionId?: string
  readonly backfillDays: number
}

export interface WorkerCheckpointFrame {
  readonly type: 'checkpoint'
  readonly sessionId: string
  readonly observedSeq: number
}

export interface WorkerErrorFrame {
  readonly type: 'error'
  readonly message: string
  readonly sessionId?: string
  readonly fatal?: boolean
}

export interface WorkerDoneFrame {
  readonly type: 'done'
  readonly sessionId?: string
}

export type WorkerResponseFrame =
  | WorkerProgressFrame
  | WorkerCheckpointFrame
  | WorkerErrorFrame
  | WorkerDoneFrame

/** Serialize a single protocol frame with exactly one newline. */
export function encodeWorkerFrame(frame: WorkerRequestFrame | WorkerResponseFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/** Parse and minimally validate an incoming NDJSON frame. */
export function decodeWorkerFrame(line: string): WorkerRequestFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string') {
    return undefined
  }
  return value as WorkerRequestFrame
}
