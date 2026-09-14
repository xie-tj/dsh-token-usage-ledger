/**
 * Pure usage-ledger reducer used by the isolated backfill worker.
 *
 * It owns only compact call/cursor state and emits idempotent mutations. The
 * Host process applies those mutations to SQLite; no session payload or
 * storage write is needed on the model-request path.
 * @module dsh-plugin-usage-ledger/reducer
 */
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
/** Fold one or more compact events and emit only derived storage mutations. */
export class UsageLedgerReducer {
    calls = new Map();
    cursors = new Map();
    routes = new Map();
    constructor(seed = {}) {
        for (const entry of seed.calls ?? [])
            this.calls.set(entry.key, entry.row);
        for (const entry of seed.cursors ?? [])
            this.cursors.set(entry.sessionId, entry.row);
    }
    /** Return a copy of the current durable call rows for Host snapshots/tests. */
    callEntries() {
        return this.calls.entries();
    }
    /** Return the reducer cursor for one lifecycle, if one has been observed. */
    cursor(sessionId) {
        return this.cursors.get(sessionId);
    }
    /** Apply one bounded event batch in sequence order. */
    applyBatch(session, events) {
        const mutations = [];
        const sink = mutation => { mutations.push(mutation); };
        const stored = this.cursors.get(session.id);
        let current = sameLifecycle(stored, session) ? stored : this.emptySessionRow(session);
        let route = this.routes.get(session.id) ?? { provider: 'unknown', model: 'unknown' };
        const previousObserved = current.observedSeq;
        for (const event of events) {
            route = routeAfter(route, event);
            if (event.seq < session.inheritedEventCount || event.seq <= current.observedSeq)
                continue;
            current = { ...this.processEvent(session, current, event, route, sink), observedSeq: event.seq };
        }
        this.routes.set(session.id, route);
        if (current.observedSeq !== previousObserved) {
            this.cursors.set(session.id, current);
            sink({ type: 'cursor-upsert', sessionId: session.id, row: current });
        }
        return mutations;
    }
    /** Remove a disposed lifecycle cursor while retaining its historical calls. */
    dispose(session) {
        const stored = this.cursors.get(session.id);
        this.cursors.delete(session.id);
        this.routes.delete(session.id);
        if (!sameLifecycle(stored, session))
            return [];
        return [{ type: 'cursor-delete', sessionId: session.id, createdAt: session.createdAt }];
    }
    emptySessionRow(session) {
        return {
            createdAt: session.createdAt,
            ...(session.cwd === undefined ? {} : { workspace: session.cwd }),
            observedSeq: session.inheritedEventCount - 1,
            activeAttempts: {},
            successfulAttempts: {},
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
    createAttempt(session, current, turn, step, startedAt, provider, model, attemptId, sink) {
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
        return { ...current, activeAttempts: { ...current.activeAttempts, [stepKey(turn, step)]: attemptId } };
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
        const attemptId = current.successfulAttempts[step] ?? current.activeAttempts[step];
        if (attemptId !== undefined) {
            if (data.usage !== undefined) {
                this.replaceFinalUsage(session, current, data.turn, data.step, data.usage, sink);
            }
            const key = callKey(session, attemptId);
            const row = this.calls.get(key);
            if (row !== undefined) {
                const next = this.calls.get(key) ?? row;
                const outcome = row.outcome ?? (data.interrupted === true ? 'aborted' : 'success');
                this.putCall(key, { ...next, outcome }, sink);
            }
            const activeAttempts = { ...current.activeAttempts };
            Reflect.deleteProperty(activeAttempts, step);
            return {
                ...current,
                activeAttempts,
                successfulAttempts: data.interrupted === true
                    ? current.successfulAttempts
                    : { ...current.successfulAttempts, [step]: attemptId },
            };
        }
        const legacy = legacyAttemptId(data.turn, data.step);
        const key = callKey(session, legacy);
        const existing = this.calls.get(key);
        if (existing === undefined) {
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
        }
        else if (existing.finalUsage === undefined && data.usage !== undefined) {
            this.putCall(key, {
                ...existing,
                finalUsage: usageOf(data.usage),
                outcome: existing.outcome ?? (data.interrupted === true ? 'aborted' : 'success'),
            }, sink);
        }
        return data.interrupted === true
            ? current
            : { ...current, successfulAttempts: { ...current.successfulAttempts, [step]: legacy } };
    }
    recordProvisionalUsage(session, current, event, route, usage, sink) {
        const step = stepKey(event.data.turn, event.data.step);
        const attemptId = current.activeAttempts[step] ?? createUsageAttemptId(`stream:${event.data.turn}:${event.data.step}:${event.seq}`);
        const key = callKey(session, attemptId);
        const existing = this.calls.get(key);
        if (existing === undefined) {
            this.putCall(key, {
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
                provisionalUsage: usageOf(usage),
            }, sink);
        }
        else {
            this.putCall(key, { ...existing, provisionalUsage: usageOf(usage) }, sink);
        }
        return { ...current, activeAttempts: { ...current.activeAttempts, [step]: attemptId } };
    }
    replaceFinalUsage(session, current, turn, step, usage, sink) {
        const attemptId = current.successfulAttempts[stepKey(turn, step)] ?? current.activeAttempts[stepKey(turn, step)];
        if (attemptId === undefined)
            return current;
        const key = callKey(session, attemptId);
        const row = this.calls.get(key);
        if (row !== undefined)
            this.putCall(key, { ...row, finalUsage: usageOf(usage) }, sink);
        return current;
    }
    processRetry(session, current, event, sink) {
        const step = stepKey(event.data.turn, event.data.step);
        const attemptId = current.activeAttempts[step];
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
        let activeAttempts = { ...current.activeAttempts };
        for (const [step, attemptId] of Object.entries(activeAttempts)) {
            const row = this.calls.get(callKey(session, attemptId));
            if (row === undefined || row.turn !== turn)
                continue;
            if (row.outcome === undefined)
                this.putCall(callKey(session, attemptId), { ...row, outcome }, sink);
            Reflect.deleteProperty(activeAttempts, step);
        }
        return { ...current, activeAttempts };
    }
}
