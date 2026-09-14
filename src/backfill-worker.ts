/** Private Usage Ledger worker entry; never exposed as a public CLI binary. */

import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { UsageLedgerDatabase, openUsageLedgerDatabase } from './host/database.ts'
import { UsageLedgerReducer } from './host/reducer.ts'
import type { UsageSessionEvent } from './host/event-types.ts'
import {
  decodeWorkerFrame,
  encodeWorkerFrame,
  USAGE_LEDGER_WORKER_PROTOCOL,
} from './host/worker-protocol.ts'
import type {
  WorkerInitFrame,
  WorkerListedSession,
  WorkerLiveFrame,
  WorkerReaderModule,
  WorkerRequestFrame,
  WorkerResponseFrame,
  WorkerSession,
} from './host/worker-protocol.ts'

type SessionTask = {
  readonly session: WorkerSession
  readonly kind: 'history' | 'rescan' | 'live'
  /** Count a preempted history item only after its final reader pass completes. */
  readonly countHistory?: boolean
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let stopped = false
let initialized = false
let init: WorkerInitFrame | undefined
let database: UsageLedgerDatabase | undefined
let reader: WorkerReaderModule | undefined
let readerLoad: Promise<void> | undefined
let history: AsyncIterator<WorkerSession> | undefined
let historyReady: Promise<void> | undefined
let historyDone = false
const priority = new Map<string, SessionTask>()
const deferredRescans = new Map<string, SessionTask>()
const liveEvents = new Map<string, Map<number, UsageSessionEvent>>()
let pumping = false
let outputChain = Promise.resolve()
let processedSessions = 0
let processedEvents = 0
let totalSessions = 0
let lastProgressAt = 0
let pace: { mode: 'run' | 'pause'; delayMs: number } = { mode: 'run', delayMs: 0 }
let wake: (() => void) | undefined
const startupLive = new Map<string, WorkerLiveFrame>()
const startupControl = new Map<string, WorkerRequestFrame>()

function send(frame: WorkerResponseFrame): Promise<void> {
  outputChain = outputChain.then(async () => {
    if (stopped) return
    const line = encodeWorkerFrame(frame)
    if (process.stdout.write(line)) return
    await once(process.stdout, 'drain')
  }).catch(() => {
    stopped = true
    closeDatabase()
  })
  return outputChain
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notifyWake(): void {
  const current = wake
  wake = undefined
  current?.()
}

function waitForWake(): Promise<void> {
  return new Promise(resolve => { wake = resolve })
}

async function waitForHistoryPermit(): Promise<void> {
  while (!stopped && historyPaused()) await waitForWake()
}

function queueLive(session: WorkerSession, event: UsageSessionEvent): void {
  const bySeq = liveEvents.get(session.id) ?? new Map<number, UsageSessionEvent>()
  bySeq.set(event.seq, event)
  // Missing rows are recoverable from a later provider-owned scan. Bound only
  // the notification cache, never the durable source log.
  if (bySeq.size > 2048) {
    const oldest = bySeq.keys().next().value as number | undefined
    if (oldest !== undefined) bySeq.delete(oldest)
  }
  liveEvents.set(session.id, bySeq)
  priority.set(session.id, { session, kind: 'live' })
  notifyWake()
}

function queueRescan(session: WorkerSession): void {
  const task: SessionTask = { session, kind: 'rescan' }
  if (pace.mode === 'pause') {
    deferredRescans.set(session.id, task)
  } else {
    priority.set(session.id, task)
  }
  notifyWake()
}

function moveDeferredRescans(): void {
  if (pace.mode === 'pause') return
  for (const task of deferredRescans.values()) priority.set(task.session.id, task)
  deferredRescans.clear()
}

function historyPaused(): boolean {
  return pace.mode === 'pause'
}

function markProgress(
  status: 'idle' | 'running' | 'paused' | 'failed',
  currentSessionId?: string,
): Promise<void> {
  return send({
    type: 'progress',
    status,
    totalSessions,
    processedSessions,
    processedEvents,
    ...(currentSessionId === undefined ? {} : { currentSessionId }),
    backfillDays: init?.config.backfillDays ?? 0,
  })
}

async function loadReader(): Promise<void> {
  if (readerLoad !== undefined) return readerLoad
  readerLoad = (async () => {
    const spec = init?.readerSpec
    if (spec === undefined) return
    if (spec.protocolVersion !== USAGE_LEDGER_WORKER_PROTOCOL) {
      throw new Error(`unsupported background reader protocol ${String(spec.protocolVersion)}`)
    }
    const imported = await import(spec.workerModule) as unknown as Partial<WorkerReaderModule> & { default?: Partial<WorkerReaderModule> }
    if (typeof imported.readSessionBatches !== 'function'
      && typeof imported.default?.readSessionBatches !== 'function') {
      throw new TypeError('provider-owned background reader does not export readSessionBatches')
    }
    reader = typeof imported.readSessionBatches === 'function'
      ? imported as WorkerReaderModule
      : imported.default as WorkerReaderModule
  })()
  return readerLoad
}

function asWorkerSession(entry: WorkerListedSession): WorkerSession {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    inheritedEventCount: 0,
  }
}

function sessionHeaderLister(): NonNullable<WorkerReaderModule['listSessionHeaders']> | undefined {
  const lister = reader?.listSessionHeaders
  return init?.readerSpec?.supportsSessionListing === true && lister !== undefined
    ? lister
    : undefined
}

async function countHistory(): Promise<number> {
  const lister = sessionHeaderLister()
  if (lister === undefined || init === undefined) return init?.sessions.length ?? 0
  const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1000
  let count = 0
  for await (const session of lister(init.readerSpec?.options, {
    ...(init.config.backfillScope === 'recent' ? { createdAtAfter: cutoff } : {}),
  })) {
    await waitForHistoryPermit()
    if (stopped) return count
    if (init.config.backfillScope === 'all' || session.createdAt >= cutoff) count += 1
  }
  return count
}

async function* historySessions(): AsyncGenerator<WorkerSession> {
  if (init === undefined) return
  const lister = sessionHeaderLister()
  if (lister === undefined) {
    const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1000
    const selected = init.sessions
      .filter(session => init?.config.backfillScope === 'all' || session.createdAt >= cutoff)
      .sort((left, right) => right.createdAt - left.createdAt)
    yield* selected
    return
  }
  const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1000
  for await (const session of lister(init.readerSpec?.options, { createdAtAfter: cutoff })) {
    await waitForHistoryPermit()
    if (stopped) return
    yield asWorkerSession(session)
  }
  if (init.config.backfillScope === 'recent') return
  for await (const session of lister(init.readerSpec?.options, { createdAtBefore: cutoff })) {
    await waitForHistoryPermit()
    if (stopped) return
    yield asWorkerSession(session)
  }
}

async function prepareHistory(): Promise<void> {
  try {
    await loadReader()
  } catch (error: unknown) {
    reader = undefined
    readerLoad = Promise.resolve()
    await send({ type: 'error', message: `provider-owned reader disabled: ${errorMessage(error)}` })
  }
  if (reader === undefined) {
    totalSessions = 0
    historyDone = true
    return
  }
  totalSessions = await countHistory()
  history = historySessions()
}

async function takeNextTask(): Promise<SessionTask | undefined> {
  const nextPriority = priority.values().next().value as SessionTask | undefined
  if (nextPriority !== undefined) {
    priority.delete(nextPriority.session.id)
    return nextPriority
  }
  if (pace.mode === 'pause' || historyDone) return undefined
  if (historyReady === undefined) {
    historyReady = prepareHistory()
  }
  await historyReady
  const next = await history?.next()
  if (next === undefined || next.done) {
    historyDone = true
    return undefined
  }
  return { session: next.value, kind: 'history', countHistory: true }
}

async function persistMutations(
  session: WorkerSession,
  reducer: UsageLedgerReducer,
  mutations: ReturnType<UsageLedgerReducer['applyBatch']>,
): Promise<void> {
  if (mutations.length === 0) return
  requireDatabase().applyMutations(mutations)
  const cursor = reducer.cursor(session)
  if (cursor !== undefined) {
    await send({ type: 'checkpoint', sessionId: session.id, observedSeq: cursor.observedSeq })
  }
}

async function processLive(session: WorkerSession, reducer: UsageLedgerReducer): Promise<boolean> {
  const events = liveEvents.get(session.id)
  if (events === undefined || events.size === 0) return true
  const ordered = [...events.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, event]) => event)
  if (reader !== undefined && ordered[0] !== undefined && ordered[0].seq > reducer.resumeSeq(session)) {
    queueRescan(session)
    return false
  }
  liveEvents.delete(session.id)
  const mutations = reducer.applyBatch(session, ordered)
  processedEvents += ordered.length
  await persistMutations(session, reducer, mutations)
  return true
}

async function processReaderBatch(
  session: WorkerSession,
  reducer: UsageLedgerReducer,
  current: { readonly meta: { readonly id: string }; readonly inheritedEventCount: number; readonly events: readonly UsageSessionEvent[] },
): Promise<void> {
  const effective = current.meta.id === session.id
    ? { ...session, inheritedEventCount: current.inheritedEventCount }
    : session
  const mutations = reducer.applyBatch(effective, current.events)
  processedEvents += current.events.length
  await persistMutations(session, reducer, mutations)
}

async function yieldForPace(): Promise<void> {
  if (historyPaused()) {
    await waitForWake()
    return
  }
  if (pace.delayMs > 0) {
    await Promise.race([
      new Promise<void>(resolve => setTimeout(resolve, pace.delayMs)),
      waitForWake(),
    ])
    return
  }
  await new Promise<void>(resolve => setImmediate(resolve))
}

/**
 * Process one session until its current slice completes. A saved cursor makes
 * a preempted scan resume from disk without retaining prior calls in memory.
 */
async function processSession(task: SessionTask): Promise<boolean> {
  if (init === undefined || reader === undefined && task.kind !== 'live') return false
  const session = task.session
  const seed = requireDatabase().sessionSeed(session.id, session.createdAt, init.config.workerMaxActiveAttempts)
  const reducer = new UsageLedgerReducer(seed, init.config.workerMaxActiveAttempts)
  let sliceStarted = performance.now()
  await processLive(session, reducer)
  if (task.kind === 'live') return true
  if (pace.mode === 'pause') {
    deferredRescans.set(session.id, task)
    return false
  }
  if (reader === undefined) return false
  const batches = reader.readSessionBatches(
    init.readerSpec?.options,
    {
      session: { id: session.id, ...(session.cwd === undefined ? {} : { cwd: session.cwd }) },
      fromSeq: reducer.resumeSeq(session),
      batchEvents: init.config.workerBatchEvents,
    },
  )
  for await (const current of batches) {
    if (stopped) return false
    await processReaderBatch(session, reducer, current)
    await processLive(session, reducer)
    if (performance.now() - sliceStarted < init.config.workerSliceMs) continue
    await markProgress('running', session.id)
    await yieldForPace()
    if (historyPaused()) {
      deferredRescans.set(session.id, task)
      return false
    }
    if (priority.size > 0) {
      priority.set(session.id, { session, kind: 'rescan', countHistory: task.countHistory })
      return false
    }
    sliceStarted = performance.now()
  }
  return true
}

async function pump(): Promise<void> {
  if (pumping || stopped || !initialized) return
  pumping = true
  try {
    while (!stopped) {
      const task = await takeNextTask()
      if (task === undefined) break
      try {
        await markProgress('running', task.session.id)
        const completed = await processSession(task)
        if (completed && task.countHistory === true) processedSessions += 1
      } catch (error: unknown) {
        await send({ type: 'error', message: errorMessage(error), sessionId: task.session.id })
      }
      if (performance.now() - lastProgressAt > 500) {
        lastProgressAt = performance.now()
        await markProgress('running')
      }
    }
    if (!stopped) await markProgress(pace.mode === 'pause' && !historyDone ? 'paused' : reader === undefined ? 'paused' : 'idle')
  } catch (error: unknown) {
    await send({ type: 'error', message: errorMessage(error), fatal: true })
    await markProgress('failed')
  } finally {
    pumping = false
    if (!stopped && (priority.size > 0 || !historyDone && pace.mode === 'run')) void pump()
  }
}

function requireDatabase(): UsageLedgerDatabase {
  if (database === undefined) throw new Error('usage ledger database is not initialized')
  return database
}

function closeDatabase(): void {
  const current = database
  database = undefined
  current?.close()
}

async function failInitialization(message: string): Promise<void> {
  await send({ type: 'error', message, fatal: true })
  stopped = true
  notifyWake()
  input.close()
  closeDatabase()
}

async function initialize(frame: WorkerInitFrame): Promise<void> {
  database = await openUsageLedgerDatabase(frame.config.databasePath)
  init = frame
  initialized = true
  const controls = [...startupControl.values()]
  const live = [...startupLive.values()]
  startupControl.clear()
  startupLive.clear()
  for (const queued of controls) handleFrame(queued)
  for (const queued of live) handleFrame(queued)
  void pump()
}

function queueBeforeInitialization(frame: Exclude<WorkerRequestFrame, WorkerInitFrame>): void {
  if (frame.type === 'live') {
    startupLive.set(frame.session.id, frame)
    while (startupLive.size > 1_024) {
      const id = startupLive.keys().next().value as string | undefined
      if (id === undefined) break
      startupLive.delete(id)
    }
    return
  }
  if (frame.type === 'dispose') {
    startupLive.delete(frame.session.id)
    startupControl.set(frame.session.id, frame)
    return
  }
  if (frame.type === 'rescan') {
    startupControl.set(frame.session.id, frame)
    return
  }
  if (frame.type === 'pace') {
    startupControl.set('pace', frame)
    return
  }
  stopped = true
  notifyWake()
  input.close()
}

function handleFrame(frame: WorkerRequestFrame): void {
  switch (frame.type) {
    case 'init':
      if (initialized) return
      if (frame.protocolVersion !== USAGE_LEDGER_WORKER_PROTOCOL) {
        void failInitialization('unsupported worker protocol ' + String(frame.protocolVersion))
        return
      }
      void initialize(frame).catch(error => {
        void failInitialization(errorMessage(error))
      })
      return
    default:
      if (!initialized) {
        queueBeforeInitialization(frame)
        return
      }
      break
  }
  switch (frame.type) {
    case 'live':
      queueLive(frame.session, frame.event)
      void pump()
      return
    case 'rescan':
      queueRescan(frame.session)
      void pump()
      return
    case 'dispose':
      liveEvents.delete(frame.session.id)
      priority.delete(frame.session.id)
      deferredRescans.delete(frame.session.id)
      return
    case 'pace':
      pace = { mode: frame.mode, delayMs: frame.delayMs }
      if (pace.mode === 'run') moveDeferredRescans()
      notifyWake()
      void pump()
      return
    case 'stop':
      stopped = true
      notifyWake()
      input.close()
      closeDatabase()
      return
  }
}

input.on('line', (line) => {
  const frame = decodeWorkerFrame(line)
  if (frame === undefined) {
    void send({ type: 'error', message: 'invalid worker protocol frame' })
    return
  }
  handleFrame(frame)
})

input.on('close', () => {
  stopped = true
  notifyWake()
  closeDatabase()
})
