import { n as encodeWorkerFrame, r as createUsageAttemptId } from "./worker-protocol-B6MoPLmQ.js";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z as z$1 } from "zod";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
	version: 3,
	tables: {
		sessions: domainTable(usageLedgerSessionRowSchema),
		calls: domainTable(usageLedgerCallRowSchema)
	}
});
//#endregion
//#region lib/types/host/supervisor.js
/** Crash-contained child-process supervisor for the Usage Ledger reducer. */
const RESTART_MIN_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 5e3;
const MAX_PENDING_SESSIONS = 1024;
function safeWorkerEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === void 0 || key === "NODE_OPTIONS" || key.startsWith("DSH_")) continue;
		if (/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH)/i.test(key)) continue;
		env[key] = value;
	}
	return env;
}
function defaultWorkerPath() {
	return fileURLToPath(import.meta.url.endsWith(".ts") ? new URL("../../lib/backfill-worker.js", import.meta.url) : new URL("./backfill-worker.js", import.meta.url));
}
/**
* Keep the main process responsive when the worker pipe is full. Live frames
* are coalesced by session; the next provider-backed rescan repairs any
* sequence gap after persistence catches up.
*/
var UsageWorkerSupervisor = class {
	callbacks;
	workerPath;
	child;
	output;
	initFrame;
	blocked = false;
	stopping = false;
	restartTimer;
	restartDelay = RESTART_MIN_DELAY_MS;
	pendingLive = /* @__PURE__ */ new Map();
	pendingControl = /* @__PURE__ */ new Map();
	exitPromise;
	resolveExit;
	constructor(callbacks, workerPath = defaultWorkerPath()) {
		this.callbacks = callbacks;
		this.workerPath = workerPath;
	}
	/** Start or replace the child with a complete initialization snapshot. */
	start(frame) {
		this.initFrame = frame;
		this.stopping = false;
		this.spawnWorker();
	}
	/** Send one compact live event, merging it when stdin applies backpressure. */
	sendLive(frame) {
		if (this.child === void 0 || this.stopping || this.blocked || this.pendingLive.size > 0) {
			this.pendingLive.set(frame.session.id, frame);
			this.trimPending(this.pendingLive);
			return;
		}
		this.write(frame);
	}
	/** Send a control frame, also coalesced per session while the pipe is full. */
	sendControl(frame, key) {
		if (this.child === void 0 || this.stopping || this.blocked || this.pendingLive.size > 0) {
			this.pendingControl.set(key, frame);
			this.trimPending(this.pendingControl);
			return;
		}
		this.write(frame);
	}
	/** Stop without making plugin disposal wait for a wedged worker. */
	async stop() {
		this.stopping = true;
		if (this.restartTimer !== void 0) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		const child = this.child;
		if (child === void 0) return;
		if (!child.stdin.destroyed && !child.stdin.writableEnded) {
			this.write({ type: "stop" });
			child.stdin.end();
		}
		const exit = this.exitPromise ?? Promise.resolve();
		await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 1e3))]);
		if (this.child !== void 0 && !this.child.killed) this.child.kill("SIGTERM");
		this.child = void 0;
		this.output?.close();
		this.output = void 0;
	}
	spawnWorker() {
		if (this.stopping || this.initFrame === void 0) return;
		const nodeArgs = [`--max-old-space-size=${String(this.initFrame.config.workerMaxHeapMiB ?? 512)}`, this.workerPath];
		const command = process.platform === "win32" ? process.execPath : "nice";
		const args = process.platform === "win32" ? nodeArgs : [
			"-n",
			"10",
			process.execPath,
			...nodeArgs
		];
		let child;
		try {
			child = spawn(command, args, {
				cwd: process.cwd(),
				env: safeWorkerEnv(),
				stdio: [
					"pipe",
					"pipe",
					"pipe"
				]
			});
		} catch (error) {
			this.failed(error);
			return;
		}
		this.child = child;
		this.blocked = false;
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.output = createInterface({
			input: child.stdout,
			crlfDelay: Infinity
		});
		this.output.on("line", (line) => {
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				this.failed(/* @__PURE__ */ new Error("usage ledger worker emitted invalid JSON"));
				return;
			}
			this.callbacks.onResponse(frame);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8").trim();
			if (text.length > 0) this.callbacks.onFailure(`usage ledger worker: ${text.slice(-500)}`);
		});
		child.stdin.on("error", (error) => {
			this.failed(error);
		});
		child.on("error", (error) => {
			this.failed(error);
		});
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = void 0;
			this.output?.close();
			this.output = void 0;
			this.resolveExit?.();
			this.resolveExit = void 0;
			if (this.stopping) return;
			this.callbacks.onFailure(`usage ledger worker exited (${String(code ?? signal ?? "unknown")})`);
			const delay = this.restartDelay;
			this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_DELAY_MS);
			this.restartTimer = setTimeout(() => {
				this.restartTimer = void 0;
				this.spawnWorker();
			}, delay);
		});
		this.restartDelay = RESTART_MIN_DELAY_MS;
		this.write(this.initFrame);
		this.flushPending();
	}
	write(frame) {
		if (frame === void 0 || this.child === void 0 || this.stopping && frame.type !== "stop") return;
		try {
			if (!this.child.stdin.write(encodeWorkerFrame(frame))) {
				this.blocked = true;
				this.child.stdin.once("drain", () => {
					this.blocked = false;
					this.flushPending();
				});
			}
		} catch (error) {
			this.failed(error);
		}
	}
	flushPending() {
		if (this.blocked || this.child === void 0 || this.stopping) return;
		const control = this.pendingControl.values().next().value;
		if (control !== void 0) {
			const key = control.type === "dispose" || control.type === "rescan" ? control.session.id : control.type;
			this.pendingControl.delete(key);
			this.write(control);
			if (this.blocked) return;
		}
		const live = this.pendingLive.values().next().value;
		if (live !== void 0) {
			this.pendingLive.delete(live.session.id);
			this.write(live);
		}
	}
	trimPending(pending) {
		while (pending.size > MAX_PENDING_SESSIONS) {
			const oldest = pending.keys().next().value;
			if (oldest === void 0) return;
			pending.delete(oldest);
		}
	}
	failed(error) {
		this.callbacks.onFailure(error instanceof Error ? error.message : String(error));
	}
};
//#endregion
//#region lib/types/host/index.js
/** Host-side Usage Ledger coordinator; heavy replay runs in a private worker. */
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
const DEFAULT_BATCH_EVENTS = 256;
const DEFAULT_SLICE_MS = 25;
const DEFAULT_HEAP_MIB = 512;
/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
const USAGE_LEDGER_SETTINGS_NAMESPACE = "usage-ledger";
const UsageLedgerSettingsSchema = z.object({});
const BackfillModeSchema = z.union([z.const("process"), z.const("off")]);
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
function resolveConfig(config) {
	const backfillMode = config.backfillMode ?? "process";
	const backfillDays = config.backfillDays ?? DEFAULT_DAYS;
	const workerMaxHeapMiB = config.workerMaxHeapMiB ?? DEFAULT_HEAP_MIB;
	const workerBatchEvents = config.workerBatchEvents ?? DEFAULT_BATCH_EVENTS;
	const workerSliceMs = config.workerSliceMs ?? DEFAULT_SLICE_MS;
	if (backfillMode !== "process" && backfillMode !== "off") throw new RangeError(`usage ledger backfillMode is invalid: '${String(backfillMode)}'`);
	for (const [name, value, min, max] of [
		[
			"backfillDays",
			backfillDays,
			1,
			MAX_DAYS
		],
		[
			"workerMaxHeapMiB",
			workerMaxHeapMiB,
			128,
			4096
		],
		[
			"workerBatchEvents",
			workerBatchEvents,
			1,
			4096
		],
		[
			"workerSliceMs",
			workerSliceMs,
			1,
			1e3
		]
	]) if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`usage ledger ${name} must be a safe integer from ${String(min)} through ${String(max)}`);
	return {
		backfillMode,
		backfillDays,
		workerMaxHeapMiB,
		workerBatchEvents,
		workerSliceMs
	};
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
function utcDay(time) {
	return new Date(time).toISOString().slice(0, 10);
}
function shiftDay(day, offset) {
	const instant = /* @__PURE__ */ new Date(`${day}T00:00:00.000Z`);
	instant.setUTCDate(instant.getUTCDate() + offset);
	return utcDay(instant.getTime());
}
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
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function validateHeader(value) {
	if (!isRecord(value) || !Number.isSafeInteger(value.version) || typeof value.id !== "string" || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || typeof value.isSeeded !== "boolean" || value.cwd !== void 0 && typeof value.cwd !== "string" || value.parentSession !== void 0 && typeof value.parentSession !== "string" || value.origin !== void 0 && value.origin !== "subagent" || value.delegationDepth !== void 0 && (typeof value.delegationDepth !== "number" || !Number.isSafeInteger(value.delegationDepth) || value.delegationDepth < 0) || value.agentPreset !== void 0 && typeof value.agentPreset !== "string") throw new TypeError("usage ledger received invalid session metadata");
	return value;
}
async function listRecentSessions(persistence, days) {
	const listed = await persistence.list();
	if (!Array.isArray(listed)) throw new TypeError("usage ledger received an invalid session listing");
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1e3;
	const result = [];
	for (const value of listed) {
		const header = validateHeader(isRecord(value) && isRecord(value.header) ? value.header : value);
		if (header.createdAt >= cutoff) result.push({ header });
	}
	return result;
}
function validateReaderSpec(value) {
	if (value === void 0) return void 0;
	if (!isRecord(value) || typeof value.protocolVersion !== "number" || typeof value.workerModule !== "string" || value.workerModule.length === 0) throw new TypeError("usage ledger received an invalid background reader spec");
	if (value.options !== void 0 && (!isRecord(value.options) || Object.values(value.options).some((option) => typeof option !== "string" && typeof option !== "number" && typeof option !== "boolean"))) throw new TypeError("usage ledger background reader options must be JSON-safe primitives");
	return value;
}
/** Copy only the usage-bearing fields across the process boundary. */
function compactEvent(event) {
	const base = {
		seq: event.seq,
		time: event.time
	};
	switch (event.type) {
		case "step/start": return {
			...base,
			type: event.type,
			data: event.data
		};
		case "request/context": return {
			...base,
			type: event.type,
			data: {
				provider: event.data.provider,
				model: event.data.model
			}
		};
		case "request/header": {
			const { provider, model } = event.data.header.config;
			return {
				...base,
				type: event.type,
				data: {
					reason: event.data.reason,
					header: { config: {
						provider,
						model
					} }
				}
			};
		}
		case "llm/retry": return {
			...base,
			type: event.type,
			data: {
				turn: event.data.turn,
				step: event.data.step
			}
		};
		case "llm/retry-started": return {
			...base,
			type: event.type,
			data: {
				retryId: event.data.retryId,
				turn: event.data.turn,
				step: event.data.step,
				retry: event.data.retry
			}
		};
		case "turn/end": return {
			...base,
			type: event.type,
			data: {
				turn: event.data.turn,
				reason: { kind: event.data.reason.kind }
			}
		};
		case "assistant/chunk":
			if (event.data.chunk.type === "usage") return {
				...base,
				type: event.type,
				data: {
					turn: event.data.turn,
					step: event.data.step,
					chunk: {
						type: "usage",
						usage: event.data.chunk.usage
					}
				}
			};
			if (event.data.chunk.type === "finish") return {
				...base,
				type: event.type,
				data: {
					turn: event.data.turn,
					step: event.data.step,
					chunk: {
						type: "finish",
						reason: { kind: event.data.chunk.reason.kind }
					}
				}
			};
			return;
		case "assistant/message": return {
			...base,
			type: event.type,
			data: {
				turn: event.data.turn,
				step: event.data.step,
				...event.data.usage === void 0 ? {} : { usage: event.data.usage },
				...event.data.interrupted === true ? { interrupted: true } : {}
			}
		};
		default: return;
	}
}
function workerSession(session) {
	return {
		id: session.id,
		createdAt: session.header.createdAt,
		...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd },
		inheritedEventCount: session.inheritedEventCount
	};
}
function addAttempt(row, call) {
	const usage = call.finalUsage ?? call.provisionalUsage;
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
function projectEvents(rows) {
	return [...rows].sort((left, right) => left.startedAt - right.startedAt).map((row) => {
		const usage = row.finalUsage ?? row.provisionalUsage;
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
function compareModels(left, right) {
	return (left.workspace ?? "").localeCompare(right.workspace ?? "") || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model);
}
/** Host service that coordinates compact live events and isolated history replay. */
let UsageLedgerService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _snapshot_decorators;
	let _statusSnapshot_decorators;
	return class UsageLedgerService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_snapshot_decorators = [Remote("snapshot")];
			_statusSnapshot_decorators = [Remote("status")];
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
			__esDecorate(this, null, _statusSnapshot_decorators, {
				kind: "method",
				name: "statusSnapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "statusSnapshot" in obj,
					get: (obj) => obj.statusSnapshot
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
		static Config = z.object({
			backfillMode: BackfillModeSchema.default("process"),
			backfillDays: z.number().step(1).min(1).max(MAX_DAYS).default(DEFAULT_DAYS),
			workerMaxHeapMiB: z.number().step(1).min(128).max(4096).default(DEFAULT_HEAP_MIB),
			workerBatchEvents: z.number().step(1).min(1).max(4096).default(DEFAULT_BATCH_EVENTS),
			workerSliceMs: z.number().step(1).min(1).max(1e3).default(DEFAULT_SLICE_MS)
		});
		resolvedConfig = __runInitializers(this, _instanceExtraInitializers);
		worker;
		sessions;
		calls;
		accepting = true;
		pendingCalls = /* @__PURE__ */ new Map();
		pendingCursors = /* @__PURE__ */ new Map();
		pendingDeletes = /* @__PURE__ */ new Map();
		writeScheduled = false;
		writing = false;
		retryTimer;
		status;
		constructor(ctx, config = {}) {
			super(ctx, "usageLedger", { namespace: "usageLedgerPlugin" });
			this.resolvedConfig = resolveConfig(config);
			this.status = {
				state: this.resolvedConfig.backfillMode === "off" ? "paused" : "idle",
				totalSessions: 0,
				processedSessions: 0,
				processedEvents: 0,
				backfillDays: this.resolvedConfig.backfillDays,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			this.worker = new UsageWorkerSupervisor({
				onResponse: (frame) => this.handleWorkerResponse(frame),
				onFailure: (message) => this.recordFailure(message)
			});
			ctx.inject(["settings"], (settingsCtx) => {
				settingsCtx.settings.register(USAGE_LEDGER_SETTINGS_NAMESPACE, UsageLedgerSettingsSchema);
			});
		}
		/** Open SQLite-backed tables and install non-blocking observers. */
		async [Service.init]() {
			const domain = await this.ctx.storageDomain.open(usageLedgerDomainSpec);
			this.sessions = domain.table("sessions");
			this.calls = domain.table("calls");
			this.ctx.effect(() => async () => {
				this.accepting = false;
				await this.worker.stop();
				await this.drainWrites();
				if (this.retryTimer !== void 0) clearTimeout(this.retryTimer);
				await domain.close();
			}, "usage-ledger.domain-close");
			this.ctx.on("session/created", (session) => {
				this.worker.sendControl({
					type: "rescan",
					session: workerSession(session)
				}, session.id);
			}, { global: true });
			this.ctx.on("session/event", (session, event) => {
				const compact = compactEvent(event);
				if (compact !== void 0) this.worker.sendLive({
					type: "live",
					session: workerSession(session),
					event: compact
				});
			}, { global: true });
			this.ctx.on("session/disposed", (session) => {
				this.worker.sendControl({
					type: "dispose",
					session: workerSession(session)
				}, session.id);
			}, { global: true });
			if (this.resolvedConfig.backfillMode === "off") return;
			this.startWorker(this.ctx.sessionPersistence);
		}
		/** Start asynchronously so listing and worker startup never delay a task. */
		async startWorker(persistence) {
			let listed = [];
			try {
				listed = await listRecentSessions(persistence, this.resolvedConfig.backfillDays);
			} catch (error) {
				this.recordFailure(`historical session listing failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			let readerSpec;
			try {
				const runtime = persistence;
				readerSpec = validateReaderSpec(typeof runtime.backgroundReaderSpec === "function" ? runtime.backgroundReaderSpec() : void 0);
			} catch (error) {
				this.recordFailure(`provider-owned reader unavailable: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				const liveSessions = this.ctx.sessions.list().map(workerSession);
				const sessions = [...listed.map(({ header }) => ({
					id: header.id,
					createdAt: header.createdAt,
					...header.cwd === void 0 ? {} : { cwd: header.cwd },
					inheritedEventCount: 0
				})), ...liveSessions];
				const unique = new Map(sessions.map((session) => [session.id, session]));
				const frame = {
					type: "init",
					protocolVersion: 1,
					config: this.resolvedConfig,
					...readerSpec === void 0 ? {} : { readerSpec },
					sessions: [...unique.values()],
					liveSessionIds: liveSessions.map((session) => session.id),
					cursors: [...this.requireSessions().entries()].map(([sessionId, row]) => ({
						sessionId,
						row
					})),
					calls: [...this.requireCalls().entries()].map(([key, row]) => ({
						key,
						row
					}))
				};
				this.status = {
					...this.status,
					state: readerSpec === void 0 ? "paused" : "running",
					totalSessions: listed.length,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
					...readerSpec === void 0 ? { lastError: "session persistence does not expose backgroundReaderSpec; historical backfill is paused" } : {}
				};
				if (readerSpec === void 0) this.ctx.logger.warn("usage ledger: persistence has no provider-owned background reader; live ledger remains enabled");
				this.worker.start(frame);
			} catch (error) {
				this.recordFailure(`background worker initialization failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		/** Return committed SQLite data immediately; backfill state is independent. */
		async snapshot(request) {
			const resolved = resolveSnapshotRequest(request);
			const fromDay = shiftDay(resolved.throughDay, 1 - resolved.days);
			const models = /* @__PURE__ */ new Map();
			const daily = /* @__PURE__ */ new Map();
			const selected = [];
			for (let offset = 0; offset < resolved.days; offset += 1) {
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
				const key = JSON.stringify([
					workspace,
					row.provider,
					row.model
				]);
				const prior = models.get(key) ?? {
					workspace,
					provider: row.provider,
					model: row.model,
					...ZERO_TOTALS
				};
				models.set(key, addAttempt(prior, row));
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
		/** Non-blocking worker state for the Usage page. */
		statusSnapshot() {
			return Object.freeze({ ...this.status });
		}
		handleWorkerResponse(frame) {
			switch (frame.type) {
				case "progress":
					this.status = {
						...this.status,
						state: frame.status,
						totalSessions: frame.totalSessions,
						processedSessions: frame.processedSessions,
						processedEvents: frame.processedEvents,
						updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
						...frame.currentSessionId === void 0 ? { currentSessionId: void 0 } : { currentSessionId: frame.currentSessionId }
					};
					return;
				case "mutation":
					for (const mutation of frame.mutations) if (mutation.type === "call-upsert") this.pendingCalls.set(mutation.key, mutation.row);
					else if (mutation.type === "cursor-upsert") {
						this.pendingCursors.set(mutation.sessionId, mutation.row);
						this.pendingDeletes.delete(mutation.sessionId);
					} else {
						this.pendingDeletes.set(mutation.sessionId, mutation.createdAt);
						this.pendingCursors.delete(mutation.sessionId);
					}
					this.scheduleWrites();
					return;
				case "checkpoint":
				case "done": return;
				case "error":
					this.recordFailure(frame.sessionId === void 0 ? frame.message : `session '${frame.sessionId}': ${frame.message}`);
					return;
			}
		}
		recordFailure(message) {
			this.status = {
				...this.status,
				state: "failed",
				lastError: message,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			this.ctx.logger.warn(`usage ledger: ${message}`);
		}
		scheduleWrites() {
			if (this.writeScheduled || this.writing) return;
			this.writeScheduled = true;
			setImmediate(() => {
				this.writeScheduled = false;
				this.drainWrites();
			});
		}
		async drainWrites() {
			if (this.writing) return;
			this.writing = true;
			try {
				const calls = this.requireCalls();
				const sessions = this.requireSessions();
				const callBatch = [...this.pendingCalls.entries()].slice(0, 64);
				for (const [key] of callBatch) this.pendingCalls.delete(key);
				for (let index = 0; index < callBatch.length; index += 1) {
					const [key, row] = callBatch[index];
					try {
						await calls.put(key, row);
					} catch (error) {
						for (const [remainingKey, remainingRow] of callBatch.slice(index)) this.pendingCalls.set(remainingKey, remainingRow);
						this.recordFailure(`call write failed: ${error instanceof Error ? error.message : String(error)}`);
						break;
					}
				}
				const cursorBatch = [...this.pendingCursors.entries()].slice(0, 64);
				for (const [key] of cursorBatch) this.pendingCursors.delete(key);
				for (let index = 0; index < cursorBatch.length; index += 1) {
					const [key, row] = cursorBatch[index];
					try {
						await sessions.put(key, row);
					} catch (error) {
						for (const [remainingKey, remainingRow] of cursorBatch.slice(index)) this.pendingCursors.set(remainingKey, remainingRow);
						this.recordFailure(`cursor write failed: ${error instanceof Error ? error.message : String(error)}`);
						break;
					}
				}
				const deleteBatch = [...this.pendingDeletes.entries()].slice(0, 64);
				for (const [key] of deleteBatch) this.pendingDeletes.delete(key);
				for (let index = 0; index < deleteBatch.length; index += 1) {
					const [key, createdAt] = deleteBatch[index];
					if (sessions.get(key)?.createdAt !== createdAt) continue;
					try {
						await sessions.delete(key);
					} catch (error) {
						for (const [remainingKey, remainingCreatedAt] of deleteBatch.slice(index)) this.pendingDeletes.set(remainingKey, remainingCreatedAt);
						this.recordFailure(`cursor delete failed: ${error instanceof Error ? error.message : String(error)}`);
						break;
					}
				}
			} finally {
				this.writing = false;
			}
			if (this.pendingCalls.size > 0 || this.pendingCursors.size > 0 || this.pendingDeletes.size > 0) {
				if (this.retryTimer === void 0) this.retryTimer = setTimeout(() => {
					this.retryTimer = void 0;
					this.scheduleWrites();
				}, 250);
			}
		}
		requireSessions() {
			if (this.sessions === void 0) throw new Error("usage ledger is not initialized");
			return this.sessions;
		}
		requireCalls() {
			if (this.calls === void 0) throw new Error("usage ledger is not initialized");
			return this.calls;
		}
	};
})();
//#endregion
export { USAGE_LEDGER_SETTINGS_NAMESPACE, UsageLedgerService, UsageLedgerService as default, usageLedgerCallRowSchema, usageLedgerDomainSpec, usageLedgerSessionRowSchema };
