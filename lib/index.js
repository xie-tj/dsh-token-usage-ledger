import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { Session } from "@deepseek-ai/dsh-session";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z as z$1 } from "zod";
//#region lib/types/spec.js
/** Persistent `usage_ledger` domain declaration and stored-record schemas. */
const nonNegativeInteger = z$1.number().int().nonnegative();
const tokenUsageSchema = z$1.object({
	inputTokens: nonNegativeInteger,
	outputTokens: nonNegativeInteger,
	cacheReadTokens: nonNegativeInteger,
	cacheWriteTokens: nonNegativeInteger
});
/** Zod schema for the lifecycle cursor and attempt lookup tables. */
const usageLedgerSessionRowSchema = z$1.object({
	createdAt: nonNegativeInteger,
	workspace: z$1.string().optional(),
	observedSeq: z$1.number().int().min(-1),
	activeAttempts: z$1.record(z$1.string(), z$1.string()),
	successfulAttempts: z$1.record(z$1.string(), z$1.string())
});
/** Zod schema for one persisted provider attempt. */
const usageLedgerCallRowSchema = z$1.object({
	sessionId: z$1.string(),
	createdAt: nonNegativeInteger,
	workspace: z$1.string().optional(),
	day: z$1.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	attemptId: z$1.string(),
	startedAt: nonNegativeInteger,
	turn: nonNegativeInteger,
	step: nonNegativeInteger,
	provider: z$1.string(),
	model: z$1.string(),
	outcome: z$1.enum([
		"success",
		"failure",
		"aborted"
	]).optional(),
	retryScheduled: z$1.boolean().optional(),
	provisionalUsage: tokenUsageSchema.optional(),
	finalUsage: tokenUsageSchema.optional()
});
/** Versioned persistent storage layout for the usage-ledger service. */
const usageLedgerDomainSpec = defineDomain({
	name: "usage_ledger",
	version: 2,
	tables: {
		sessions: domainTable(usageLedgerSessionRowSchema),
		calls: domainTable(usageLedgerCallRowSchema)
	}
});
//#endregion
//#region lib/types/index.js
/**
* Host-side ledger that persists provider attempts and rebuilds usage from session history.
* @module dsh-plugin-usage-ledger
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;
/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
const USAGE_LEDGER_SETTINGS_NAMESPACE = settingsNamespace("usage-ledger");
const UsageLedgerSettingsSchema = z.object({});
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
	unmeteredRequests: 0
};
/** Format an epoch timestamp as its UTC calendar day. */
function utcDay(time) {
	return new Date(time).toISOString().slice(0, 10);
}
/** Format an epoch timestamp as a calendar day in an IANA timezone. */
function zoneDay(time, timeZone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(new Date(time));
	const year = parts.find((part) => part.type === "year")?.value;
	const month = parts.find((part) => part.type === "month")?.value;
	const day = parts.find((part) => part.type === "day")?.value;
	if (year === void 0 || month === void 0 || day === void 0) throw new Error(`usage ledger could not format date in timezone '${timeZone}'`);
	return `${year}-${month}-${day}`;
}
/** Return the calendar date `offset` days before `day`. */
function shiftDay(day, offset) {
	const instant = /* @__PURE__ */ new Date(`${day}T00:00:00.000Z`);
	instant.setUTCDate(instant.getUTCDate() + offset);
	return utcDay(instant.getTime());
}
/** Keep untrusted Remote requests within the bounded read this package supports. */
function resolveSnapshotRequest(request) {
	const workspace = request?.workspace ?? null;
	const days = request?.days ?? DEFAULT_DAYS;
	const timeZone = request?.timeZone ?? "UTC";
	if (workspace !== null && typeof workspace !== "string") throw new TypeError("usage ledger workspace must be a string or null");
	if (typeof timeZone !== "string" || timeZone.length === 0) throw new TypeError("usage ledger timeZone must be a non-empty IANA timezone");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format();
	} catch {
		throw new RangeError(`usage ledger timeZone is invalid: '${timeZone}'`);
	}
	if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new RangeError(`usage ledger days must be a safe integer from 1 through ${MAX_DAYS}`);
	return {
		workspace,
		days,
		throughDay: zoneDay(Date.now(), timeZone),
		timeZone
	};
}
/** Stable storage key for one attempt in one exact session lifecycle. */
function callKey(session, attemptId) {
	return JSON.stringify([
		session.id,
		session.header.createdAt,
		attemptId
	]);
}
/** Stable per-step lookup key stored on the lifecycle cursor. */
function stepKey(turn, step) {
	return `${turn}:${step}`;
}
/** Whether a cursor belongs to the same session lifecycle. */
function sameLifecycle(row, session) {
	return row !== void 0 && row.createdAt === session.header.createdAt && row.workspace === session.header.cwd;
}
/** Copy provider usage into the ledger's complete, JSON-safe counters. */
function usageOf(usage) {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0
	};
}
/** Final usage takes precedence over the latest provisional stream sample. */
function usageFor(row) {
	return row.finalUsage ?? row.provisionalUsage;
}
/** Stable synthetic attempt id for a historical log without request-attempt events. */
function legacyAttemptId(turn, step) {
	return `legacy:${turn}:${step}`;
}
/** Resolve the latest provider/model route recorded before one historical event. */
function routeBefore(session, throughSeq) {
	let route = {
		provider: "unknown",
		model: "unknown"
	};
	for (const event of session.events) {
		if (event.seq >= throughSeq) break;
		route = routeAfter(route, event);
	}
	return route;
}
/** Advance a historical provider/model route when a request event records one. */
function routeAfter(route, event) {
	if (event.type === "request/header") return {
		provider: event.data.header.config.provider,
		model: event.data.header.config.model
	};
	if (event.type === "request/context") return {
		provider: event.data.provider,
		model: event.data.model
	};
	return route;
}
/** Host service that persists each final, failed, aborted, and retried provider call. */
let UsageLedgerService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _snapshot_decorators;
	return class UsageLedgerService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_snapshot_decorators = [Remote("snapshot")];
			__esDecorate(this, null, _snapshot_decorators, {
				kind: "method",
				name: "snapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "snapshot" in obj,
					get: (obj) => obj.snapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"storageDomain",
			"sessions",
			"sessionPersistence"
		];
		sessions = __runInitializers(this, _instanceExtraInitializers);
		calls;
		cursors = /* @__PURE__ */ new Map();
		routes = /* @__PURE__ */ new Map();
		coldSessions = /* @__PURE__ */ new Set();
		tails = /* @__PURE__ */ new Map();
		pendingThrough = /* @__PURE__ */ new Map();
		scheduled = /* @__PURE__ */ new Set();
		backfillPromise;
		accepting = true;
		constructor(ctx) {
			super(ctx, "usageLedger", { namespace: "usageLedgerPlugin" });
			ctx.inject(["settings"], (settingsCtx) => {
				settingsCtx.settings.register(USAGE_LEDGER_SETTINGS_NAMESPACE, UsageLedgerSettingsSchema);
			});
		}
		/** Open the ledger and attach lifecycle-bound post-append observers. */
		async [Service.init]() {
			const domain = await this.ctx.storageDomain.open(usageLedgerDomainSpec);
			this.sessions = domain.table("sessions");
			this.calls = domain.table("calls");
			this.ctx.effect(() => async () => {
				this.accepting = false;
				await this.backfillPromise;
				await this.drainTails();
				await this.persistCursors();
				await domain.close();
			}, "usage-ledger.domain-close");
			this.ctx.on("session/created", (session) => {
				this.adopt(session);
			});
			this.ctx.on("session/event", (session, event) => {
				this.schedule(session, event.seq);
			});
			this.ctx.on("session/disposed", (session) => {
				this.enqueue(session, async () => {
					this.cursors.delete(session);
					this.routes.delete(session);
					if (sameLifecycle(this.requireSessions().get(session.id), session)) await this.requireSessions().delete(session.id);
				});
			});
			this.ctx.on("session/flush", (session) => this.flushSession(session));
			for (const session of this.ctx.sessions.list()) this.adopt(session);
			this.backfillPromise = this.backfill(this.ctx.sessionPersistence);
		}
		/** Replay cold persisted sessions without publishing them as live sessions. */
		async backfill(persistence) {
			let headers;
			try {
				headers = await persistence.list();
			} catch (error) {
				this.ctx.logger.warn(`usage ledger: historical session listing failed: ${String(error)}`);
				return;
			}
			for (const header of headers) {
				if (!this.accepting) return;
				const live = this.ctx.sessions.get(header.id);
				if (live !== void 0) {
					this.adopt(live);
					continue;
				}
				try {
					const loaded = await persistence.inspect(header.id);
					const historical = Session.create(header.id, loaded.events, loaded.meta);
					this.coldSessions.add(historical);
					this.adopt(historical);
				} catch (error) {
					this.ctx.logger.warn(`usage ledger: historical session '${header.id}' skipped: ${String(error)}`);
				}
			}
			await this.drainTails();
			await this.persistCursors();
			for (const session of this.coldSessions) {
				this.cursors.delete(session);
				this.routes.delete(session);
			}
			this.coldSessions.clear();
		}
		/**
		* Return a bounded, read-only summary derived from idempotent call records.
		* @param request - optional workspace, calendar-day, and timezone filters.
		* @returns the usage snapshot after all queued session events are applied.
		*/
		async snapshot(request) {
			if (this.backfillPromise === void 0) this.backfillPromise = this.backfill(this.ctx.sessionPersistence);
			await this.backfillPromise;
			for (const session of this.ctx.sessions.list()) this.adopt(session);
			await this.drainTails();
			const resolved = resolveSnapshotRequest(request);
			const fromDay = shiftDay(resolved.throughDay, 1 - resolved.days);
			const models = /* @__PURE__ */ new Map();
			const daily = /* @__PURE__ */ new Map();
			const selected = [];
			for (let offset = 0; offset < resolved.days; offset++) {
				const day = shiftDay(fromDay, offset);
				daily.set(day, {
					day,
					...ZERO_TOTALS
				});
			}
			for (const [, row] of this.requireCalls().entries()) {
				const localDay = zoneDay(row.startedAt, resolved.timeZone);
				if (localDay < fromDay || localDay > resolved.throughDay) continue;
				if (resolved.workspace !== null && row.workspace !== resolved.workspace) continue;
				selected.push(row);
				const workspace = row.workspace ?? null;
				const modelKey = JSON.stringify([
					workspace,
					row.provider,
					row.model
				]);
				const nextModel = addAttempt(models.get(modelKey) ?? {
					workspace,
					provider: row.provider,
					model: row.model,
					...ZERO_TOTALS
				}, row);
				models.set(modelKey, nextModel);
				const day = daily.get(localDay);
				if (day !== void 0) daily.set(localDay, addAttempt(day, row));
			}
			return Object.freeze({
				workspace: resolved.workspace,
				days: resolved.days,
				fromDay,
				throughDay: resolved.throughDay,
				timeZone: resolved.timeZone,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				events: Object.freeze(projectEvents(selected).map((row) => Object.freeze(row))),
				models: Object.freeze([...models.values()].sort(compareModels).map((row) => Object.freeze(row))),
				daily: Object.freeze([...daily.values()].map((row) => Object.freeze(row)))
			});
		}
		/** Replay a session tail after startup or HMR, excluding a fork's inherited prefix. */
		adopt(session) {
			this.schedule(session, Number.MAX_SAFE_INTEGER);
		}
		/** Coalesce committed events into one ordered replay; defer the cursor to flush. */
		schedule(session, throughSeq) {
			if (!this.accepting) return;
			const pending = this.pendingThrough.get(session);
			if (pending === void 0 || throughSeq > pending) this.pendingThrough.set(session, throughSeq);
			if (this.scheduled.has(session)) return;
			this.scheduled.add(session);
			this.enqueue(session, async () => {
				this.scheduled.delete(session);
				const target = this.pendingThrough.get(session);
				if (target === void 0) return;
				try {
					await this.processThrough(session, target);
					if (this.pendingThrough.get(session) === target) this.pendingThrough.delete(session);
				} finally {
					const next = this.pendingThrough.get(session);
					if (next !== void 0 && this.accepting) this.schedule(session, next);
				}
			});
		}
		/** Wait until all work already observed for one session has been processed. */
		async waitForSession(session) {
			while (true) {
				const tail = this.tails.get(session);
				if (tail === void 0) {
					const pending = this.pendingThrough.get(session);
					if (pending === void 0) return;
					this.schedule(session, pending);
					continue;
				}
				await tail;
				if (this.tails.get(session) === tail && !this.pendingThrough.has(session)) return;
			}
		}
		/** Persist one session cursor at its durable session checkpoint. */
		async flushSession(session) {
			await this.waitForSession(session);
			const cursor = this.cursors.get(session);
			if (cursor === void 0) return;
			try {
				await this.requireSessions().put(session.id, cursor);
			} catch (error) {
				this.ctx.logger.warn(`usage ledger: session '${session.id}' cursor flush failed: ${String(error)}`);
			}
		}
		/** Persist all cursors before the ledger domain closes. */
		async persistCursors() {
			for (const [session, cursor] of this.cursors) try {
				await this.requireSessions().put(session.id, cursor);
			} catch (error) {
				this.ctx.logger.warn(`usage ledger: session '${session.id}' cursor close flush failed: ${String(error)}`);
			}
		}
		/** Drain all session queues before closing the ledger domain. */
		async drainTails() {
			while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
		}
		/** Process every missing committed event through one ordered session sequence. */
		async processThrough(session, throughSeq) {
			const sessions = this.requireSessions();
			const stored = this.cursors.get(session) ?? sessions.get(session.id);
			const initial = sameLifecycle(stored, session) ? stored : this.emptySessionRow(session);
			let current = initial;
			const firstLiveSeq = session.header.seedLength ?? 0;
			const startSeq = Math.max(firstLiveSeq, current.observedSeq + 1);
			const eventCount = this.coldSessions.has(session) ? session.firstLiveSeq : session.events.length;
			let route = this.routes.get(session) ?? routeBefore(session, startSeq);
			for (let seq = startSeq; seq <= throughSeq && seq < eventCount; seq += 1) {
				const event = session.events[seq];
				if (event === void 0) continue;
				route = routeAfter(route, event);
				current = {
					...await this.processEvent(session, current, event, route),
					observedSeq: event.seq
				};
			}
			this.routes.set(session, route);
			if (current.observedSeq !== initial.observedSeq) this.cursors.set(session, current);
		}
		/** Apply one committed event without persisting the cursor between events. */
		async processEvent(session, current, event, route) {
			switch (event.type) {
				case "llm/request-attempt": return this.processAttempt(session, current, event);
				case "llm/retry-started": return this.markRetry(session, current, event.data.turn, event.data.step);
				case "assistant/chunk": return event.data.chunk.type === "usage" ? this.replaceProvisionalUsage(session, current, event.data.turn, event.data.step, event.data.chunk.usage) : current;
				case "assistant/message": return this.processAssistantMessage(session, current, event, route);
				default: return current;
			}
		}
		/** Attach final or legacy historical usage to the step's successful attempt. */
		async processAssistantMessage(session, current, event, route) {
			const stepId = stepKey(event.data.turn, event.data.step);
			if ((current.successfulAttempts[stepId] ?? current.activeAttempts[stepId]) !== void 0) return event.data.usage === void 0 ? current : this.replaceFinalUsage(session, current, event.data.turn, event.data.step, event.data.usage);
			const attemptId = legacyAttemptId(event.data.turn, event.data.step);
			const key = callKey(session, attemptId);
			const calls = this.requireCalls();
			const existing = calls.get(key);
			if (existing === void 0) await calls.put(key, {
				sessionId: session.id,
				createdAt: session.header.createdAt,
				...session.header.cwd === void 0 ? {} : { workspace: session.header.cwd },
				day: utcDay(event.time),
				attemptId,
				turn: event.data.turn,
				step: event.data.step,
				provider: route.provider,
				model: route.model,
				startedAt: event.time,
				outcome: "success",
				...event.data.usage === void 0 ? {} : { finalUsage: usageOf(event.data.usage) }
			});
			else if (existing.finalUsage === void 0 && event.data.usage !== void 0) await calls.put(key, {
				...existing,
				finalUsage: usageOf(event.data.usage),
				outcome: "success"
			});
			return {
				...current,
				successfulAttempts: {
					...current.successfulAttempts,
					[stepId]: attemptId
				}
			};
		}
		/** Create one idempotent call row or record its terminal outcome. */
		async processAttempt(session, current, event) {
			const { attemptId, turn, step } = event.data;
			const key = callKey(session, attemptId);
			const calls = this.requireCalls();
			const stepId = stepKey(turn, step);
			if (event.data.phase === "start") {
				if (calls.get(key) === void 0) await calls.put(key, {
					sessionId: session.id,
					createdAt: session.header.createdAt,
					...session.header.cwd === void 0 ? {} : { workspace: session.header.cwd },
					day: utcDay(event.data.startedAt),
					attemptId,
					startedAt: event.data.startedAt,
					turn,
					step,
					provider: event.data.provider,
					model: event.data.model
				});
				return {
					...current,
					activeAttempts: {
						...current.activeAttempts,
						[stepId]: attemptId
					}
				};
			}
			const row = calls.get(key);
			if (row === void 0) return current;
			await calls.put(key, {
				...row,
				outcome: event.data.outcome
			});
			const activeAttempts = { ...current.activeAttempts };
			Reflect.deleteProperty(activeAttempts, stepId);
			const successfulAttempts = event.data.outcome === "success" ? {
				...current.successfulAttempts,
				[stepId]: attemptId
			} : current.successfulAttempts;
			return {
				...current,
				activeAttempts,
				successfulAttempts
			};
		}
		/** Mark the failed attempt that a completed retry wait is about to repeat. */
		async markRetry(session, current, turn, step) {
			const row = [...this.requireCalls().entries()].map(([, row]) => row).filter((row) => row.sessionId === session.id && row.createdAt === session.header.createdAt && row.turn === turn && row.step === step && (row.outcome === "failure" || row.outcome === "aborted") && row.retryScheduled !== true).sort((left, right) => left.startedAt - right.startedAt).at(-1);
			if (row !== void 0) await this.requireCalls().put(callKey(session, row.attemptId), {
				...row,
				retryScheduled: true
			});
			return current;
		}
		/** Replace one active attempt's latest provisional stream metering. */
		async replaceProvisionalUsage(session, current, turn, step, usage) {
			const attemptId = current.activeAttempts[stepKey(turn, step)];
			if (attemptId === void 0) return current;
			const key = callKey(session, attemptId);
			const row = this.requireCalls().get(key);
			if (row !== void 0) await this.requireCalls().put(key, {
				...row,
				provisionalUsage: usageOf(usage)
			});
			return current;
		}
		/** Replace the successful attempt's provisional metering with final message usage. */
		async replaceFinalUsage(session, current, turn, step, usage) {
			const attemptId = current.successfulAttempts[stepKey(turn, step)];
			if (attemptId === void 0) return current;
			const key = callKey(session, attemptId);
			const row = this.requireCalls().get(key);
			if (row !== void 0) await this.requireCalls().put(key, {
				...row,
				finalUsage: usageOf(usage)
			});
			return current;
		}
		/** Create the initial cursor at the first live sequence after a fork prefix. */
		emptySessionRow(session) {
			return {
				createdAt: session.header.createdAt,
				...session.header.cwd === void 0 ? {} : { workspace: session.header.cwd },
				observedSeq: (session.header.seedLength ?? 0) - 1,
				activeAttempts: {},
				successfulAttempts: {}
			};
		}
		/** Serialize one session's best-effort observer work without delaying append. */
		enqueue(session, operation) {
			if (!this.accepting) return;
			const tail = (this.tails.get(session) ?? Promise.resolve()).then(operation).catch((error) => {
				this.ctx.logger.warn(`usage ledger: session '${session.id}' update failed: ${String(error)}`);
			});
			this.tails.set(session, tail);
			tail.then(() => {
				if (this.tails.get(session) === tail) this.tails.delete(session);
			});
		}
		/** Return the opened lifecycle-cursor table. */
		requireSessions() {
			if (this.sessions === void 0) throw new Error("usage ledger is not initialized");
			return this.sessions;
		}
		/** Return the opened idempotent provider-call table. */
		requireCalls() {
			if (this.calls === void 0) throw new Error("usage ledger is not initialized");
			return this.calls;
		}
	};
})();
/** Project persisted call rows into the small browser event vocabulary. */
function projectEvents(rows) {
	return [...rows].sort((left, right) => left.startedAt - right.startedAt).map((row) => {
		const usage = usageFor(row);
		return {
			at: row.startedAt,
			workspace: row.workspace ?? null,
			provider: row.provider,
			model: row.model,
			outcome: row.outcome ?? "started",
			retried: row.retryScheduled === true,
			...usage === void 0 ? {} : {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadTokens: usage.cacheReadTokens,
				cacheWriteTokens: usage.cacheWriteTokens
			}
		};
	});
}
/** Add one request attempt and its current known usage to an aggregate row. */
function addAttempt(row, call) {
	const usage = usageFor(call);
	return {
		...row,
		inputTokens: row.inputTokens + (usage?.inputTokens ?? 0),
		outputTokens: row.outputTokens + (usage?.outputTokens ?? 0),
		cacheReadTokens: row.cacheReadTokens + (usage?.cacheReadTokens ?? 0),
		cacheWriteTokens: row.cacheWriteTokens + (usage?.cacheWriteTokens ?? 0),
		requests: row.requests + 1,
		successfulRequests: row.successfulRequests + (call.outcome === "success" ? 1 : 0),
		failedRequests: row.failedRequests + (call.outcome === "failure" || call.outcome === "aborted" ? 1 : 0),
		retryRequests: row.retryRequests + (call.retryScheduled === true ? 1 : 0),
		meteredRequests: row.meteredRequests + (usage === void 0 ? 0 : 1),
		unmeteredRequests: row.unmeteredRequests + (usage === void 0 ? 1 : 0)
	};
}
/** Sort grouped model rows into deterministic Remote output. */
function compareModels(left, right) {
	return (left.workspace ?? "").localeCompare(right.workspace ?? "") || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model);
}
//#endregion
export { USAGE_LEDGER_SETTINGS_NAMESPACE, UsageLedgerService, UsageLedgerService as default, usageLedgerCallRowSchema, usageLedgerDomainSpec, usageLedgerSessionRowSchema };
