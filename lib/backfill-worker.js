import { i as createUsageAttemptId, n as encodeWorkerFrame, r as openUsageLedgerDatabase, t as decodeWorkerFrame } from "./worker-protocol-VhYx9pk4.js";
import { once } from "node:events";
import { createInterface } from "node:readline";
//#region lib/types/host/reducer.js
/** Pure bounded reducer used by the isolated Usage Ledger worker. */
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
/**
* Fold one session at a time. The reducer retains only active attempts, so a
* multi-year ledger never becomes a worker heap.
*/
var UsageLedgerReducer = class {
	maxActiveAttempts;
	calls = /* @__PURE__ */ new Map();
	cursorRow;
	constructor(seed = {}, maxActiveAttempts = 256) {
		this.maxActiveAttempts = maxActiveAttempts;
		this.cursorRow = seed.cursor;
		if (Object.keys(seed.cursor?.activeAttempts ?? {}).length > maxActiveAttempts) throw new Error("usage ledger session active attempt count exceeds workerMaxActiveAttempts");
		for (const entry of seed.calls ?? []) this.calls.set(entry.key, entry.row);
	}
	/** Return the cursor for the session currently loaded into this reducer. */
	cursor(session) {
		return sameLifecycle(this.cursorRow, session) ? this.cursorRow : void 0;
	}
	/** Return the first sequence that needs replay for this session lifecycle. */
	resumeSeq(session) {
		const stored = this.cursor(session);
		if (stored === void 0) return session.inheritedEventCount;
		return Math.max(session.inheritedEventCount, stored.observedSeq + 1);
	}
	/** Apply one bounded event batch and return durable call/cursor changes. */
	applyBatch(session, events) {
		const mutations = [];
		const sink = (mutation) => {
			mutations.push(mutation);
		};
		let current = this.cursor(session) ?? this.emptySessionRow(session);
		let route = current.route ?? {
			provider: "unknown",
			model: "unknown"
		};
		const previousObserved = current.observedSeq;
		for (const event of events) {
			if (event.seq < session.inheritedEventCount || event.seq <= current.observedSeq) continue;
			route = routeAfter(route, event);
			current = {
				...this.processEvent(session, current, event, route, sink),
				observedSeq: event.seq,
				route
			};
		}
		if (current.observedSeq !== previousObserved) {
			this.cursorRow = current;
			sink({
				type: "cursor-upsert",
				sessionId: session.id,
				row: current
			});
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
			...session.cwd === void 0 ? {} : { workspace: session.cwd },
			observedSeq: session.inheritedEventCount - 1,
			activeAttempts: {}
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
	removeCall(session, attemptId) {
		this.calls.delete(callKey(session, attemptId));
	}
	createAttempt(session, current, turn, step, startedAt, provider, model, attemptId, sink) {
		const stepId = stepKey(turn, step);
		const priorAttempt = current.activeAttempts[stepId];
		if (priorAttempt === void 0 && Object.keys(current.activeAttempts).length >= this.maxActiveAttempts) throw new Error("usage ledger session active attempt count exceeds workerMaxActiveAttempts");
		if (priorAttempt !== void 0 && priorAttempt !== attemptId) this.removeCall(session, priorAttempt);
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
				[stepId]: attemptId
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
		this.removeCall(session, attemptId);
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
		const attemptId = current.activeAttempts[step];
		if (attemptId !== void 0) {
			const key = callKey(session, attemptId);
			const row = this.calls.get(key) ?? {
				sessionId: session.id,
				createdAt: session.createdAt,
				...session.cwd === void 0 ? {} : { workspace: session.cwd },
				day: new Date(event.time).toISOString().slice(0, 10),
				attemptId,
				turn: data.turn,
				step: data.step,
				provider: route.provider,
				model: route.model,
				startedAt: event.time
			};
			this.putCall(key, {
				...row,
				...data.usage === void 0 ? {} : { finalUsage: usageOf(data.usage) },
				outcome: row.outcome ?? (data.interrupted === true ? "aborted" : "success")
			}, sink);
			const activeAttempts = { ...current.activeAttempts };
			Reflect.deleteProperty(activeAttempts, step);
			this.removeCall(session, attemptId);
			return {
				...current,
				activeAttempts
			};
		}
		const legacy = legacyAttemptId(data.turn, data.step);
		const key = callKey(session, legacy);
		this.putCall(key, {
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
		this.removeCall(session, legacy);
		return current;
	}
	recordProvisionalUsage(session, current, event, route, usage, sink) {
		const step = stepKey(event.data.turn, event.data.step);
		const attemptId = current.activeAttempts[step] ?? createUsageAttemptId(`stream:${event.data.turn}:${event.data.step}:${event.seq}`);
		const key = callKey(session, attemptId);
		const row = this.calls.get(key) ?? {
			sessionId: session.id,
			createdAt: session.createdAt,
			...session.cwd === void 0 ? {} : { workspace: session.cwd },
			day: new Date(event.time).toISOString().slice(0, 10),
			attemptId,
			turn: event.data.turn,
			step: event.data.step,
			provider: route.provider,
			model: route.model,
			startedAt: event.time
		};
		this.putCall(key, {
			...row,
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
	processRetry(session, current, event, sink) {
		const attemptId = current.activeAttempts[stepKey(event.data.turn, event.data.step)];
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
		const activeAttempts = { ...current.activeAttempts };
		for (const [step, attemptId] of Object.entries(activeAttempts)) {
			if (!step.startsWith(`${String(turn)}:`)) continue;
			const key = callKey(session, attemptId);
			const row = this.calls.get(key);
			if (row !== void 0 && row.outcome === void 0) this.putCall(key, {
				...row,
				outcome
			}, sink);
			Reflect.deleteProperty(activeAttempts, step);
			this.removeCall(session, attemptId);
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
let database;
let reader;
let readerLoad;
let history;
let historyReady;
let historyDone = false;
const priority = /* @__PURE__ */ new Map();
const deferredRescans = /* @__PURE__ */ new Map();
const liveEvents = /* @__PURE__ */ new Map();
let pumping = false;
let outputChain = Promise.resolve();
let processedSessions = 0;
let processedEvents = 0;
let totalSessions = 0;
let lastProgressAt = 0;
let pace = {
	mode: "run",
	delayMs: 0
};
let wake;
const startupLive = /* @__PURE__ */ new Map();
const startupControl = /* @__PURE__ */ new Map();
function send(frame) {
	outputChain = outputChain.then(async () => {
		if (stopped) return;
		const line = encodeWorkerFrame(frame);
		if (process.stdout.write(line)) return;
		await once(process.stdout, "drain");
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
	wake = void 0;
	current?.();
}
function waitForWake() {
	return new Promise((resolve) => {
		wake = resolve;
	});
}
async function waitForHistoryPermit() {
	while (!stopped && historyPaused()) await waitForWake();
}
function queueLive(session, event) {
	const bySeq = liveEvents.get(session.id) ?? /* @__PURE__ */ new Map();
	bySeq.set(event.seq, event);
	if (bySeq.size > 2048) {
		const oldest = bySeq.keys().next().value;
		if (oldest !== void 0) bySeq.delete(oldest);
	}
	liveEvents.set(session.id, bySeq);
	priority.set(session.id, {
		session,
		kind: "live"
	});
	notifyWake();
}
function queueRescan(session) {
	const task = {
		session,
		kind: "rescan"
	};
	if (pace.mode === "pause") deferredRescans.set(session.id, task);
	else priority.set(session.id, task);
	notifyWake();
}
function moveDeferredRescans() {
	if (pace.mode === "pause") return;
	for (const task of deferredRescans.values()) priority.set(task.session.id, task);
	deferredRescans.clear();
}
function historyPaused() {
	return pace.mode === "pause";
}
function markProgress(status, currentSessionId) {
	return send({
		type: "progress",
		status,
		totalSessions,
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
function asWorkerSession(entry) {
	return {
		id: entry.id,
		createdAt: entry.createdAt,
		...entry.cwd === void 0 ? {} : { cwd: entry.cwd },
		inheritedEventCount: 0
	};
}
function sessionHeaderLister() {
	const lister = reader?.listSessionHeaders;
	return init?.readerSpec?.supportsSessionListing === true && lister !== void 0 ? lister : void 0;
}
async function countHistory() {
	const lister = sessionHeaderLister();
	if (lister === void 0 || init === void 0) return init?.sessions.length ?? 0;
	const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1e3;
	let count = 0;
	for await (const session of lister(init.readerSpec?.options, { ...init.config.backfillScope === "recent" ? { createdAtAfter: cutoff } : {} })) {
		await waitForHistoryPermit();
		if (stopped) return count;
		if (init.config.backfillScope === "all" || session.createdAt >= cutoff) count += 1;
	}
	return count;
}
async function* historySessions() {
	if (init === void 0) return;
	const lister = sessionHeaderLister();
	if (lister === void 0) {
		const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1e3;
		yield* init.sessions.filter((session) => init?.config.backfillScope === "all" || session.createdAt >= cutoff).sort((left, right) => right.createdAt - left.createdAt);
		return;
	}
	const cutoff = Date.now() - init.config.backfillDays * 24 * 60 * 60 * 1e3;
	for await (const session of lister(init.readerSpec?.options, { createdAtAfter: cutoff })) {
		await waitForHistoryPermit();
		if (stopped) return;
		yield asWorkerSession(session);
	}
	if (init.config.backfillScope === "recent") return;
	for await (const session of lister(init.readerSpec?.options, { createdAtBefore: cutoff })) {
		await waitForHistoryPermit();
		if (stopped) return;
		yield asWorkerSession(session);
	}
}
async function prepareHistory() {
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
	if (reader === void 0) {
		totalSessions = 0;
		historyDone = true;
		return;
	}
	totalSessions = await countHistory();
	history = historySessions();
}
async function takeNextTask() {
	const nextPriority = priority.values().next().value;
	if (nextPriority !== void 0) {
		priority.delete(nextPriority.session.id);
		return nextPriority;
	}
	if (pace.mode === "pause" || historyDone) return void 0;
	if (historyReady === void 0) historyReady = prepareHistory();
	await historyReady;
	const next = await history?.next();
	if (next === void 0 || next.done) {
		historyDone = true;
		return;
	}
	return {
		session: next.value,
		kind: "history",
		countHistory: true
	};
}
async function persistMutations(session, reducer, mutations) {
	if (mutations.length === 0) return;
	requireDatabase().applyMutations(mutations);
	const cursor = reducer.cursor(session);
	if (cursor !== void 0) await send({
		type: "checkpoint",
		sessionId: session.id,
		observedSeq: cursor.observedSeq
	});
}
async function processLive(session, reducer) {
	const events = liveEvents.get(session.id);
	if (events === void 0 || events.size === 0) return true;
	const ordered = [...events.entries()].sort(([left], [right]) => left - right).map(([, event]) => event);
	if (reader !== void 0 && ordered[0] !== void 0 && ordered[0].seq > reducer.resumeSeq(session)) {
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
	const effective = current.meta.id === session.id ? {
		...session,
		inheritedEventCount: current.inheritedEventCount
	} : session;
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
		await Promise.race([new Promise((resolve) => setTimeout(resolve, pace.delayMs)), waitForWake()]);
		return;
	}
	await new Promise((resolve) => setImmediate(resolve));
}
/**
* Process one session until its current slice completes. A saved cursor makes
* a preempted scan resume from disk without retaining prior calls in memory.
*/
async function processSession(task) {
	if (init === void 0 || reader === void 0 && task.kind !== "live") return false;
	const session = task.session;
	const reducer = new UsageLedgerReducer(requireDatabase().sessionSeed(session.id, session.createdAt, init.config.workerMaxActiveAttempts), init.config.workerMaxActiveAttempts);
	let sliceStarted = performance.now();
	await processLive(session, reducer);
	if (task.kind === "live") return true;
	if (pace.mode === "pause") {
		deferredRescans.set(session.id, task);
		return false;
	}
	if (reader === void 0) return false;
	const batches = reader.readSessionBatches(init.readerSpec?.options, {
		session: {
			id: session.id,
			...session.cwd === void 0 ? {} : { cwd: session.cwd }
		},
		fromSeq: reducer.resumeSeq(session),
		batchEvents: init.config.workerBatchEvents
	});
	for await (const current of batches) {
		if (stopped) return false;
		await processReaderBatch(session, reducer, current);
		await processLive(session, reducer);
		if (performance.now() - sliceStarted < init.config.workerSliceMs) continue;
		await markProgress("running", session.id);
		await yieldForPace();
		if (historyPaused()) {
			deferredRescans.set(session.id, task);
			return false;
		}
		if (priority.size > 0) {
			priority.set(session.id, {
				session,
				kind: "rescan",
				countHistory: task.countHistory
			});
			return false;
		}
		sliceStarted = performance.now();
	}
	return true;
}
async function pump() {
	if (pumping || stopped || !initialized) return;
	pumping = true;
	try {
		while (!stopped) {
			const task = await takeNextTask();
			if (task === void 0) break;
			try {
				await markProgress("running", task.session.id);
				if (await processSession(task) && task.countHistory === true) processedSessions += 1;
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
		if (!stopped) await markProgress(pace.mode === "pause" && !historyDone ? "paused" : reader === void 0 ? "paused" : "idle");
	} catch (error) {
		await send({
			type: "error",
			message: errorMessage(error),
			fatal: true
		});
		await markProgress("failed");
	} finally {
		pumping = false;
		if (!stopped && (priority.size > 0 || !historyDone && pace.mode === "run")) pump();
	}
}
function requireDatabase() {
	if (database === void 0) throw new Error("usage ledger database is not initialized");
	return database;
}
function closeDatabase() {
	const current = database;
	database = void 0;
	current?.close();
}
async function failInitialization(message) {
	await send({
		type: "error",
		message,
		fatal: true
	});
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
	for (const queued of controls) handleFrame(queued);
	for (const queued of live) handleFrame(queued);
	pump();
}
function queueBeforeInitialization(frame) {
	if (frame.type === "live") {
		startupLive.set(frame.session.id, frame);
		while (startupLive.size > 1024) {
			const id = startupLive.keys().next().value;
			if (id === void 0) break;
			startupLive.delete(id);
		}
		return;
	}
	if (frame.type === "dispose") {
		startupLive.delete(frame.session.id);
		startupControl.set(frame.session.id, frame);
		return;
	}
	if (frame.type === "rescan") {
		startupControl.set(frame.session.id, frame);
		return;
	}
	if (frame.type === "pace") {
		startupControl.set("pace", frame);
		return;
	}
	stopped = true;
	notifyWake();
	input.close();
}
function handleFrame(frame) {
	switch (frame.type) {
		case "init":
			if (initialized) return;
			if (frame.protocolVersion !== 1) {
				failInitialization("unsupported worker protocol " + String(frame.protocolVersion));
				return;
			}
			initialize(frame).catch((error) => {
				failInitialization(errorMessage(error));
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
		case "live":
			queueLive(frame.session, frame.event);
			pump();
			return;
		case "rescan":
			queueRescan(frame.session);
			pump();
			return;
		case "dispose":
			liveEvents.delete(frame.session.id);
			priority.delete(frame.session.id);
			deferredRescans.delete(frame.session.id);
			return;
		case "pace":
			pace = {
				mode: frame.mode,
				delayMs: frame.delayMs
			};
			if (pace.mode === "run") moveDeferredRescans();
			notifyWake();
			pump();
			return;
		case "stop":
			stopped = true;
			notifyWake();
			input.close();
			closeDatabase();
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
	notifyWake();
	closeDatabase();
});
//#endregion
export {};
