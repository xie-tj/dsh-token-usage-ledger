/** Versioned NDJSON protocol shared by the Host supervisor and backfill worker. */

import type { UsageSessionEvent } from './event-types.ts'
import type {
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
} from './spec.ts'
import type { LedgerMutation } from './reducer.ts'

export const USAGE_LEDGER_WORKER_PROTOCOL = 1

/** JSON-safe provider-owned reader description (kept structural for alpha.5 peers). */
export interface WorkerReaderSpec {
  readonly protocolVersion: number
  readonly workerModule: string
  readonly options?: Readonly<Record<string, boolean | number | string>>
}

/** Runtime contract implemented by a provider-owned reader module. */
export interface WorkerReaderModule {
  readSessionBatches(
    options: Readonly<Record<string, boolean | number | string>> | undefined,
    request: { readonly session: { readonly id: string; readonly cwd?: string }; readonly fromSeq: number; readonly batchEvents: number },
    signal?: AbortSignal,
  ): AsyncIterable<WorkerReaderBatch>
}

/** Bounded event batch returned from a provider-owned reader. */
export interface WorkerReaderBatch {
  readonly meta: { readonly id: string }
  readonly inheritedEventCount: number
  readonly events: readonly UsageSessionEvent[]
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
    readonly backfillDays: number
    readonly workerBatchEvents: number
    readonly workerSliceMs: number
    readonly workerMaxHeapMiB: number
  }
  readonly readerSpec?: WorkerReaderSpec
  readonly sessions: readonly WorkerSession[]
  readonly liveSessionIds: readonly string[]
  readonly cursors: readonly { readonly sessionId: string; readonly row: UsageLedgerSessionRow }[]
  readonly calls: readonly { readonly key: string; readonly row: UsageLedgerCallRow }[]
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

export type WorkerRequestFrame =
  | WorkerInitFrame
  | WorkerLiveFrame
  | WorkerDisposeFrame
  | WorkerRescanFrame
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

export interface WorkerMutationFrame {
  readonly type: 'mutation'
  readonly mutations: readonly LedgerMutation[]
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
  | WorkerMutationFrame
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
