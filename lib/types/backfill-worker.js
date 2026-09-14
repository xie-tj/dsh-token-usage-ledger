/** Private Usage Ledger worker entry; never exposed as a public CLI binary. */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { UsageLedgerReducer } from "./host/reducer.js";
import { decodeWorkerFrame, encodeWorkerFrame, USAGE_LEDGER_WORKER_PROTOCOL, } from "./host/worker-protocol.js";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopped = false;
let initialized = false;
let init;
let reducer;
let reader;
let sessionOrder = [];
let historyIndex = 0;
let readonlyLive = new Set();
const liveEvents = new Map();
const priority = new Map();
let pumping = false;
let readerLoad;
let outputChain = Promise.resolve();
let processedSessions = 0;
let processedEvents = 0;
let lastProgressAt = 0;
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
    });
    return outputChain;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function sessionForTask(task) {
    return task.session;
}
function queueLive(session, event) {
    const bySeq = liveEvents.get(session.id) ?? new Map();
    bySeq.set(event.seq, event);
    // A stalled reader must not turn a burst of chunk notifications into an
    // unbounded worker heap. Missing rows are recoverable from the provider log.
    if (bySeq.size > 2048) {
        const oldest = [...bySeq.keys()].sort((left, right) => left - right)[0];
        if (oldest !== undefined)
            bySeq.delete(oldest);
    }
    liveEvents.set(session.id, bySeq);
    priority.set(session.id, { session, rescan: false });
}
function takeNextTask() {
    const live = priority.values().next().value;
    if (live !== undefined) {
        priority.delete(live.session.id);
        return live;
    }
    const next = sessionOrder[historyIndex];
    historyIndex += next === undefined ? 0 : 1;
    return next;
}
function markProgress(status, currentSessionId) {
    return send({
        type: 'progress',
        status,
        totalSessions: sessionOrder.length,
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
function emitMutations(sessionId, mutations) {
    if (mutations.length === 0)
        return Promise.resolve();
    return send({ type: 'mutation', mutations }).then(() => {
        const cursor = mutations.find(mutation => mutation.type === 'cursor-upsert');
        if (cursor?.type === 'cursor-upsert') {
            return send({ type: 'checkpoint', sessionId, observedSeq: cursor.row.observedSeq });
        }
    });
}
async function processLive(session) {
    const events = liveEvents.get(session.id);
    if (events === undefined || events.size === 0 || reducer === undefined)
        return;
    const ordered = [...events.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, event]) => event);
    const cursor = reducer.resumeSeq(session) - 1;
    const requiresReaderGapFill = reader !== undefined;
    if (requiresReaderGapFill && ordered[0] !== undefined && ordered[0].seq > cursor + 1)
        return;
    liveEvents.delete(session.id);
    const mutations = reducer.applyBatch(session, ordered);
    processedEvents += ordered.length;
    await emitMutations(session.id, mutations);
}
async function processReaderBatch(session, current) {
    if (reducer === undefined)
        return;
    const effective = current.meta.id === session.id
        ? { ...session, inheritedEventCount: current.inheritedEventCount }
        : session;
    const mutations = reducer.applyBatch(effective, current.events);
    processedEvents += current.events.length;
    await emitMutations(session.id, mutations);
}
async function processSession(task) {
    if (reducer === undefined || init === undefined)
        return;
    const session = sessionForTask(task);
    let sliceStarted = performance.now();
    await processLive(session);
    if (reader !== undefined && !stopped) {
        const fromSeq = reducer.resumeSeq(session);
        const batches = reader.readSessionBatches(init.readerSpec?.options, { session: { id: session.id, ...(session.cwd === undefined ? {} : { cwd: session.cwd }) }, fromSeq, batchEvents: init.config.workerBatchEvents });
        for await (const current of batches) {
            if (stopped)
                return;
            await processReaderBatch(session, current);
            await processLive(session);
            const elapsed = performance.now() - sliceStarted;
            if (elapsed >= init.config.workerSliceMs) {
                await markProgress('running', session.id);
                await new Promise(resolve => setImmediate(resolve));
                sliceStarted = performance.now();
            }
        }
    }
    else {
        await processLive(session);
    }
    if (liveEvents.get(session.id)?.size !== undefined) {
        const pending = liveEvents.get(session.id);
        if (pending !== undefined && pending.size > 0) {
            setTimeout(() => {
                if (stopped)
                    return;
                priority.set(session.id, { session, rescan: true });
                void pump();
            }, 100);
        }
    }
    processedSessions += 1;
    await send({ type: 'done', sessionId: session.id });
}
async function pump() {
    if (pumping || stopped || !initialized)
        return;
    pumping = true;
    try {
        try {
            await loadReader();
        }
        catch (error) {
            reader = undefined;
            readerLoad = Promise.resolve();
            await send({ type: 'error', message: `provider-owned reader disabled: ${errorMessage(error)}` });
        }
        while (!stopped) {
            const task = takeNextTask();
            if (task === undefined)
                break;
            try {
                await markProgress('running', task.session.id);
                await processSession(task);
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
            await markProgress(reader === undefined ? 'paused' : 'idle');
    }
    catch (error) {
        await send({ type: 'error', message: errorMessage(error), fatal: true });
        await markProgress('failed');
    }
    finally {
        pumping = false;
        if (!stopped && (priority.size > 0 || historyIndex < sessionOrder.length))
            void pump();
    }
}
function handleInit(frame) {
    if (initialized)
        return;
    if (frame.protocolVersion !== USAGE_LEDGER_WORKER_PROTOCOL) {
        void send({ type: 'error', message: `unsupported worker protocol ${String(frame.protocolVersion)}`, fatal: true });
        stopped = true;
        return;
    }
    init = frame;
    reducer = new UsageLedgerReducer({ calls: frame.calls, cursors: frame.cursors });
    sessionOrder = frame.sessions.map(session => ({ session, rescan: true }));
    readonlyLive = new Set(frame.liveSessionIds);
    for (const session of frame.sessions) {
        if (readonlyLive.has(session.id))
            priority.set(session.id, { session, rescan: true });
    }
    initialized = true;
    void pump();
}
function handleFrame(frame) {
    switch (frame.type) {
        case 'init':
            handleInit(frame);
            return;
        case 'live':
            if (!initialized)
                return;
            queueLive(frame.session, frame.event);
            void pump();
            return;
        case 'rescan':
            if (!initialized)
                return;
            priority.set(frame.session.id, { session: frame.session, rescan: true });
            void pump();
            return;
        case 'dispose':
            if (!initialized || reducer === undefined)
                return;
            liveEvents.delete(frame.session.id);
            priority.delete(frame.session.id);
            void emitMutations(frame.session.id, reducer.dispose(frame.session));
            return;
        case 'stop':
            stopped = true;
            input.close();
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
});
