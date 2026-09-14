/** Pure bounded reducer used by the isolated Usage Ledger worker. */
import { createUsageAttemptId } from "./event-types.js";
function stepKey(turn, step) {
    return `${turn}:${step}`;
}
function usageOf(usage) {
    return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    };
}
function callKey(session, attemptId) {
    return JSON.stringify([session.id, session.createdAt, attemptId]);
}
function legacyAttemptId(turn, step) {
    return createUsageAttemptId(`legacy:${turn}:${step}`);
}
function sameLifecycle(row, session) {
    return row !== undefined && row.createdAt === session.createdAt && row.workspace === session.cwd;
}
function routeAfter(route, event) {
    if (event.type === 'request/header') {
        const data = event.data;
        return { provider: data.header.config.provider, model: data.header.config.model };
    }
    if (event.type === 'request/context')
        return { provider: event.data.provider, model: event.data.model };
    return route;
}
/**
 * Fold one session at a time. The reducer retains only active attempts, so a
 * multi-year ledger never becomes a worker heap.
 */
export class UsageLedgerReducer {
    maxActiveAttempts;
    calls = new Map();
    cursorRow;
    constructor(seed = {}, maxActiveAttempts = 256) {
        this.maxActiveAttempts = maxActiveAttempts;
        this.cursorRow = seed.cursor;
        if (Object.keys(seed.cursor?.activeAttempts ?? {}).length > maxActiveAttempts) {
            throw new Error('usage ledger session active attempt count exceeds workerMaxActiveAttempts');
        }
        for (const entry of seed.calls ?? [])
            this.calls.set(entry.key, entry.row);
    }
    /** Return the cursor for the session currently loaded into this reducer. */
    cursor(session) {
        return sameLifecycle(this.cursorRow, session) ? this.cursorRow : undefined;
    }
    /** Return the first sequence that needs replay for this session lifecycle. */
    resumeSeq(session) {
        const stored = this.cursor(session);
        if (stored === undefined)
            return session.inheritedEventCount;
        return Math.max(session.inheritedEventCount, stored.observedSeq + 1);
    }
    /** Apply one bounded event batch and return durable call/cursor changes. */
    applyBatch(session, events) {
        const mutations = [];
        const sink = mutation => { mutations.push(mutation); };
        let current = this.cursor(session) ?? this.emptySessionRow(session);
        let route = current.route ?? { provider: 'unknown', model: 'unknown' };
        const previousObserved = current.observedSeq;
        for (const event of events) {
            if (event.seq < session.inheritedEventCount || event.seq <= current.observedSeq)
                continue;
            route = routeAfter(route, event);
            current = {
                ...this.processEvent(session, current, event, route, sink),
                observedSeq: event.seq,
                route,
            };
        }
        if (current.observedSeq !== previousObserved) {
            this.cursorRow = current;
            sink({ type: 'cursor-upsert', sessionId: session.id, row: current });
        }
        return mutations;
    }
    /** Discard transient in-memory state after a live lifecycle is disposed. */
    dispose() {
        this.calls.clear();
    }
    emptySessionRow(session) {
        return {
            createdAt: session.createdAt,
            ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
            observedSeq: session.inheritedEventCount - 1,
            activeAttempts: {},
        };
    }
    processEvent(session, current, event, route, sink) {
        switch (event.type) {
            case 'llm/request-attempt':
                return event.data.phase === 'start'
                    ? this.createAttempt(session, current, event.data.turn, event.data.step, event.data.startedAt, event.data.provider, event.data.model, event.data.attemptId, sink)
                    : this.endAttempt(session, current, event.data.attemptId, event.data.outcome, sink);
            case 'llm/retry-started':
                return this.createAttempt(session, current, event.data.turn, event.data.step, event.time, route.provider, route.model, createUsageAttemptId(`retry:${String(event.data.retryId)}:${event.data.retry}`), sink);
            case 'step/start':
                return this.createAttempt(session, current, event.data.turn, event.data.step, event.time, route.provider, route.model, createUsageAttemptId(`step:${event.data.turn}:${event.data.step}`), sink);
            case 'request/header':
            case 'request/context':
                return this.updateActiveRoute(session, current, route, sink);
            case 'turn/end':
                return event.data.reason.kind === 'error'
                    ? this.terminateActive(session, current, event.data.turn, 'failure', sink)
                    : event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted'
                        ? this.terminateActive(session, current, event.data.turn, 'aborted', sink)
                        : current;
            case 'llm/retry':
                return this.processRetry(session, current, event, sink);
            case 'assistant/chunk':
                if (event.data.chunk.type === 'usage') {
                    return this.recordProvisionalUsage(session, current, event, route, event.data.chunk.usage, sink);
                }
                if (event.data.chunk.type === 'finish') {
                    return this.recordFinish(session, current, event, event.data.chunk.reason.kind, sink);
                }
                return current;
            case 'assistant/message':
                return this.processAssistantMessage(session, current, event, route, sink);
            default:
                return current;
        }
    }
    putCall(key, row, sink) {
        this.calls.set(key, row);
        sink({ type: 'call-upsert', key, row });
    }
    removeCall(session, attemptId) {
        this.calls.delete(callKey(session, attemptId));
    }
    createAttempt(session, current, turn, step, startedAt, provider, model, attemptId, sink) {
        const stepId = stepKey(turn, step);
        const priorAttempt = current.activeAttempts[stepId];
        if (priorAttempt === undefined && Object.keys(current.activeAttempts).length >= this.maxActiveAttempts) {
            throw new Error('usage ledger session active attempt count exceeds workerMaxActiveAttempts');
        }
        if (priorAttempt !== undefined && priorAttempt !== attemptId)
            this.removeCall(session, priorAttempt);
        const key = callKey(session, attemptId);
        if (this.calls.get(key) === undefined) {
            this.putCall(key, {
                sessionId: session.id,
                createdAt: session.createdAt,
                ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
                day: new Date(startedAt).toISOString().slice(0, 10),
                attemptId,
                turn,
                step,
                provider,
                model,
                startedAt,
            }, sink);
        }
        return { ...current, activeAttempts: { ...current.activeAttempts, [stepId]: attemptId } };
    }
    endAttempt(session, current, attemptId, outcome, sink) {
        const key = callKey(session, attemptId);
        const row = this.calls.get(key);
        if (row !== undefined && row.outcome !== outcome)
            this.putCall(key, { ...row, outcome }, sink);
        const activeAttempts = { ...current.activeAttempts };
        for (const [step, active] of Object.entries(activeAttempts)) {
            if (active === attemptId)
                Reflect.deleteProperty(activeAttempts, step);
        }
        this.removeCall(session, attemptId);
        return { ...current, activeAttempts };
    }
    updateActiveRoute(session, current, route, sink) {
        for (const attemptId of Object.values(current.activeAttempts)) {
            const key = callKey(session, attemptId);
            const row = this.calls.get(key);
            if (row !== undefined && (row.provider !== route.provider || row.model !== route.model)) {
                this.putCall(key, { ...row, provider: route.provider, model: route.model }, sink);
            }
        }
        return current;
    }
    recordFinish(session, current, event, kind, sink) {
        const attemptId = current.activeAttempts[stepKey(event.data.turn, event.data.step)];
        if (attemptId === undefined)
            return current;
        const key = callKey(session, attemptId);
        const row = this.calls.get(key);
        if (row === undefined || row.outcome !== undefined)
            return current;
        const outcome = kind === 'error'
            ? 'failure'
            : kind === 'aborted'
                ? 'aborted'
                : kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens'
                    ? 'success'
                    : undefined;
        if (outcome !== undefined)
            this.putCall(key, { ...row, outcome }, sink);
        return current;
    }
    processAssistantMessage(session, current, event, route, sink) {
        const data = event.data;
        const step = stepKey(data.turn, data.step);
        const attemptId = current.activeAttempts[step];
        if (attemptId !== undefined) {
            const key = callKey(session, attemptId);
            const existing = this.calls.get(key);
            const row = existing ?? {
                sessionId: session.id,
                createdAt: session.createdAt,
                ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
                day: new Date(event.time).toISOString().slice(0, 10),
                attemptId,
                turn: data.turn,
                step: data.step,
                provider: route.provider,
                model: route.model,
                startedAt: event.time,
            };
            this.putCall(key, {
                ...row,
                ...(data.usage === undefined ? {} : { finalUsage: usageOf(data.usage) }),
                outcome: row.outcome ?? (data.interrupted === true ? 'aborted' : 'success'),
            }, sink);
            const activeAttempts = { ...current.activeAttempts };
            Reflect.deleteProperty(activeAttempts, step);
            this.removeCall(session, attemptId);
            return { ...current, activeAttempts };
        }
        const legacy = legacyAttemptId(data.turn, data.step);
        const key = callKey(session, legacy);
        this.putCall(key, {
            sessionId: session.id,
            createdAt: session.createdAt,
            ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
            day: new Date(event.time).toISOString().slice(0, 10),
            attemptId: legacy,
            turn: data.turn,
            step: data.step,
            provider: route.provider,
            model: route.model,
            startedAt: event.time,
            outcome: data.interrupted === true ? 'aborted' : 'success',
            ...(data.usage === undefined ? {} : { finalUsage: usageOf(data.usage) }),
        }, sink);
        this.removeCall(session, legacy);
        return current;
    }
    recordProvisionalUsage(session, current, event, route, usage, sink) {
        const step = stepKey(event.data.turn, event.data.step);
        const attemptId = current.activeAttempts[step] ?? createUsageAttemptId(`stream:${event.data.turn}:${event.data.step}:${event.seq}`);
        const key = callKey(session, attemptId);
        const existing = this.calls.get(key);
        const row = existing ?? {
            sessionId: session.id,
            createdAt: session.createdAt,
            ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
            day: new Date(event.time).toISOString().slice(0, 10),
            attemptId,
            turn: event.data.turn,
            step: event.data.step,
            provider: route.provider,
            model: route.model,
            startedAt: event.time,
        };
        this.putCall(key, { ...row, provisionalUsage: usageOf(usage) }, sink);
        return { ...current, activeAttempts: { ...current.activeAttempts, [step]: attemptId } };
    }
    processRetry(session, current, event, sink) {
        const attemptId = current.activeAttempts[stepKey(event.data.turn, event.data.step)];
        if (attemptId === undefined)
            return current;
        const key = callKey(session, attemptId);
        const row = this.calls.get(key);
        if (row !== undefined) {
            this.putCall(key, {
                ...row,
                ...(row.outcome === undefined ? { outcome: 'failure' } : {}),
                retryScheduled: true,
            }, sink);
        }
        return current;
    }
    terminateActive(session, current, turn, outcome, sink) {
        const activeAttempts = { ...current.activeAttempts };
        for (const [step, attemptId] of Object.entries(activeAttempts)) {
            if (!step.startsWith(`${String(turn)}:`))
                continue;
            const key = callKey(session, attemptId);
            const row = this.calls.get(key);
            if (row !== undefined && row.outcome === undefined)
                this.putCall(key, { ...row, outcome }, sink);
            Reflect.deleteProperty(activeAttempts, step);
            this.removeCall(session, attemptId);
        }
        return { ...current, activeAttempts };
    }
}
