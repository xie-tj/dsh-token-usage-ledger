import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z as z$1 } from "zod";
//#region lib/types/host/event-types.js
/** Session event vocabulary used by the usage ledger. */
/**
* Attach the provider-attempt brand to an identifier derived by this plugin.
* @param value - Stable identifier from an official session event.
* @returns The same identifier with its compile-time domain brand.
*/
function createUsageAttemptId(value) {
	return value;
}
//#endregion
//#region lib/types/host/spec.js
/** Persistent `usage_ledger` domain declaration and stored-record schemas. */
const nonNegativeInteger = z$1.number().int().nonnegative();
const tokenUsageSchema = z$1.object({
	inputTokens: nonNegativeInteger,
	outputTokens: nonNegativeInteger,
	cacheReadTokens: nonNegativeInteger,
	cacheWriteTokens: nonNegativeInteger
});
const attemptIdSchema = z$1.string().transform(createUsageAttemptId);
/** Zod schema for the lifecycle cursor and attempt lookup tables. */
const usageLedgerSessionRowSchema = z$1.object({
	createdAt: nonNegativeInteger,
	workspace: z$1.string().optional(),
	observedSeq: z$1.number().int().min(-1),
	activeAttempts: z$1.record(z$1.string(), attemptIdSchema),
	successfulAttempts: z$1.record(z$1.string(), attemptIdSchema)
});
/** Zod schema for one persisted provider attempt. */
const usageLedgerCallRowSchema = z$1.object({
	sessionId: z$1.string(),
	createdAt: nonNegativeInteger,
	workspace: z$1.string().optional(),
	day: z$1.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	attemptId: attemptIdSchema,
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
//#region lib/types/host/index.js
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
const HISTORICAL_READ_BATCH_SIZE = 256;
/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
const USAGE_LEDGER_SETTINGS_NAMESPACE = "usage-ledger";
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
	return createUsageAttemptId(`legacy:${turn}:${step}`);
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
/** Validate persistence metadata before it enters the ledger's session model. */
function sessionHeader(value) {
	if (!isRecord(value) || !Number.isSafeInteger(value.version) || typeof value.id !== "string" || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || typeof value.isSeeded !== "boolean" || value.cwd !== void 0 && typeof value.cwd !== "string" || value.parentSession !== void 0 && typeof value.parentSession !== "string" || value.origin !== void 0 && value.origin !== "subagent" || value.delegationDepth !== void 0 && (typeof value.delegationDepth !== "number" || !Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0) || value.agentPreset !== void 0 && typeof value.agentPreset !== "string") throw new TypeError("usage ledger received invalid session metadata");
	return value;
}
function inheritedCount(value, eventCount, seeded) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > eventCount || !seeded && value !== 0) throw new TypeError("usage ledger received invalid inherited event count");
	return value;
}
/** Adapt the two alpha.5 persistence runtimes to one bounded historical reader. */
async function historicalListing(persistence) {
	const listed = await persistence.list();
	if (!Array.isArray(listed)) throw new TypeError("usage ledger received an invalid session listing");
	return listed.map((entry) => {
		const record = isRecord(entry) && isRecord(entry.header) ? entry : void 0;
		const header = sessionHeader(record === void 0 ? entry : record.header);
		return {
			id: header.id,
			header
		};
	});
}
async function openHistorical(persistence, descriptor) {
	const runtime = persistence;
	if (typeof runtime.open === "function") {
		const raw = await runtime.open(descriptor.id, "read");
		if (!isRecord(raw) || typeof raw.close !== "function") throw new TypeError("usage ledger received an invalid session read handle");
		const close = raw.close;
		let closed = false;
		const closeOnce = async () => {
			if (closed) return;
			closed = true;
			await close();
		};
		let transferred = false;
		try {
			if (typeof raw.read !== "function") throw new TypeError("usage ledger received an invalid session read handle");
			const read = raw.read;
			const header = sessionHeader(raw.header);
			if (header.id !== descriptor.id) throw new TypeError("usage ledger session metadata id mismatch");
			const cut = inheritedCount(raw.inheritedEventCount, Number.MAX_SAFE_INTEGER, header.isSeeded);
			transferred = true;
			return {
				id: descriptor.id,
				header,
				inheritedEventCount: cut,
				read: async (offset = 0, length = HISTORICAL_READ_BATCH_SIZE) => {
					const events = await read(offset, length);
					if (!Array.isArray(events)) throw new TypeError("usage ledger received an invalid session event batch");
					return events;
				},
				close: closeOnce
			};
		} finally {
			if (!transferred) await closeOnce();
		}
	}
	if (typeof runtime.inspect !== "function") throw new TypeError("usage ledger persistence has no historical reader");
	const raw = await runtime.inspect(descriptor.id);
	if (!isRecord(raw) || !("meta" in raw) || !Array.isArray(raw.events)) throw new TypeError("usage ledger received an invalid session inspection");
	const events = raw.events;
	const header = sessionHeader(raw.meta);
	if (header.id !== descriptor.id) throw new TypeError("usage ledger session metadata id mismatch");
	const cut = inheritedCount(raw.inheritedEventCount, events.length, header.isSeeded);
	return {
		id: descriptor.id,
		header,
		inheritedEventCount: cut,
		read: async (offset = 0, length = HISTORICAL_READ_BATCH_SIZE) => events.slice(offset, offset + length),
		close: async () => {}
	};
}
/** Resolve the latest provider/model route recorded before one historical event. */
function routeBefore(session, throughSeq) {
	let route = {
		provider: "unknown",
		model: "unknown"
	};
	for (const event of session.snapshotEvents()) {
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
			}, { global: true });
			this.ctx.on("session/event", (session, event) => {
				this.schedule(session, event.seq);
			}, { global: true });
			this.ctx.on("session/disposed", (session) => {
				this.enqueue(session, async () => {
					this.cursors.delete(session);
					this.routes.delete(session);
					if (sameLifecycle(this.requireSessions().get(session.id), session)) await this.requireSessions().delete(session.id);
				});
			}, { global: true });
			this.ctx.on("session/flush", (session) => this.flushSession(session), { global: true });
			for (const session of this.ctx.sessions.list()) this.adopt(session);
			this.backfillPromise = this.backfill(this.ctx.sessionPersistence);
		}
		/** Replay cold persisted sessions without publishing them as live sessions. */
		async backfill(persistence) {
			let snapshots;
			try {
				snapshots = await historicalListing(persistence);
			} catch (error) {
				this.ctx.logger.warn(`usage ledger: historical session listing failed: ${String(error)}`);
				return;
			}
			for (const snapshot of snapshots) {
				if (!this.accepting) return;
				const id = snapshot.id;
				const live = this.ctx.sessions.get(id);
				if (live !== void 0) {
					this.adopt(live);
					continue;
				}
				try {
					const handle = await openHistorical(persistence, snapshot);
					try {
						const liveAfterOpen = this.ctx.sessions.get(id);
						if (liveAfterOpen !== void 0) {
							this.adopt(liveAfterOpen);
							continue;
						}
						const historical = {
							id,
							header: handle.header,
							inheritedEventCount: handle.inheritedEventCount
						};
						this.coldSessions.add(historical);
						try {
							let current = this.cursors.get(historical) ?? this.requireSessions().get(id) ?? this.emptySessionRow(historical);
							let route = this.routes.get(historical) ?? {
								provider: "unknown",
								model: "unknown"
							};
							let offset = 0;
							while (this.accepting) {
								const events = await handle.read(offset, HISTORICAL_READ_BATCH_SIZE);
								if (events.length === 0) {
									if (handle.inheritedEventCount > offset) throw new TypeError("usage ledger inherited event count exceeds the persisted event stream");
									break;
								}
								if (events.length > HISTORICAL_READ_BATCH_SIZE) throw new TypeError("usage ledger received an oversized session event batch");
								for (const event of events) {
									if (!Number.isSafeInteger(event.seq) || event.seq !== offset) throw new TypeError("usage ledger received a non-sequential session event stream");
									route = routeAfter(route, event);
									if (event.seq >= handle.inheritedEventCount && event.seq > current.observedSeq) current = {
										...await this.processEvent(historical, current, event, route),
										observedSeq: event.seq
									};
									offset += 1;
								}
							}
							this.routes.set(historical, route);
							if (current.observedSeq >= 0) this.cursors.set(historical, current);
							await this.flushSession(historical);
						} finally {
							this.coldSessions.delete(historical);
							this.cursors.delete(historical);
							this.routes.delete(historical);
						}
					} finally {
						await handle.close();
					}
				} catch (error) {
					this.ctx.logger.warn(`usage ledger: historical session '${id}' skipped: ${String(error)}`);
				}
			}
			await this.drainTails();
			await this.persistCursors();
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
			const firstLiveSeq = session.firstLiveSeq;
			const startSeq = this.coldSessions.has(session) ? current.observedSeq + 1 : Math.max(firstLiveSeq, current.observedSeq + 1);
			const eventCount = this.coldSessions.has(session) ? session.firstLiveSeq : session.snapshotEvents().length;
			let route = this.routes.get(session) ?? routeBefore(session, startSeq);
			for (let seq = startSeq; seq <= throughSeq && seq < eventCount; seq += 1) {
				const event = session.snapshotEvents()[seq];
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
				case "llm/retry-started": return await this.createAttempt(session, current, event.data.turn, event.data.step, event.time, route, `retry:${String(event.data.retryId)}:${event.data.retry}`);
				case "step/start": return this.createAttempt(session, current, event.data.turn, event.data.step, event.time, route, `step:${event.data.turn}:${event.data.step}`);
				case "request/header":
				case "request/context": return this.updateActiveRoute(session, current, route);
				case "turn/end":
					if (event.data.reason.kind === "error" || event.data.reason.kind === "aborted" || event.data.reason.kind === "interrupted") return this.terminateActive(session, current, event.data.turn, event.data.reason.kind === "error" ? "failure" : "aborted");
					return current;
				case "llm/retry": return this.processRetry(session, current, event);
				case "assistant/chunk":
					if (event.data.chunk.type === "usage") return this.recordProvisionalUsage(session, current, event, route, event.data.chunk.usage);
					if (event.data.chunk.type === "finish") return this.recordFinish(session, current, event, route, event.data.chunk.reason.kind);
					return current;
				case "assistant/message": return this.processAssistantMessage(session, current, event, route);
				default: return current;
			}
		}
		/** Record the terminal result of the official provider stream. */
		async recordFinish(session, current, event, _route, kind) {
			const attemptId = current.activeAttempts[stepKey(event.data.turn, event.data.step)];
			if (attemptId === void 0) return current;
			const key = callKey(session, attemptId);
			const row = this.requireCalls().get(key);
			if (row === void 0) return current;
			let outcome;
			switch (kind) {
				case "error":
					outcome = "failure";
					break;
				case "aborted":
					outcome = "aborted";
					break;
				case "stop":
				case "tool-calls":
				case "max-tokens":
					outcome = "success";
					break;
				default: return current;
			}
			if (row.outcome === void 0) await this.requireCalls().put(key, {
				...row,
				outcome
			});
			return current;
		}
		/** Attach final or legacy historical usage to the step's successful attempt. */
		async processAssistantMessage(session, current, event, route) {
			const stepId = stepKey(event.data.turn, event.data.step);
			const existingAttemptId = current.successfulAttempts[stepId] ?? current.activeAttempts[stepId];
			if (existingAttemptId !== void 0) {
				const next = event.data.usage === void 0 ? current : await this.replaceFinalUsage(session, current, event.data.turn, event.data.step, event.data.usage);
				const activeAttempts = { ...next.activeAttempts };
				Reflect.deleteProperty(activeAttempts, stepId);
				const existing = this.requireCalls().get(callKey(session, existingAttemptId));
				const outcome = existing?.outcome ?? (event.data.interrupted === true ? "aborted" : "success");
				if (existing !== void 0 && existing.outcome !== outcome) await this.requireCalls().put(callKey(session, existingAttemptId), {
					...existing,
					outcome
				});
				return {
					...next,
					activeAttempts,
					successfulAttempts: {
						...next.successfulAttempts,
						[stepId]: existingAttemptId
					}
				};
			}
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
				outcome: event.data.interrupted === true ? "aborted" : "success",
				...event.data.usage === void 0 ? {} : { finalUsage: usageOf(event.data.usage) }
			});
			else if (existing.finalUsage === void 0 && event.data.usage !== void 0) await calls.put(key, {
				...existing,
				finalUsage: usageOf(event.data.usage),
				outcome: existing.outcome ?? "success"
			});
			return {
				...current,
				successfulAttempts: event.data.interrupted === true ? current.successfulAttempts : {
					...current.successfulAttempts,
					[stepId]: attemptId
				}
			};
		}
		/** Create one idempotent unmetered row for the first event of a provider dispatch. */
		async createAttempt(session, current, turn, step, startedAt, route, seed) {
			const stepId = stepKey(turn, step);
			const attemptId = createUsageAttemptId(seed);
			const key = callKey(session, attemptId);
			if (this.requireCalls().get(key) === void 0) await this.requireCalls().put(key, {
				sessionId: session.id,
				createdAt: session.header.createdAt,
				...session.header.cwd === void 0 ? {} : { workspace: session.header.cwd },
				day: utcDay(startedAt),
				attemptId,
				turn,
				step,
				provider: route.provider,
				model: route.model,
				startedAt
			});
			return {
				...current,
				activeAttempts: {
					...current.activeAttempts,
					[stepId]: attemptId
				}
			};
		}
		/** Apply the route discovered after dispatch creation to its active row. */
		async updateActiveRoute(session, current, route) {
			for (const attemptId of Object.values(current.activeAttempts)) {
				const key = callKey(session, attemptId);
				const row = this.requireCalls().get(key);
				if (row !== void 0 && (row.provider !== route.provider || row.model !== route.model)) await this.requireCalls().put(key, {
					...row,
					provider: route.provider,
					model: route.model
				});
			}
			return current;
		}
		/** Terminate only unresolved attempts in the ended turn. */
		async terminateActive(session, current, turn, outcome) {
			for (const [stepId, attemptId] of Object.entries(current.activeAttempts)) {
				const row = this.requireCalls().get(callKey(session, attemptId));
				if (row !== void 0 && row.turn === turn && row.outcome === void 0) await this.requireCalls().put(callKey(session, attemptId), {
					...row,
					outcome
				});
				if (row !== void 0 && row.turn === turn && row.outcome !== void 0) {
					const activeAttempts = { ...current.activeAttempts };
					Reflect.deleteProperty(activeAttempts, stepId);
					current = {
						...current,
						activeAttempts
					};
				}
			}
			return current;
		}
		/** Mark a known failed provider request when the official retry event schedules another dispatch. */
		async processRetry(session, current, event) {
			const stepId = stepKey(event.data.turn, event.data.step);
			const activeAttemptId = current.activeAttempts[stepId];
			if (activeAttemptId === void 0) return current;
			const key = callKey(session, activeAttemptId);
			const row = this.requireCalls().get(key);
			if (row !== void 0) await this.requireCalls().put(key, {
				...row,
				...row.outcome === void 0 ? { outcome: "failure" } : {},
				retryScheduled: true
			});
			return current;
		}
		/** Record official usage from an assistant stream chunk. */
		async recordProvisionalUsage(session, current, event, route, usage) {
			const stepId = stepKey(event.data.turn, event.data.step);
			const attemptId = current.activeAttempts[stepId] ?? createUsageAttemptId(`stream:${event.data.turn}:${event.data.step}:${event.seq}`);
			const key = callKey(session, attemptId);
			const calls = this.requireCalls();
			const row = calls.get(key);
			if (row === void 0) await calls.put(key, {
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
				provisionalUsage: usageOf(usage)
			});
			else await calls.put(key, {
				...row,
				provisionalUsage: usageOf(usage)
			});
			return {
				...current,
				activeAttempts: {
					...current.activeAttempts,
					[stepId]: attemptId
				}
			};
		}
		/** Replace the successful attempt's provisional metering with final message usage. */
		async replaceFinalUsage(session, current, turn, step, usage) {
			const attemptId = current.successfulAttempts[stepKey(turn, step)] ?? current.activeAttempts[stepKey(turn, step)];
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
				observedSeq: this.coldSessions.has(session) ? -1 : session.firstLiveSeq - 1,
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
