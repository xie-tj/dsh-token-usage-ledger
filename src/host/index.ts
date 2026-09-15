/** Host-side Usage Ledger coordinator with an adaptive isolated history worker. */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm-retry'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { UsageLedgerDatabase, openUsageLedgerDatabase } from './database.ts'
import { UsageLedgerGovernor } from './governor.ts'
import type {
  UsageLedgerAdaptiveConfig,
  UsageLedgerPace,
  UsageLedgerPowerSource,
} from './governor.ts'
import type {
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
} from './spec.ts'
import type {
  UsageLedgerDailyRow,
  UsageLedgerEvent,
  UsageLedgerExportRequest,
  UsageLedgerExportResult,
  UsageLedgerModelRow,
  UsageLedgerSnapshot,
  UsageLedgerSnapshotRequest,
  UsageLedgerStatus,
} from './types.ts'
import type { UsageSessionEvent } from './event-types.ts'
import { USAGE_LEDGER_WORKER_PROTOCOL } from './worker-protocol.ts'
import type {
  WorkerInitFrame,
  WorkerReaderSpec,
  WorkerResponseFrame,
  WorkerSession,
} from './worker-protocol.ts'
import { UsageWorkerSupervisor } from './supervisor.ts'

export type * from './types.ts'
export {
  usageLedgerCallRowSchema,
  usageLedgerSessionRowSchema,
} from './spec.ts'
export type {
  UsageLedgerAttemptOutcome,
  UsageLedgerCallRow,
  UsageLedgerSessionRow,
  UsageLedgerTokenUsage,
} from './spec.ts'
export type { UsageAttemptId, UsageRequestAttemptEvent } from './event-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    usageLedger: UsageLedgerService
  }
}

const DEFAULT_DAYS = 30
const MAX_DAYS = 366
const DEFAULT_BATCH_EVENTS = 256
const DEFAULT_SLICE_MS = 25
const DEFAULT_HEAP_MIB = 512
const DEFAULT_MAX_ACTIVE_ATTEMPTS = 256
const DEFAULT_EVENT_LIMIT = 256
const DEFAULT_SCAN_BATCH_ROWS = 256
const DEFAULT_SAMPLE_INTERVAL_MS = 2_000
const DEFAULT_MAX_DELAY_MS = 60_000
const DEFAULT_INITIAL_WORK_SHARE = 0.1
const DEFAULT_MIN_WORK_SHARE = 0.05
const DEFAULT_MAX_WORK_SHARE = 0.5
const DEFAULT_AIMD_INCREASE = 0.05
const DEFAULT_AIMD_DECREASE = 0.5
const DEFAULT_RECOVERY_SAMPLES = 5
const DEFAULT_BUSY_ELU = 0.35
const DEFAULT_PAUSE_ELU = 0.7
const DEFAULT_BUSY_DELAY_MS = 40
const DEFAULT_PAUSE_DELAY_MS = 150
const DEFAULT_PAUSE_RSS_MIB = 1_024
const DEFAULT_PAUSE_AVAILABLE_MIB = 0
const POWER_PROBE_INTERVAL_MS = 30_000

/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
export const USAGE_LEDGER_SETTINGS_NAMESPACE = 'usage-ledger' as const
type UsageLedgerSettings = Readonly<Record<string, never>>
const UsageLedgerSettingsSchema = z.object({}) as unknown as z<UsageLedgerSettings>

/** Enable or disable the isolated historical reader process. */
export type UsageLedgerBackfillMode = 'process' | 'off'

/** Select automatic replay for all retained history or only the priority window. */
export type UsageLedgerBackfillScope = 'all' | 'recent'

/** Runtime configuration for the background ledger coordinator. */
export interface Config {
  /** Private SQLite path supplied by the bundle patch through dshHomePath(). */
  readonly databasePath?: string
  readonly backfillMode?: UsageLedgerBackfillMode
  /** All scans older retained sessions after the recent priority window. */
  readonly backfillScope?: UsageLedgerBackfillScope
  /** Recent window processed before older history. */
  readonly backfillDays?: number
  readonly workerMaxHeapMiB?: number
  /** Maximum unfinished attempts retained for one malformed or stalled session. */
  readonly workerMaxActiveAttempts?: number
  readonly workerBatchEvents?: number
  readonly workerSliceMs?: number
  /** Pause historical scanning when the Mac is not confirmed to be on AC power. */
  readonly backfillPowerMode?: UsageLedgerAdaptiveConfig['powerMode']
  readonly loadSampleIntervalMs?: number
  readonly backfillMaxDelayMs?: number
  readonly backfillInitialWorkShare?: number
  readonly backfillMinWorkShare?: number
  readonly backfillMaxWorkShare?: number
  readonly backfillAimdIncrease?: number
  readonly backfillAimdDecrease?: number
  readonly backfillRecoverySamples?: number
  readonly backfillBusyEventLoopUtilization?: number
  readonly backfillPauseEventLoopUtilization?: number
  readonly backfillBusyEventLoopDelayMs?: number
  readonly backfillPauseEventLoopDelayMs?: number
  readonly backfillPauseRssMiB?: number
  readonly backfillPauseAvailableMemoryMiB?: number
  /** Maximum detailed call rows returned by one snapshot. Aggregates remain complete. */
  readonly snapshotEventLimit?: number
  /** Rows read per event-loop turn while projecting one snapshot. */
  readonly snapshotScanBatchRows?: number
}

interface ResolvedConfig {
  readonly databasePath: string
  readonly backfillMode: UsageLedgerBackfillMode
  readonly backfillScope: UsageLedgerBackfillScope
  readonly backfillDays: number
  readonly workerMaxHeapMiB: number
  readonly workerMaxActiveAttempts: number
  readonly workerBatchEvents: number
  readonly workerSliceMs: number
  readonly snapshotEventLimit: number
  readonly snapshotScanBatchRows: number
  readonly adaptive: UsageLedgerAdaptiveConfig & { readonly sampleIntervalMs: number }
}

const BackfillModeSchema = z.union([z.const('process'), z.const('off')])
const BackfillScopeSchema = z.union([z.const('all'), z.const('recent')])
const PowerModeSchema = z.union([z.const('ac-only'), z.const('always')])

const ZERO_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  retryRequests: 0,
  meteredRequests: 0,
  unmeteredRequests: 0,
} as const

interface ResolvedSnapshotRequest {
  readonly workspace: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly all: boolean
  readonly days: number
  readonly throughDay: string
  readonly timeZone: string
}

interface LedgerRange {
  readonly fromDay: string
  readonly days: number
  readonly start: number
  readonly end: number
}

interface PersistenceReaderRuntime {
  list(): Promise<unknown>
  backgroundReaderSpec?: () => unknown
}

interface ListedSession {
  readonly header: SessionHeader
}

function resolveConfig(config: Config): ResolvedConfig {
  const databasePath = config.databasePath
  if (typeof databasePath !== 'string' || databasePath.length === 0) {
    throw new TypeError('usage ledger databasePath must be configured by the profile patch')
  }
  const backfillMode = config.backfillMode ?? 'process'
  const backfillScope = config.backfillScope ?? 'all'
  const backfillDays = config.backfillDays ?? DEFAULT_DAYS
  const workerMaxHeapMiB = config.workerMaxHeapMiB ?? DEFAULT_HEAP_MIB
  const workerMaxActiveAttempts = config.workerMaxActiveAttempts ?? DEFAULT_MAX_ACTIVE_ATTEMPTS
  const workerBatchEvents = config.workerBatchEvents ?? DEFAULT_BATCH_EVENTS
  const workerSliceMs = config.workerSliceMs ?? DEFAULT_SLICE_MS
  const snapshotEventLimit = config.snapshotEventLimit ?? DEFAULT_EVENT_LIMIT
  const snapshotScanBatchRows = config.snapshotScanBatchRows ?? DEFAULT_SCAN_BATCH_ROWS
  const adaptive = {
    powerMode: config.backfillPowerMode ?? 'ac-only',
    sampleIntervalMs: config.loadSampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
    maxDelayMs: config.backfillMaxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    sliceMs: workerSliceMs,
    initialWorkShare: config.backfillInitialWorkShare ?? DEFAULT_INITIAL_WORK_SHARE,
    minWorkShare: config.backfillMinWorkShare ?? DEFAULT_MIN_WORK_SHARE,
    maxWorkShare: config.backfillMaxWorkShare ?? DEFAULT_MAX_WORK_SHARE,
    additiveIncrease: config.backfillAimdIncrease ?? DEFAULT_AIMD_INCREASE,
    multiplicativeDecrease: config.backfillAimdDecrease ?? DEFAULT_AIMD_DECREASE,
    recoverySamples: config.backfillRecoverySamples ?? DEFAULT_RECOVERY_SAMPLES,
    busyEventLoopUtilization: config.backfillBusyEventLoopUtilization ?? DEFAULT_BUSY_ELU,
    pauseEventLoopUtilization: config.backfillPauseEventLoopUtilization ?? DEFAULT_PAUSE_ELU,
    busyEventLoopDelayMs: config.backfillBusyEventLoopDelayMs ?? DEFAULT_BUSY_DELAY_MS,
    pauseEventLoopDelayMs: config.backfillPauseEventLoopDelayMs ?? DEFAULT_PAUSE_DELAY_MS,
    pauseRssMiB: config.backfillPauseRssMiB ?? DEFAULT_PAUSE_RSS_MIB,
    pauseAvailableMemoryMiB: config.backfillPauseAvailableMemoryMiB ?? DEFAULT_PAUSE_AVAILABLE_MIB,
  }
  if (backfillMode !== 'process' && backfillMode !== 'off') throw new RangeError('usage ledger backfillMode is invalid: ' + String(backfillMode))
  if (backfillScope !== 'all' && backfillScope !== 'recent') throw new RangeError('usage ledger backfillScope is invalid: ' + String(backfillScope))
  if (adaptive.powerMode !== 'ac-only' && adaptive.powerMode !== 'always') throw new RangeError('usage ledger backfillPowerMode is invalid: ' + String(adaptive.powerMode))
  for (const [name, value, min, max] of [
    ['backfillDays', backfillDays, 1, MAX_DAYS],
    ['workerMaxHeapMiB', workerMaxHeapMiB, 128, 4096],
    ['workerMaxActiveAttempts', workerMaxActiveAttempts, 1, 4096],
    ['workerBatchEvents', workerBatchEvents, 1, 4096],
    ['workerSliceMs', workerSliceMs, 1, 1_000],
    ['snapshotEventLimit', snapshotEventLimit, 1, 4_096],
    ['snapshotScanBatchRows', snapshotScanBatchRows, 1, 4_096],
    ['loadSampleIntervalMs', adaptive.sampleIntervalMs, 100, 60_000],
    ['backfillMaxDelayMs', adaptive.maxDelayMs, 1, 60_000],
    ['backfillRecoverySamples', adaptive.recoverySamples, 1, 1_000],
    ['backfillBusyEventLoopDelayMs', adaptive.busyEventLoopDelayMs, 1, 60_000],
    ['backfillPauseEventLoopDelayMs', adaptive.pauseEventLoopDelayMs, 1, 60_000],
    ['backfillPauseRssMiB', adaptive.pauseRssMiB, 64, 1_048_576],
    ['backfillPauseAvailableMemoryMiB', adaptive.pauseAvailableMemoryMiB, 0, 1_048_576],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError('usage ledger ' + name + ' must be a safe integer from ' + String(min) + ' through ' + String(max))
    }
  }
  for (const [name, value] of [
    ['backfillInitialWorkShare', adaptive.initialWorkShare],
    ['backfillMinWorkShare', adaptive.minWorkShare],
    ['backfillMaxWorkShare', adaptive.maxWorkShare],
    ['backfillAimdIncrease', adaptive.additiveIncrease],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new RangeError('usage ledger ' + name + ' must be a number greater than 0 through 1')
    }
  }
  if (!Number.isFinite(adaptive.multiplicativeDecrease)
    || adaptive.multiplicativeDecrease <= 0
    || adaptive.multiplicativeDecrease >= 1) {
    throw new RangeError('usage ledger backfillAimdDecrease must be greater than 0 and less than 1')
  }
  if (adaptive.minWorkShare > adaptive.initialWorkShare || adaptive.initialWorkShare > adaptive.maxWorkShare) {
    throw new RangeError('usage ledger work shares must satisfy min <= initial <= max')
  }
  for (const [name, value] of [
    ['backfillBusyEventLoopUtilization', adaptive.busyEventLoopUtilization],
    ['backfillPauseEventLoopUtilization', adaptive.pauseEventLoopUtilization],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) throw new RangeError('usage ledger ' + name + ' must be a number greater than 0 through 1')
  }
  if (adaptive.busyEventLoopUtilization > adaptive.pauseEventLoopUtilization) throw new RangeError('usage ledger busy utilization must not exceed pause utilization')
  if (adaptive.busyEventLoopDelayMs > adaptive.pauseEventLoopDelayMs) throw new RangeError('usage ledger busy event-loop delay must not exceed pause delay')
  return {
    databasePath,
    backfillMode,
    backfillScope,
    backfillDays,
    workerMaxHeapMiB,
    workerMaxActiveAttempts,
    workerBatchEvents,
    workerSliceMs,
    snapshotEventLimit,
    snapshotScanBatchRows,
    adaptive,
  }
}

/** Format an epoch timestamp as a calendar day in an IANA timezone. */
function zoneDay(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(time))
  const year = parts.find(part => part.type === 'year')?.value
  const month = parts.find(part => part.type === 'month')?.value
  const day = parts.find(part => part.type === 'day')?.value
  if (year === undefined || month === undefined || day === undefined) throw new Error('usage ledger could not format date in timezone ' + timeZone)
  return year + '-' + month + '-' + day
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

function shiftDay(day: string, offset: number): string {
  const instant = new Date(day + 'T00:00:00.000Z')
  instant.setUTCDate(instant.getUTCDate() + offset)
  return utcDay(instant.getTime())
}

function dayCount(fromDay: string, throughDay: string): number {
  return Math.round((Date.parse(throughDay + 'T00:00:00.000Z') - Date.parse(fromDay + 'T00:00:00.000Z')) / 86_400_000) + 1
}

function zoneOffset(time: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(time))
  const number = (kind: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find(part => part.type === kind)?.value
    if (value === undefined) throw new Error('usage ledger could not resolve time zone part ' + kind)
    return Number(value)
  }
  return Date.UTC(number('year'), number('month') - 1, number('day'), number('hour'), number('minute'), number('second')) - time
}

/** Resolve a local calendar midnight to an epoch, including normal DST offset changes. */
function zoneDayStart(day: string, timeZone: string): number {
  const [year, month, date] = day.split('-').map(Number)
  if (year === undefined || month === undefined || date === undefined) throw new Error('usage ledger received invalid day ' + day)
  const base = Date.UTC(year, month - 1, date)
  let candidate = base - zoneOffset(base, timeZone)
  candidate = base - zoneOffset(candidate, timeZone)
  return candidate
}

function resolveSnapshotRequest(request: UsageLedgerSnapshotRequest | undefined): ResolvedSnapshotRequest {
  const workspace = request?.workspace ?? null
  const provider = request?.provider ?? null
  const model = request?.model ?? null
  const all = request?.all ?? false
  const days = request?.days ?? DEFAULT_DAYS
  const timeZone = request?.timeZone ?? 'UTC'
  for (const [name, value] of [['workspace', workspace], ['provider', provider], ['model', model]] as const) {
    if (value !== null && typeof value !== 'string') throw new TypeError('usage ledger ' + name + ' must be a string or null')
  }
  if (typeof timeZone !== 'string' || timeZone.length === 0) throw new TypeError('usage ledger timeZone must be a non-empty IANA timezone')
  if (typeof all !== 'boolean') throw new TypeError('usage ledger all must be a boolean')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new RangeError('usage ledger timeZone is invalid: ' + timeZone)
  }
  if (!all && (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS)) throw new RangeError('usage ledger days must be a safe integer from 1 through ' + String(MAX_DAYS))
  return { workspace, provider, model, all, days, throughDay: zoneDay(Date.now(), timeZone), timeZone }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateHeader(value: unknown): SessionHeader {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.version)
    || typeof value.id !== 'string'
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || typeof value.isSeeded !== 'boolean'
    || (value.cwd !== undefined && typeof value.cwd !== 'string')
    || (value.parentSession !== undefined && typeof value.parentSession !== 'string')
    || (value.origin !== undefined && value.origin !== 'subagent')
    || (value.delegationDepth !== undefined && (typeof value.delegationDepth !== 'number' || !Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0))
    || (value.agentPreset !== undefined && typeof value.agentPreset !== 'string')) {
    throw new TypeError('usage ledger received invalid session metadata')
  }
  return value as unknown as SessionHeader
}

async function listFallbackSessions(persistence: SessionPersistence, scope: UsageLedgerBackfillScope, days: number): Promise<readonly ListedSession[]> {
  const runtime = persistence as unknown as PersistenceReaderRuntime
  const listed = await runtime.list()
  if (!Array.isArray(listed)) throw new TypeError('usage ledger received an invalid session listing')
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const result: ListedSession[] = []
  for (const value of listed) {
    const record = isRecord(value) && isRecord(value.header) ? value.header : value
    const header = validateHeader(record)
    if (scope === 'all' || header.createdAt >= cutoff) result.push({ header })
  }
  return result
}

function validateReaderSpec(value: unknown): WorkerReaderSpec | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.protocolVersion !== 'number' || typeof value.workerModule !== 'string' || value.workerModule.length === 0) {
    throw new TypeError('usage ledger received an invalid background reader spec')
  }
  if (value.options !== undefined && (!isRecord(value.options)
    || Object.values(value.options).some(option => typeof option !== 'string' && typeof option !== 'number' && typeof option !== 'boolean'))) {
    throw new TypeError('usage ledger background reader options must be JSON-safe primitives')
  }
  if (value.supportsSessionListing !== undefined && typeof value.supportsSessionListing !== 'boolean') {
    throw new TypeError('usage ledger background reader supportsSessionListing must be boolean')
  }
  return value as unknown as WorkerReaderSpec
}

/** Copy only usage-bearing event fields across the process boundary. */
function compactEvent(event: SessionEvent): UsageSessionEvent | undefined {
  const base = { seq: event.seq, time: event.time }
  switch (event.type) {
    case 'step/start':
      return { ...base, type: event.type, data: event.data }
    case 'request/context':
      return { ...base, type: event.type, data: { provider: event.data.provider, model: event.data.model } }
    case 'request/header': {
      const { provider, model } = event.data.header.config
      return {
        ...base,
        type: event.type,
        data: { reason: event.data.reason, header: { config: { provider, model } } },
      } as unknown as UsageSessionEvent
    }
    case 'llm/retry':
      return { ...base, type: event.type, data: { turn: event.data.turn, step: event.data.step } } as UsageSessionEvent
    case 'llm/retry-started':
      return {
        ...base,
        type: event.type,
        data: { retryId: event.data.retryId, turn: event.data.turn, step: event.data.step, retry: event.data.retry },
      }
    case 'turn/end':
      return { ...base, type: event.type, data: { turn: event.data.turn, reason: { kind: event.data.reason.kind } } } as UsageSessionEvent
    case 'assistant/chunk':
      if (event.data.chunk.type === 'usage') {
        return {
          ...base,
          type: event.type,
          data: { turn: event.data.turn, step: event.data.step, chunk: { type: 'usage', usage: event.data.chunk.usage } },
        } as UsageSessionEvent
      }
      if (event.data.chunk.type === 'finish') {
        return {
          ...base,
          type: event.type,
          data: { turn: event.data.turn, step: event.data.step, chunk: { type: 'finish', reason: { kind: event.data.chunk.reason.kind } } },
        } as UsageSessionEvent
      }
      return undefined
    case 'assistant/message':
      return {
        ...base,
        type: event.type,
        data: {
          turn: event.data.turn,
          step: event.data.step,
          ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
          ...(event.data.interrupted === true ? { interrupted: true as const } : {}),
        },
      } as unknown as UsageSessionEvent
    default:
      return undefined
  }
}

function workerSession(session: Session): WorkerSession {
  return {
    id: session.id,
    createdAt: session.header.createdAt,
    ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
    inheritedEventCount: session.inheritedEventCount,
  }
}

function addAttempt<T extends UsageLedgerModelRow | UsageLedgerDailyRow>(row: T, call: UsageLedgerCallRow): T {
  const usage = call.finalUsage ?? call.provisionalUsage
  return {
    ...row,
    inputTokens: row.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: row.outputTokens + (usage?.outputTokens ?? 0),
    cacheReadTokens: row.cacheReadTokens + (usage?.cacheReadTokens ?? 0),
    cacheWriteTokens: row.cacheWriteTokens + (usage?.cacheWriteTokens ?? 0),
    requests: row.requests + 1,
    successfulRequests: row.successfulRequests + (call.outcome === 'success' ? 1 : 0),
    failedRequests: row.failedRequests + (call.outcome === 'failure' || call.outcome === 'aborted' ? 1 : 0),
    retryRequests: row.retryRequests + (call.retryScheduled === true ? 1 : 0),
    meteredRequests: row.meteredRequests + (usage === undefined ? 0 : 1),
    unmeteredRequests: row.unmeteredRequests + (usage === undefined ? 1 : 0),
  }
}

function projectEvents(rows: readonly UsageLedgerCallRow[]): UsageLedgerEvent[] {
  return [...rows].sort((left, right) => left.startedAt - right.startedAt).map((row) => {
    const usage = row.finalUsage ?? row.provisionalUsage
    return {
      at: row.startedAt,
      workspace: row.workspace ?? null,
      provider: row.provider,
      model: row.model,
      outcome: row.outcome ?? 'started',
      retried: row.retryScheduled === true,
      ...(usage === undefined ? {} : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      }),
    }
  })
}

function compareModels(left: UsageLedgerModelRow, right: UsageLedgerModelRow): number {
  return (left.workspace ?? '').localeCompare(right.workspace ?? '')
    || left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model)
}

function csvCell(value: boolean | number | string | undefined): string {
  return '"' + (value === undefined ? '' : String(value)).replaceAll('"', '""') + '"'
}

async function writeCsv(stream: ReturnType<typeof createWriteStream>, row: readonly (boolean | number | string | undefined)[]): Promise<void> {
  if (stream.write(row.map(csvCell).join(',') + '\n')) return
  await once(stream, 'drain')
}

async function powerSource(): Promise<UsageLedgerPowerSource> {
  if (process.platform !== 'darwin') return 'unknown'
  return new Promise(resolve => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 1_000 }, (error, stdout) => {
      if (error !== null) {
        resolve('unknown')
        return
      }
      if (stdout.includes("Now drawing from 'AC Power'")) {
        resolve('ac')
        return
      }
      if (stdout.includes("Now drawing from 'Battery Power'")) {
        resolve('battery')
        return
      }
      resolve('unknown')
    })
  })
}

/** Host service that keeps all heavyweight ledger work outside the task process. */
export class UsageLedgerService extends TypertRemoteService {
  static inject = ['sessions', 'sessionPersistence']
  static Config: z<Config> = z.object({
    databasePath: z.string().required(),
    backfillMode: BackfillModeSchema.default('process'),
    backfillScope: BackfillScopeSchema.default('all'),
    backfillDays: z.number().step(1).min(1).max(MAX_DAYS).default(DEFAULT_DAYS),
    workerMaxHeapMiB: z.number().step(1).min(128).max(4096).default(DEFAULT_HEAP_MIB),
    workerMaxActiveAttempts: z.number().step(1).min(1).max(4096).default(DEFAULT_MAX_ACTIVE_ATTEMPTS),
    workerBatchEvents: z.number().step(1).min(1).max(4096).default(DEFAULT_BATCH_EVENTS),
    workerSliceMs: z.number().step(1).min(1).max(1_000).default(DEFAULT_SLICE_MS),
    backfillPowerMode: PowerModeSchema.default('ac-only'),
    loadSampleIntervalMs: z.number().step(1).min(100).max(60_000).default(DEFAULT_SAMPLE_INTERVAL_MS),
    backfillMaxDelayMs: z.number().step(1).min(1).max(60_000).default(DEFAULT_MAX_DELAY_MS),
    backfillInitialWorkShare: z.number().min(0.001).max(1).default(DEFAULT_INITIAL_WORK_SHARE),
    backfillMinWorkShare: z.number().min(0.001).max(1).default(DEFAULT_MIN_WORK_SHARE),
    backfillMaxWorkShare: z.number().min(0.001).max(1).default(DEFAULT_MAX_WORK_SHARE),
    backfillAimdIncrease: z.number().min(0.001).max(1).default(DEFAULT_AIMD_INCREASE),
    backfillAimdDecrease: z.number().min(0.001).max(0.999).default(DEFAULT_AIMD_DECREASE),
    backfillRecoverySamples: z.number().step(1).min(1).max(1_000).default(DEFAULT_RECOVERY_SAMPLES),
    backfillBusyEventLoopUtilization: z.number().min(0.001).max(1).default(DEFAULT_BUSY_ELU),
    backfillPauseEventLoopUtilization: z.number().min(0.001).max(1).default(DEFAULT_PAUSE_ELU),
    backfillBusyEventLoopDelayMs: z.number().step(1).min(1).max(60_000).default(DEFAULT_BUSY_DELAY_MS),
    backfillPauseEventLoopDelayMs: z.number().step(1).min(1).max(60_000).default(DEFAULT_PAUSE_DELAY_MS),
    backfillPauseRssMiB: z.number().step(1).min(64).max(1_048_576).default(DEFAULT_PAUSE_RSS_MIB),
    backfillPauseAvailableMemoryMiB: z.number().step(1).min(0).max(1_048_576).default(DEFAULT_PAUSE_AVAILABLE_MIB),
    snapshotEventLimit: z.number().step(1).min(1).max(4_096).default(DEFAULT_EVENT_LIMIT),
    snapshotScanBatchRows: z.number().step(1).min(1).max(4_096).default(DEFAULT_SCAN_BATCH_ROWS),
  })

  private readonly resolvedConfig: ResolvedConfig
  private readonly worker: UsageWorkerSupervisor
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 })
  private readonly governor: UsageLedgerGovernor
  private lastUtilization = performance.eventLoopUtilization()
  private hasLoadSample = false
  private database: UsageLedgerDatabase | undefined
  private sampleTimer: ReturnType<typeof setInterval> | undefined
  private powerSource: UsageLedgerPowerSource = 'unknown'
  private lastPowerProbe = 0
  private powerProbe: Promise<void> | undefined
  private pace: UsageLedgerPace | undefined
  private status: UsageLedgerStatus

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'usageLedger', { namespace: 'usageLedgerPlugin' })
    this.resolvedConfig = resolveConfig(config)
    this.governor = new UsageLedgerGovernor(this.resolvedConfig.adaptive)
    this.status = {
      state: this.resolvedConfig.backfillMode === 'off' ? 'paused' : 'idle',
      totalSessions: 0,
      processedSessions: 0,
      processedEvents: 0,
      backfillDays: this.resolvedConfig.backfillDays,
      backfillScope: this.resolvedConfig.backfillScope,
      updatedAt: new Date().toISOString(),
    }
    this.worker = new UsageWorkerSupervisor({
      onResponse: frame => this.handleWorkerResponse(frame),
      onFailure: message => this.recordFailure(message),
    })
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(USAGE_LEDGER_SETTINGS_NAMESPACE, UsageLedgerSettingsSchema)
    })
  }

  /** Open only a bounded SQLite connection; no call rows enter the Host heap. */
  protected async [Service.init](): Promise<void> {
    this.database = await openUsageLedgerDatabase(this.resolvedConfig.databasePath)
    this.ctx.effect(() => async () => {
      this.stopGovernor()
      await this.worker.stop()
      this.database?.close()
      this.database = undefined
    }, 'usage-ledger.database-close')

    this.ctx.on('session/created', session => {
      this.worker.sendControl({ type: 'rescan', session: workerSession(session) }, session.id)
    }, { global: true })
    this.ctx.on('session/event', (session, event) => {
      const compact = compactEvent(event)
      if (compact !== undefined) this.worker.sendLive({ type: 'live', session: workerSession(session), event: compact })
    }, { global: true })
    this.ctx.on('session/disposed', session => {
      this.worker.sendControl({ type: 'dispose', session: workerSession(session) }, session.id)
    }, { global: true })

    if (this.resolvedConfig.backfillMode === 'off') return
    this.startGovernor()
    void this.startWorker(this.ctx.sessionPersistence)
  }

  /** Start independently of task initialization and keep fallback listing out of capable providers. */
  private async startWorker(persistence: SessionPersistence): Promise<void> {
    let readerSpec: WorkerReaderSpec | undefined
    try {
      const runtime = persistence as unknown as PersistenceReaderRuntime
      readerSpec = validateReaderSpec(typeof runtime.backgroundReaderSpec === 'function' ? runtime.backgroundReaderSpec() : undefined)
    } catch (error: unknown) {
      this.recordFailure('provider-owned reader unavailable: ' + (error instanceof Error ? error.message : String(error)))
    }
    let fallback: readonly ListedSession[] = []
    if (readerSpec !== undefined && readerSpec.supportsSessionListing !== true) {
      try {
        fallback = await listFallbackSessions(persistence, this.resolvedConfig.backfillScope, this.resolvedConfig.backfillDays)
      } catch (error: unknown) {
        this.recordFailure('historical session listing failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    try {
      const makeInitFrame = (): WorkerInitFrame => ({
        type: 'init',
        protocolVersion: USAGE_LEDGER_WORKER_PROTOCOL,
        config: {
          databasePath: this.resolvedConfig.databasePath,
          backfillScope: this.resolvedConfig.backfillScope,
          backfillDays: this.resolvedConfig.backfillDays,
          workerBatchEvents: this.resolvedConfig.workerBatchEvents,
          workerSliceMs: this.resolvedConfig.workerSliceMs,
          workerMaxHeapMiB: this.resolvedConfig.workerMaxHeapMiB,
          workerMaxActiveAttempts: this.resolvedConfig.workerMaxActiveAttempts,
        },
        ...(readerSpec === undefined ? {} : { readerSpec }),
        sessions: fallback.map(({ header }) => ({
          id: header.id,
          createdAt: header.createdAt,
          ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
          inheritedEventCount: 0,
        })),
        liveSessionIds: this.ctx.sessions.list().map(session => session.id),
      })
      this.status = {
        ...this.status,
        state: readerSpec === undefined ? 'paused' : 'running',
        totalSessions: fallback.length,
        updatedAt: new Date().toISOString(),
        ...(readerSpec === undefined ? { lastError: 'session persistence does not expose backgroundReaderSpec; historical backfill is paused' } : {}),
      }
      if (readerSpec === undefined) this.ctx.logger.warn('usage ledger: persistence has no provider-owned background reader; live ledger remains enabled')
      this.worker.start(makeInitFrame(), makeInitFrame)
    } catch (error: unknown) {
      this.recordFailure('background worker initialization failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** Return complete aggregates and a bounded event page without materializing the SQLite ledger. */
  @Remote('snapshot')
  async snapshot(request?: UsageLedgerSnapshotRequest): Promise<UsageLedgerSnapshot> {
    const resolved = resolveSnapshotRequest(request)
    const range = this.resolveRange(resolved)
    const { fromDay, days, start, end } = range
    const models = new Map<string, UsageLedgerModelRow>()
    const daily = new Map<string, UsageLedgerDailyRow>()
    const selected: UsageLedgerCallRow[] = []
    let eventsTruncated = false
    for (let offset = 0; offset < days; offset += 1) {
      const day = shiftDay(fromDay, offset)
      daily.set(day, { day, ...ZERO_TOTALS })
    }
    let after: { startedAt: number; key: string } | undefined
    do {
      const page = this.requireDatabase().callsPage({
        startedAtInclusive: start,
        startedAtExclusive: end,
        workspace: resolved.workspace,
        provider: resolved.provider,
        model: resolved.model,
        ...(after === undefined ? {} : { after }),
        limit: this.resolvedConfig.snapshotScanBatchRows,
      })
      for (const { row } of page.rows) {
        const localDay = zoneDay(row.startedAt, resolved.timeZone)
        if (localDay < fromDay || localDay > resolved.throughDay) continue
        if (selected.length < this.resolvedConfig.snapshotEventLimit) selected.push(row)
        else eventsTruncated = true
        const workspace = row.workspace ?? null
        const key = JSON.stringify([workspace, row.provider, row.model])
        const prior = models.get(key) ?? { workspace, provider: row.provider, model: row.model, ...ZERO_TOTALS }
        models.set(key, addAttempt(prior, row))
        const day = daily.get(localDay)
        if (day !== undefined) daily.set(localDay, addAttempt(day, row))
      }
      after = page.next
      if (after !== undefined) await new Promise<void>(resolve => setImmediate(resolve))
    } while (after !== undefined)
    return Object.freeze({
      workspace: resolved.workspace,
      days,
      all: resolved.all,
      fromDay,
      throughDay: resolved.throughDay,
      timeZone: resolved.timeZone,
      updatedAt: new Date().toISOString(),
      events: Object.freeze(projectEvents(selected).map(row => Object.freeze(row))),
      eventsTruncated,
      models: Object.freeze([...models.values()].sort(compareModels).map(row => Object.freeze(row))),
      daily: Object.freeze([...daily.values()].map(row => Object.freeze(row))),
    })
  }

  /** Write all matching call rows in bounded SQLite pages to an owner-only CSV. */
  @Remote('exportCsv')
  async exportCsv(request?: UsageLedgerExportRequest): Promise<UsageLedgerExportResult> {
    const resolved = resolveSnapshotRequest(request)
    const range = this.resolveRange(resolved)
    const databaseDirectory = dirname(resolve(this.resolvedConfig.databasePath))
    const outputDirectory = join(databaseDirectory, 'usage-ledger-exports')
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
    const name = 'usage-ledger-' + new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID() + '.csv'
    const path = join(outputDirectory, name)
    const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 })
    let rows = 0
    try {
      await writeCsv(stream, [
        'sessionId', 'createdAt', 'workspace', 'attemptId', 'turn', 'step',
        'provider', 'model', 'startedAt', 'outcome', 'retryScheduled',
        'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
      ])
      let after: { startedAt: number; key: string } | undefined
      do {
        const page = this.requireDatabase().callsPage({
          startedAtInclusive: range.start,
          startedAtExclusive: range.end,
          workspace: resolved.workspace,
          provider: resolved.provider,
          model: resolved.model,
          ...(after === undefined ? {} : { after }),
          limit: this.resolvedConfig.snapshotScanBatchRows,
        })
        for (const { row } of page.rows) {
          const localDay = zoneDay(row.startedAt, resolved.timeZone)
          if (localDay < range.fromDay || localDay > resolved.throughDay) continue
          const usage = row.finalUsage ?? row.provisionalUsage
          await writeCsv(stream, [
            row.sessionId, row.createdAt, row.workspace, row.attemptId, row.turn, row.step,
            row.provider, row.model, row.startedAt, row.outcome, row.retryScheduled === true,
            usage?.inputTokens, usage?.outputTokens, usage?.cacheReadTokens, usage?.cacheWriteTokens,
          ])
          rows += 1
        }
        after = page.next
        if (after !== undefined) await new Promise<void>(resolve => setImmediate(resolve))
      } while (after !== undefined)
      stream.end()
      await once(stream, 'close')
    } catch (error: unknown) {
      stream.destroy()
      throw error
    }
    return { path, rows, fromDay: range.fromDay, throughDay: resolved.throughDay }
  }

  /** Non-blocking worker and workload state for the Usage page. */
  @Remote('status')
  statusSnapshot(): UsageLedgerStatus {
    return Object.freeze({ ...this.status, ...(this.pace === undefined ? {} : { pace: this.pace }) })
  }

  private handleWorkerResponse(frame: WorkerResponseFrame): void {
    switch (frame.type) {
      case 'progress':
        this.status = {
          ...this.status,
          state: frame.status,
          totalSessions: frame.totalSessions,
          processedSessions: frame.processedSessions,
          processedEvents: frame.processedEvents,
          updatedAt: new Date().toISOString(),
          ...(frame.currentSessionId === undefined ? { currentSessionId: undefined } : { currentSessionId: frame.currentSessionId }),
        }
        return
      case 'checkpoint':
      case 'done':
        return
      case 'error':
        this.recordFailure(frame.sessionId === undefined ? frame.message : 'session ' + frame.sessionId + ': ' + frame.message)
        return
    }
  }

  private startGovernor(): void {
    this.loopDelay.enable()
    void this.sampleLoad()
    this.sampleTimer = setInterval(() => { void this.sampleLoad() }, this.resolvedConfig.adaptive.sampleIntervalMs)
    this.sampleTimer.unref?.()
  }

  private stopGovernor(): void {
    if (this.sampleTimer !== undefined) clearInterval(this.sampleTimer)
    this.sampleTimer = undefined
    this.loopDelay.disable()
  }

  private async sampleLoad(): Promise<void> {
    const now = Date.now()
    if (now - this.lastPowerProbe >= POWER_PROBE_INTERVAL_MS && this.powerProbe === undefined) {
      this.lastPowerProbe = now
      this.powerProbe = powerSource().then(source => {
        this.powerSource = source
      }).catch(() => {
        this.powerSource = 'unknown'
      }).finally(() => {
        this.powerProbe = undefined
      })
      await this.powerProbe
    }
    const utilization = performance.eventLoopUtilization(this.lastUtilization)
    this.lastUtilization = performance.eventLoopUtilization()
    const delayMs = this.loopDelay.percentile(99) / 1_000_000
    this.loopDelay.reset()
    const rssMiB = process.memoryUsage().rss / (1024 * 1024)
    const available = typeof process.availableMemory === 'function'
      ? process.availableMemory() / (1024 * 1024)
      : undefined
    const firstSample = !this.hasLoadSample
    this.hasLoadSample = true
    const next = this.governor.observe({
      powerSource: this.powerSource,
      eventLoopUtilization: firstSample ? 0 : utilization.utilization,
      eventLoopDelayMs: firstSample || !Number.isFinite(delayMs) ? 0 : delayMs,
      rssMiB,
      availableMemoryMiB: available,
    })
    if (this.pace?.mode === next.mode && this.pace.delayMs === next.delayMs && this.pace.reason === next.reason) return
    this.pace = next
    this.worker.sendControl({
      type: 'pace',
      mode: next.mode,
      delayMs: next.delayMs,
      ...(next.reason === undefined ? {} : { reason: next.reason }),
    }, 'pace')
    if (next.mode === 'pause' && this.status.state !== 'failed') {
      this.status = { ...this.status, state: 'paused', updatedAt: new Date().toISOString() }
    }
  }

  private recordFailure(message: string): void {
    this.status = { ...this.status, state: 'failed', lastError: message, updatedAt: new Date().toISOString() }
    this.ctx.logger.warn('usage ledger: ' + message)
  }

  private resolveRange(resolved: ResolvedSnapshotRequest): LedgerRange {
    const earliest = resolved.all
      ? this.requireDatabase().firstCallTime(resolved.workspace, resolved.provider, resolved.model)
      : undefined
    const fromDay = earliest === undefined
      ? resolved.all ? resolved.throughDay : shiftDay(resolved.throughDay, 1 - resolved.days)
      : zoneDay(earliest, resolved.timeZone)
    return {
      fromDay,
      days: resolved.all ? dayCount(fromDay, resolved.throughDay) : resolved.days,
      start: zoneDayStart(fromDay, resolved.timeZone),
      end: zoneDayStart(shiftDay(resolved.throughDay, 1), resolved.timeZone),
    }
  }

  private requireDatabase(): UsageLedgerDatabase {
    if (this.database === undefined) throw new Error('usage ledger is not initialized')
    return this.database
  }
}

export default UsageLedgerService
