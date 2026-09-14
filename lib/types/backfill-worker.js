/** Private Usage Ledger worker entry; never exposed as a public CLI binary. */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { openUsageLedgerDatabase } from "./host/database.js";
import { UsageLedgerReducer } from "./host/reducer.js";
import { decodeWorkerFrame, encodeWorkerFrame, USAGE_LEDGER_WORKER_PROTOCOL, } from "./host/worker-protocol.js";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopped = false;
let initialized = false;
let init;
let database;
let reader;
let readerLoad;
let history;
let historyReady;
let historyDone = false;
const priority = new Map();
const deferredRescans = new Map();
const liveEvents = new Map();
let pumping = false;
let outputChain = Promise.resolve();
let processedSessions = 0;
let processedEvents = 0;
let totalSessions = 0;
let lastProgressAt = 0;
let pace = { mode: 'run', delayMs: 0 };
let wake;
const startupLive = new Map();
const startupControl = new Map();
function send(frame) {
    outputChain = outputChain.then(async () => {
        if (stopped)
            return;
        const line = encodeWorkerFrame(frame);
        if (process.stdout.write(line))
            return;
        await once(process.stdout, 'drain');
    }).catch(() => {
        stopped = true;
        closeDatabase();
    });
    return outputChain;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function notifyWake() {
    const current = wake;
    wake = undefined;
    current?.();
}
function waitForWake() {
    return new Promise(resolve => { wake = resolve; });
}
async function waitForHistoryPermit() {
    while (!stopped && historyPaused())
        await waitForWake();
}
function queueLive(session, event) {
    const bySeq = liveEvents.get(session.id) ?? new Map();
    bySeq.set(event.seq, event);
    // Missing rows are recoverable from a later provider-owned scan. Bound only
    // the notification cache, never the durable source log.
    if (bySeq.size > 2048) {
        const oldest = bySeq.keys().next().value;
        if (oldest !== undefined)
            bySeq.delete(oldest);
    }
    liveEvents.set(session.id, bySeq);
    priority.set(session.id, { session, kind: 'live' });
    notifyWake();
}
function queueRescan(session) {
    const task = { session, kind: 'rescan' };
    if (pace.mode === 'pause') {
        deferredRescans.set(session.id, task);
    }
    else {
        priority.set(session.id, task);
    }
    notifyWake();
}
function moveDeferredRescans() {
    if (pace.mode === 'pause')
        return;
    for (const task of deferredRescans.values())
        priority.set(task.session.id, task);
    deferredRescans.clear();
}
function historyPaused() {
    return pace.mode === 'pause';
}
function markProgress(status, currentSessionId) {
    return send({
        type: 'progress',
        status,
        totalSessions,
        processedSessions,
        processedEvents,
        ...(currentSessionId === undefined ? {} : { currentSessionId }),
        backfillDays: init?.config.backfillDays ?? 0,
    });
}
async function loadReader() {
    if (readerLoad !== undefined)
        return readerLoad;
    readerLoad = (async () => {
        const spec = init?.readerSpec;
        if (spec === undefined)
            return;
        if (spec.protocolVersion !== USAGE_LEDGER_WORKER_PROTOCOL) {
            throw new Error(`unsupported background reader protocol ${String(spec.protocolVersion)}`);
        }
        const imported = await import(__rewriteRelativeImportExtension(spec.workerModule));
        if (typeof imported.readSessionBatches !== 'function'
            && typeof imported.default?.readSessionBatches !== 'function') {
            throw new TypeError('provider-owned background reader does not export readSessionBatches');
        }
        reader = typeof imported.readSessionBatches === 'function'
            ? imported
            : imported.default;
    })();
    return readerLoad;
}
function asWorkerSession(entry) {
    return {
        id: entry.id,
        createdAt: entry.createdAt,
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        inheritedEventCount: 0,
    };
}
function sessionHeaderLister() {
    const lister = reader?.listSessionHeaders;
    return init?.readerSpec?.supportsSessionListing === true && lister !== undefined
        ? lister
        : undefined;
}
async function countHistory() {
    const lister = sessionHeaderLister();
    if (lister === undefined || init === undefined)
        return init?.sessions.length ?? 0;
    const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1000;
    let count = 0;
    for await (const session of lister(init.readerSpec?.options, {
        ...(init.config.backfillScope === 'recent' ? { createdAtAfter: cutoff } : {}),
    })) {
        await waitForHistoryPermit();
        if (stopped)
            return count;
        if (init.config.backfillScope === 'all' || session.createdAt >= cutoff)
            count += 1;
    }
    return count;
}
async function* historySessions() {
    if (init === undefined)
        return;
    const lister = sessionHeaderLister();
    if (lister === undefined) {
        const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1000;
        const selected = init.sessions
            .filter(session => init?.config.backfillScope === 'all' || session.createdAt >= cutoff)
            .sort((left, right) => right.createdAt - left.createdAt);
        yield* selected;
        return;
    }
    const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1000;
    for await (const session of lister(init.readerSpec?.options, { createdAtAfter: cutoff })) {
        await waitForHistoryPermit();
        if (stopped)
            return;
        yield asWorkerSession(session);
    }
    if (init.config.backfillScope === 'recent')
        return;
    for await (const session of lister(init.readerSpec?.options, { createdAtBefore: cutoff })) {
        await waitForHistoryPermit();
        if (stopped)
            return;
        yield asWorkerSession(session);
    }
}
async function prepareHistory() {
    try {
        await loadReader();
    }
    catch (error) {
        reader = undefined;
        readerLoad = Promise.resolve();
        await send({ type: 'error', message: `provider-owned reader disabled: ${errorMessage(error)}` });
    }
    if (reader === undefined) {
        totalSessions = 0;
        historyDone = true;
        return;
    }
    totalSessions = await countHistory();
    history = historySessions();
}
async function takeNextTask() {
    const nextPriority = priority.values().next().value;
    if (nextPriority !== undefined) {
        priority.delete(nextPriority.session.id);
        return nextPriority;
    }
    if (pace.mode === 'pause' || historyDone)
        return undefined;
    if (historyReady === undefined) {
        historyReady = prepareHistory();
    }
    await historyReady;
    const next = await history?.next();
    if (next === undefined || next.done) {
        historyDone = true;
        return undefined;
    }
    return { session: next.value, kind: 'history', countHistory: true };
}
async function persistMutations(session, reducer, mutations) {
    if (mutations.length === 0)
        return;
    requireDatabase().applyMutations(mutations);
    const cursor = reducer.cursor(session);
    if (cursor !== undefined) {
        await send({ type: 'checkpoint', sessionId: session.id, observedSeq: cursor.observedSeq });
    }
}
async function processLive(session, reducer) {
    const events = liveEvents.get(session.id);
    if (events === undefined || events.size === 0)
        return true;
    const ordered = [...events.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, event]) => event);
    if (reader !== undefined && ordered[0] !== undefined && ordered[0].seq > reducer.resumeSeq(session)) {
        queueRescan(session);
        return false;
    }
    liveEvents.delete(session.id);
    const mutations = reducer.applyBatch(session, ordered);
    processedEvents += ordered.length;
    await persistMutations(session, reducer, mutations);
    return true;
}
async function processReaderBatch(session, reducer, current) {
    const effective = current.meta.id === session.id
        ? { ...session, inheritedEventCount: current.inheritedEventCount }
        : session;
    const mutations = reducer.applyBatch(effective, current.events);
    processedEvents += current.events.length;
    await persistMutations(session, reducer, mutations);
}
async function yieldForPace() {
    if (historyPaused()) {
        await waitForWake();
        return;
    }
    if (pace.delayMs > 0) {
        await Promise.race([
            new Promise(resolve => setTimeout(resolve, pace.delayMs)),
            waitForWake(),
        ]);
        return;
    }
    await new Promise(resolve => setImmediate(resolve));
}
/**
 * Process one session until its current slice completes. A saved cursor makes
 * a preempted scan resume from disk without retaining prior calls in memory.
 */
async function processSession(task) {
    if (init === undefined || reader === undefined && task.kind !== 'live')
        return false;
    const session = task.session;
    const seed = requireDatabase().sessionSeed(session.id, session.createdAt, init.config.workerMaxActiveAttempts);
    const reducer = new UsageLedgerReducer(seed, init.config.workerMaxActiveAttempts);
    let sliceStarted = performance.now();
    await processLive(session, reducer);
    if (task.kind === 'live')
        return true;
    if (pace.mode === 'pause') {
        deferredRescans.set(session.id, task);
        return false;
    }
    if (reader === undefined)
        return false;
    const batches = reader.readSessionBatches(init.readerSpec?.options, {
        session: { id: session.id, ...(session.cwd === undefined ? {} : { cwd: session.cwd }) },
        fromSeq: reducer.resumeSeq(session),
        batchEvents: init.config.workerBatchEvents,
    });
    for await (const current of batches) {
        if (stopped)
            return false;
        await processReaderBatch(session, reducer, current);
        await processLive(session, reducer);
        if (performance.now() - sliceStarted < init.config.workerSliceMs)
            continue;
        await markProgress('running', session.id);
        await yieldForPace();
        if (historyPaused()) {
            deferredRescans.set(session.id, task);
            return false;
        }
        if (priority.size > 0) {
            priority.set(session.id, { session, kind: 'rescan', countHistory: task.countHistory });
            return false;
        }
        sliceStarted = performance.now();
    }
    return true;
}
async function pump() {
    if (pumping || stopped || !initialized)
        return;
    pumping = true;
    try {
        while (!stopped) {
            const task = await takeNextTask();
            if (task === undefined)
                break;
            try {
                await markProgress('running', task.session.id);
                const completed = await processSession(task);
                if (completed && task.countHistory === true)
                    processedSessions += 1;
            }
            catch (error) {
                await send({ type: 'error', message: errorMessage(error), sessionId: task.session.id });
            }
            if (performance.now() - lastProgressAt > 500) {
                lastProgressAt = performance.now();
                await markProgress('running');
            }
        }
        if (!stopped)
            await markProgress(pace.mode === 'pause' && !historyDone ? 'paused' : reader === undefined ? 'paused' : 'idle');
    }
    catch (error) {
        await send({ type: 'error', message: errorMessage(error), fatal: true });
        await markProgress('failed');
    }
    finally {
        pumping = false;
        if (!stopped && (priority.size > 0 || !historyDone && pace.mode === 'run'))
            void pump();
    }
}
function requireDatabase() {
    if (database === undefined)
        throw new Error('usage ledger database is not initialized');
    return database;
}
function closeDatabase() {
    const current = database;
    database = undefined;
    current?.close();
}
async function failInitialization(message) {
    await send({ type: 'error', message, fatal: true });
    stopped = true;
    notifyWake();
    input.close();
    closeDatabase();
}
async function initialize(frame) {
    database = await openUsageLedgerDatabase(frame.config.databasePath);
    init = frame;
    initialized = true;
    const controls = [...startupControl.values()];
    const live = [...startupLive.values()];
    startupControl.clear();
    startupLive.clear();
    for (const queued of controls)
        handleFrame(queued);
    for (const queued of live)
        handleFrame(queued);
    void pump();
}
function queueBeforeInitialization(frame) {
    if (frame.type === 'live') {
        startupLive.set(frame.session.id, frame);
        while (startupLive.size > 1_024) {
            const id = startupLive.keys().next().value;
            if (id === undefined)
                break;
            startupLive.delete(id);
        }
        return;
    }
    if (frame.type === 'dispose') {
        startupLive.delete(frame.session.id);
        startupControl.set(frame.session.id, frame);
        return;
    }
    if (frame.type === 'rescan') {
        startupControl.set(frame.session.id, frame);
        return;
    }
    if (frame.type === 'pace') {
        startupControl.set('pace', frame);
        return;
    }
    stopped = true;
    notifyWake();
    input.close();
}
function handleFrame(frame) {
    switch (frame.type) {
        case 'init':
            if (initialized)
                return;
            if (frame.protocolVersion !== USAGE_LEDGER_WORKER_PROTOCOL) {
                void failInitialization('unsupported worker protocol ' + String(frame.protocolVersion));
                return;
            }
            void initialize(frame).catch(error => {
                void failInitialization(errorMessage(error));
            });
            return;
        default:
            if (!initialized) {
                queueBeforeInitialization(frame);
                return;
            }
            break;
    }
    switch (frame.type) {
        case 'live':
            queueLive(frame.session, frame.event);
            void pump();
            return;
        case 'rescan':
            queueRescan(frame.session);
            void pump();
            return;
        case 'dispose':
            liveEvents.delete(frame.session.id);
            priority.delete(frame.session.id);
            deferredRescans.delete(frame.session.id);
            return;
        case 'pace':
            pace = { mode: frame.mode, delayMs: frame.delayMs };
            if (pace.mode === 'run')
                moveDeferredRescans();
            notifyWake();
            void pump();
            return;
        case 'stop':
            stopped = true;
            notifyWake();
            input.close();
            closeDatabase();
            return;
    }
}
input.on('line', (line) => {
    const frame = decodeWorkerFrame(line);
    if (frame === undefined) {
        void send({ type: 'error', message: 'invalid worker protocol frame' });
        return;
    }
    handleFrame(frame);
});
input.on('close', () => {
    stopped = true;
    notifyWake();
    closeDatabase();
});
