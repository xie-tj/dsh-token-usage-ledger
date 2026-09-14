import { n as encodeWorkerFrame, r as createUsageAttemptId, t as decodeWorkerFrame } from "./worker-protocol-B6MoPLmQ.js";
import { createInterface } from "node:readline";
import { once } from "node:events";
//#region lib/types/host/reducer.js
/**
* Pure usage-ledger reducer used by the isolated backfill worker.
*
* It owns only compact call/cursor state and emits idempotent mutations. The
* Host process applies those mutations to SQLite; no session payload or
* storage write is needed on the model-request path.
* @module dsh-plugin-usage-ledger/reducer
*/
function stepKey(turn, step) {
	return `${turn}:${step}`;
}
function usageOf(usage) {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0
	};
}
function callKey(session, attemptId) {
	return JSON.stringify([
		session.id,
		session.createdAt,
		attemptId
	]);
}
function legacyAttemptId(turn, step) {
	return createUsageAttemptId(`legacy:${turn}:${step}`);
}
function sameLifecycle(row, session) {
	return row !== void 0 && row.createdAt === session.createdAt && row.workspace === session.cwd;
}
function routeAfter(route, event) {
	if (event.type === "request/header") {
		const data = event.data;
		return {
			provider: data.header.config.provider,
			model: data.header.config.model
		};
	}
	if (event.type === "request/context") return {
		provider: event.data.provider,
		model: event.data.model
	};
	return route;
}
/** Fold one or more compact events and emit only derived storage mutations. */
var UsageLedgerReducer = class {
	calls = /* @__PURE__ */ new Map();
	cursors = /* @__PURE__ */ new Map();
	routes = /* @__PURE__ */ new Map();
	routeTimes = /* @__PURE__ */ new Map();
	constructor(seed = {}) {
		for (const entry of seed.calls ?? []) {
			this.calls.set(entry.key, entry.row);
			const route = this.routes.get(entry.row.sessionId);
			const priorTime = this.routeTimes.get(entry.row.sessionId);
			if (route === void 0 || priorTime === void 0 || priorTime <= entry.row.startedAt) {
				this.routes.set(entry.row.sessionId, {
					provider: entry.row.provider,
					model: entry.row.model
				});
				this.routeTimes.set(entry.row.sessionId, entry.row.startedAt);
			}
		}
		for (const entry of seed.cursors ?? []) this.cursors.set(entry.sessionId, entry.row);
	}
	/** Return a copy of the current durable call rows for Host snapshots/tests. */
	callEntries() {
		return this.calls.entries();
	}
	/** Return the reducer cursor for one lifecycle, if one has been observed. */
	cursor(sessionId) {
		return this.cursors.get(sessionId);
	}
	/** Return the first sequence that needs to be replayed for this lifecycle. */
	resumeSeq(session) {
		const stored = this.cursors.get(session.id);
		if (!sameLifecycle(stored, session)) return session.inheritedEventCount;
		return Math.max(session.inheritedEventCount, stored.observedSeq + 1);
	}
	/** Apply one bounded event batch in sequence order. */
	applyBatch(session, events) {
		const mutations = [];
		const sink = (mutation) => {
			mutations.push(mutation);
		};
		const stored = this.cursors.get(session.id);
		let current = sameLifecycle(stored, session) ? stored : this.emptySessionRow(session);
		let route = this.routes.get(session.id) ?? {
			provider: "unknown",
			model: "unknown"
		};
		const previousObserved = current.observedSeq;
		for (const event of events) {
			route = routeAfter(route, event);
			if (event.seq < session.inheritedEventCount || event.seq <= current.observedSeq) continue;
			current = {
				...this.processEvent(session, current, event, route, sink),
				observedSeq: event.seq
			};
		}
		this.routes.set(session.id, route);
		if (current.observedSeq !== previousObserved) {
			this.cursors.set(session.id, current);
			sink({
				type: "cursor-upsert",
				sessionId: session.id,
				row: current
			});
		}
		return mutations;
	}
	/** Remove a disposed lifecycle cursor while retaining its historical calls. */
	dispose(session) {
		const stored = this.cursors.get(session.id);
		this.cursors.delete(session.id);
		this.routes.delete(session.id);
		this.routeTimes.delete(session.id);
		if (!sameLifecycle(stored, session)) return [];
		return [{
			type: "cursor-delete",
			sessionId: session.id,
			createdAt: session.createdAt
		}];
	}
	emptySessionRow(session) {
		return {
			createdAt: session.createdAt,
			...session.cwd === void 0 ? {} : { workspace: session.cwd },
			observedSeq: session.inheritedEventCount - 1,
			activeAttempts: {},
			successfulAttempts: {}
		};
	}
	processEvent(session, current, event, route, sink) {
		switch (event.type) {
			case "llm/request-attempt": return event.data.phase === "start" ? this.createAttempt(session, current, event.data.turn, event.data.step, event.data.startedAt, event.data.provider, event.data.model, event.data.attemptId, sink) : this.endAttempt(session, current, event.data.attemptId, event.data.outcome, sink);
			case "llm/retry-started": return this.createAttempt(session, current, event.data.turn, event.data.step, event.time, route.provider, route.model, createUsageAttemptId(`retry:${String(event.data.retryId)}:${event.data.retry}`), sink);
			case "step/start": return this.createAttempt(session, current, event.data.turn, event.data.step, event.time, route.provider, route.model, createUsageAttemptId(`step:${event.data.turn}:${event.data.step}`), sink);
			case "request/header":
			case "request/context": return this.updateActiveRoute(session, current, route, sink);
			case "turn/end": return event.data.reason.kind === "error" ? this.terminateActive(session, current, event.data.turn, "failure", sink) : event.data.reason.kind === "aborted" || event.data.reason.kind === "interrupted" ? this.terminateActive(session, current, event.data.turn, "aborted", sink) : current;
			case "llm/retry": return this.processRetry(session, current, event, sink);
			case "assistant/chunk":
				if (event.data.chunk.type === "usage") return this.recordProvisionalUsage(session, current, event, route, event.data.chunk.usage, sink);
				if (event.data.chunk.type === "finish") return this.recordFinish(session, current, event, event.data.chunk.reason.kind, sink);
				return current;
			case "assistant/message": return this.processAssistantMessage(session, current, event, route, sink);
			default: return current;
		}
	}
	putCall(key, row, sink) {
		this.calls.set(key, row);
		sink({
			type: "call-upsert",
			key,
			row
		});
	}
	createAttempt(session, current, turn, step, startedAt, provider, model, attemptId, sink) {
		const key = callKey(session, attemptId);
		if (this.calls.get(key) === void 0) this.putCall(key, {
			sessionId: session.id,
			createdAt: session.createdAt,
			...session.cwd === void 0 ? {} : { workspace: session.cwd },
			day: new Date(startedAt).toISOString().slice(0, 10),
			attemptId,
			turn,
			step,
			provider,
			model,
			startedAt
		}, sink);
		return {
			...current,
			activeAttempts: {
				...current.activeAttempts,
				[stepKey(turn, step)]: attemptId
			}
		};
	}
	endAttempt(session, current, attemptId, outcome, sink) {
		const key = callKey(session, attemptId);
		const row = this.calls.get(key);
		if (row !== void 0 && row.outcome !== outcome) this.putCall(key, {
			...row,
			outcome
		}, sink);
		const activeAttempts = { ...current.activeAttempts };
		for (const [step, active] of Object.entries(activeAttempts)) if (active === attemptId) Reflect.deleteProperty(activeAttempts, step);
		return {
			...current,
			activeAttempts
		};
	}
	updateActiveRoute(session, current, route, sink) {
		for (const attemptId of Object.values(current.activeAttempts)) {
			const key = callKey(session, attemptId);
			const row = this.calls.get(key);
			if (row !== void 0 && (row.provider !== route.provider || row.model !== route.model)) this.putCall(key, {
				...row,
				provider: route.provider,
				model: route.model
			}, sink);
		}
		return current;
	}
	recordFinish(session, current, event, kind, sink) {
		const attemptId = current.activeAttempts[stepKey(event.data.turn, event.data.step)];
		if (attemptId === void 0) return current;
		const key = callKey(session, attemptId);
		const row = this.calls.get(key);
		if (row === void 0 || row.outcome !== void 0) return current;
		const outcome = kind === "error" ? "failure" : kind === "aborted" ? "aborted" : kind === "stop" || kind === "tool-calls" || kind === "max-tokens" ? "success" : void 0;
		if (outcome !== void 0) this.putCall(key, {
			...row,
			outcome
		}, sink);
		return current;
	}
	processAssistantMessage(session, current, event, route, sink) {
		const data = event.data;
		const step = stepKey(data.turn, data.step);
		const attemptId = current.successfulAttempts[step] ?? current.activeAttempts[step];
		if (attemptId !== void 0) {
			if (data.usage !== void 0) this.replaceFinalUsage(session, current, data.turn, data.step, data.usage, sink);
			const key = callKey(session, attemptId);
			const row = this.calls.get(key);
			if (row !== void 0) {
				const next = this.calls.get(key) ?? row;
				const outcome = row.outcome ?? (data.interrupted === true ? "aborted" : "success");
				this.putCall(key, {
					...next,
					outcome
				}, sink);
			}
			const activeAttempts = { ...current.activeAttempts };
			Reflect.deleteProperty(activeAttempts, step);
			return {
				...current,
				activeAttempts,
				successfulAttempts: data.interrupted === true ? current.successfulAttempts : {
					...current.successfulAttempts,
					[step]: attemptId
				}
			};
		}
		const legacy = legacyAttemptId(data.turn, data.step);
		const key = callKey(session, legacy);
		const existing = this.calls.get(key);
		if (existing === void 0) this.putCall(key, {
			sessionId: session.id,
			createdAt: session.createdAt,
			...session.cwd === void 0 ? {} : { workspace: session.cwd },
			day: new Date(event.time).toISOString().slice(0, 10),
			attemptId: legacy,
			turn: data.turn,
			step: data.step,
			provider: route.provider,
			model: route.model,
			startedAt: event.time,
			outcome: data.interrupted === true ? "aborted" : "success",
			...data.usage === void 0 ? {} : { finalUsage: usageOf(data.usage) }
		}, sink);
		else if (existing.finalUsage === void 0 && data.usage !== void 0) this.putCall(key, {
			...existing,
			finalUsage: usageOf(data.usage),
			outcome: existing.outcome ?? (data.interrupted === true ? "aborted" : "success")
		}, sink);
		return data.interrupted === true ? current : {
			...current,
			successfulAttempts: {
				...current.successfulAttempts,
				[step]: legacy
			}
		};
	}
	recordProvisionalUsage(session, current, event, route, usage, sink) {
		const step = stepKey(event.data.turn, event.data.step);
		const attemptId = current.activeAttempts[step] ?? createUsageAttemptId(`stream:${event.data.turn}:${event.data.step}:${event.seq}`);
		const key = callKey(session, attemptId);
		const existing = this.calls.get(key);
		if (existing === void 0) this.putCall(key, {
			sessionId: session.id,
			createdAt: session.createdAt,
			...session.cwd === void 0 ? {} : { workspace: session.cwd },
			day: new Date(event.time).toISOString().slice(0, 10),
			attemptId,
			turn: event.data.turn,
			step: event.data.step,
			provider: route.provider,
			model: route.model,
			startedAt: event.time,
			provisionalUsage: usageOf(usage)
		}, sink);
		else this.putCall(key, {
			...existing,
			provisionalUsage: usageOf(usage)
		}, sink);
		return {
			...current,
			activeAttempts: {
				...current.activeAttempts,
				[step]: attemptId
			}
		};
	}
	replaceFinalUsage(session, current, turn, step, usage, sink) {
		const attemptId = current.successfulAttempts[stepKey(turn, step)] ?? current.activeAttempts[stepKey(turn, step)];
		if (attemptId === void 0) return current;
		const key = callKey(session, attemptId);
		const row = this.calls.get(key);
		if (row !== void 0) this.putCall(key, {
			...row,
			finalUsage: usageOf(usage)
		}, sink);
		return current;
	}
	processRetry(session, current, event, sink) {
		const step = stepKey(event.data.turn, event.data.step);
		const attemptId = current.activeAttempts[step];
		if (attemptId === void 0) return current;
		const key = callKey(session, attemptId);
		const row = this.calls.get(key);
		if (row !== void 0) this.putCall(key, {
			...row,
			...row.outcome === void 0 ? { outcome: "failure" } : {},
			retryScheduled: true
		}, sink);
		return current;
	}
	terminateActive(session, current, turn, outcome, sink) {
		let activeAttempts = { ...current.activeAttempts };
		for (const [step, attemptId] of Object.entries(activeAttempts)) {
			const row = this.calls.get(callKey(session, attemptId));
			if (row === void 0 || row.turn !== turn) continue;
			if (row.outcome === void 0) this.putCall(callKey(session, attemptId), {
				...row,
				outcome
			}, sink);
			Reflect.deleteProperty(activeAttempts, step);
		}
		return {
			...current,
			activeAttempts
		};
	}
};
//#endregion
//#region lib/types/backfill-worker.js
/** Private Usage Ledger worker entry; never exposed as a public CLI binary. */
var __rewriteRelativeImportExtension = function(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
};
const input = createInterface({
	input: process.stdin,
	crlfDelay: Infinity
});
let stopped = false;
let initialized = false;
let init;
let reducer;
let reader;
let sessionOrder = [];
let historyIndex = 0;
let readonlyLive = /* @__PURE__ */ new Set();
const liveEvents = /* @__PURE__ */ new Map();
const priority = /* @__PURE__ */ new Map();
let pumping = false;
let readerLoad;
let outputChain = Promise.resolve();
let processedSessions = 0;
let processedEvents = 0;
let lastProgressAt = 0;
function send(frame) {
	outputChain = outputChain.then(async () => {
		if (stopped) return;
		const line = encodeWorkerFrame(frame);
		if (process.stdout.write(line)) return;
		await once(process.stdout, "drain");
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
	const bySeq = liveEvents.get(session.id) ?? /* @__PURE__ */ new Map();
	bySeq.set(event.seq, event);
	if (bySeq.size > 2048) {
		const oldest = [...bySeq.keys()].sort((left, right) => left - right)[0];
		if (oldest !== void 0) bySeq.delete(oldest);
	}
	liveEvents.set(session.id, bySeq);
	priority.set(session.id, {
		session,
		rescan: false
	});
}
function takeNextTask() {
	const live = priority.values().next().value;
	if (live !== void 0) {
		priority.delete(live.session.id);
		return live;
	}
	const next = sessionOrder[historyIndex];
	historyIndex += next === void 0 ? 0 : 1;
	return next;
}
function markProgress(status, currentSessionId) {
	return send({
		type: "progress",
		status,
		totalSessions: sessionOrder.length,
		processedSessions,
		processedEvents,
		...currentSessionId === void 0 ? {} : { currentSessionId },
		backfillDays: init?.config.backfillDays ?? 0
	});
}
async function loadReader() {
	if (readerLoad !== void 0) return readerLoad;
	readerLoad = (async () => {
		const spec = init?.readerSpec;
		if (spec === void 0) return;
		if (spec.protocolVersion !== 1) throw new Error(`unsupported background reader protocol ${String(spec.protocolVersion)}`);
		const imported = await import(__rewriteRelativeImportExtension(spec.workerModule));
		if (typeof imported.readSessionBatches !== "function" && typeof imported.default?.readSessionBatches !== "function") throw new TypeError("provider-owned background reader does not export readSessionBatches");
		reader = typeof imported.readSessionBatches === "function" ? imported : imported.default;
	})();
	return readerLoad;
}
function emitMutations(sessionId, mutations) {
	if (mutations.length === 0) return Promise.resolve();
	return send({
		type: "mutation",
		mutations
	}).then(() => {
		const cursor = mutations.find((mutation) => mutation.type === "cursor-upsert");
		if (cursor?.type === "cursor-upsert") return send({
			type: "checkpoint",
			sessionId,
			observedSeq: cursor.row.observedSeq
		});
	});
}
async function processLive(session) {
	const events = liveEvents.get(session.id);
	if (events === void 0 || events.size === 0 || reducer === void 0) return;
	const ordered = [...events.entries()].sort(([left], [right]) => left - right).map(([, event]) => event);
	const cursor = reducer.resumeSeq(session) - 1;
	if (reader !== void 0 && ordered[0] !== void 0 && ordered[0].seq > cursor + 1) return;
	liveEvents.delete(session.id);
	const mutations = reducer.applyBatch(session, ordered);
	processedEvents += ordered.length;
	await emitMutations(session.id, mutations);
}
async function processReaderBatch(session, current) {
	if (reducer === void 0) return;
	const effective = current.meta.id === session.id ? {
		...session,
		inheritedEventCount: current.inheritedEventCount
	} : session;
	const mutations = reducer.applyBatch(effective, current.events);
	processedEvents += current.events.length;
	await emitMutations(session.id, mutations);
}
async function processSession(task) {
	if (reducer === void 0 || init === void 0) return;
	const session = sessionForTask(task);
	let sliceStarted = performance.now();
	await processLive(session);
	if (reader !== void 0 && !stopped) {
		const fromSeq = reducer.resumeSeq(session);
		const batches = reader.readSessionBatches(init.readerSpec?.options, {
			session: {
				id: session.id,
				...session.cwd === void 0 ? {} : { cwd: session.cwd }
			},
			fromSeq,
			batchEvents: init.config.workerBatchEvents
		});
		for await (const current of batches) {
			if (stopped) return;
			await processReaderBatch(session, current);
			await processLive(session);
			if (performance.now() - sliceStarted >= init.config.workerSliceMs) {
				await markProgress("running", session.id);
				await new Promise((resolve) => setImmediate(resolve));
				sliceStarted = performance.now();
			}
		}
	} else await processLive(session);
	if (liveEvents.get(session.id)?.size !== void 0) {
		const pending = liveEvents.get(session.id);
		if (pending !== void 0 && pending.size > 0) setTimeout(() => {
			if (stopped) return;
			priority.set(session.id, {
				session,
				rescan: true
			});
			pump();
		}, 100);
	}
	processedSessions += 1;
	await send({
		type: "done",
		sessionId: session.id
	});
}
async function pump() {
	if (pumping || stopped || !initialized) return;
	pumping = true;
	try {
		try {
			await loadReader();
		} catch (error) {
			reader = void 0;
			readerLoad = Promise.resolve();
			await send({
				type: "error",
				message: `provider-owned reader disabled: ${errorMessage(error)}`
			});
		}
		while (!stopped) {
			const task = takeNextTask();
			if (task === void 0) break;
			try {
				await markProgress("running", task.session.id);
				await processSession(task);
			} catch (error) {
				await send({
					type: "error",
					message: errorMessage(error),
					sessionId: task.session.id
				});
			}
			if (performance.now() - lastProgressAt > 500) {
				lastProgressAt = performance.now();
				await markProgress("running");
			}
		}
		if (!stopped) await markProgress(reader === void 0 ? "paused" : "idle");
	} catch (error) {
		await send({
			type: "error",
			message: errorMessage(error),
			fatal: true
		});
		await markProgress("failed");
	} finally {
		pumping = false;
		if (!stopped && (priority.size > 0 || historyIndex < sessionOrder.length)) pump();
	}
}
function handleInit(frame) {
	if (initialized) return;
	if (frame.protocolVersion !== 1) {
		send({
			type: "error",
			message: `unsupported worker protocol ${String(frame.protocolVersion)}`,
			fatal: true
		});
		stopped = true;
		return;
	}
	init = frame;
	reducer = new UsageLedgerReducer({
		calls: frame.calls,
		cursors: frame.cursors
	});
	sessionOrder = frame.sessions.map((session) => ({
		session,
		rescan: true
	}));
	readonlyLive = new Set(frame.liveSessionIds);
	for (const session of frame.sessions) if (readonlyLive.has(session.id)) priority.set(session.id, {
		session,
		rescan: true
	});
	initialized = true;
	pump();
}
function handleFrame(frame) {
	switch (frame.type) {
		case "init":
			handleInit(frame);
			return;
		case "live":
			if (!initialized) return;
			queueLive(frame.session, frame.event);
			pump();
			return;
		case "rescan":
			if (!initialized) return;
			priority.set(frame.session.id, {
				session: frame.session,
				rescan: true
			});
			pump();
			return;
		case "dispose":
			if (!initialized || reducer === void 0) return;
			liveEvents.delete(frame.session.id);
			priority.delete(frame.session.id);
			emitMutations(frame.session.id, reducer.dispose(frame.session));
			return;
		case "stop":
			stopped = true;
			input.close();
			return;
	}
}
input.on("line", (line) => {
	const frame = decodeWorkerFrame(line);
	if (frame === void 0) {
		send({
			type: "error",
			message: "invalid worker protocol frame"
		});
		return;
	}
	handleFrame(frame);
});
input.on("close", () => {
	stopped = true;
});
//#endregion
export {};
