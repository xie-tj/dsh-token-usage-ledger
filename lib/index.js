import { i as createUsageAttemptId, n as encodeWorkerFrame, r as openUsageLedgerDatabase } from "./worker-protocol-VhYx9pk4.js";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z as z$1 } from "zod";
//#region lib/types/host/governor.js
/** Adaptive pacing policy for best-effort historical Usage Ledger replay. */
/** Stateful fast-backoff / slow-recovery controller. */
var UsageLedgerGovernor = class {
	config;
	delayMs;
	healthySamples = 0;
	constructor(config) {
		this.config = config;
		this.delayMs = config.minDelayMs;
	}
	/** Update the worker pace from one Host workload sample. */
	observe(sample) {
		if (this.config.powerMode === "ac-only" && sample.powerSource !== "ac") {
			this.healthySamples = 0;
			return {
				mode: "pause",
				delayMs: this.config.maxDelayMs,
				reason: "battery"
			};
		}
		if (sample.rssMiB >= this.config.pauseRssMiB || this.config.pauseAvailableMemoryMiB > 0 && sample.availableMemoryMiB !== void 0 && sample.availableMemoryMiB <= this.config.pauseAvailableMemoryMiB) {
			this.healthySamples = 0;
			return {
				mode: "pause",
				delayMs: this.config.maxDelayMs,
				reason: "memory"
			};
		}
		if (sample.eventLoopUtilization >= this.config.pauseEventLoopUtilization || sample.eventLoopDelayMs >= this.config.pauseEventLoopDelayMs) {
			this.healthySamples = 0;
			return {
				mode: "pause",
				delayMs: this.config.maxDelayMs,
				reason: "event-loop"
			};
		}
		if (sample.eventLoopUtilization >= this.config.busyEventLoopUtilization || sample.eventLoopDelayMs >= this.config.busyEventLoopDelayMs) {
			this.healthySamples = 0;
			this.delayMs = Math.min(this.config.maxDelayMs, Math.max(this.config.minDelayMs, Math.max(1, this.delayMs) * 2));
			return {
				mode: "run",
				delayMs: this.delayMs,
				reason: "event-loop"
			};
		}
		this.healthySamples += 1;
		if (this.healthySamples >= this.config.recoverySamples) {
			this.healthySamples = 0;
			this.delayMs = Math.max(this.config.minDelayMs, Math.floor(this.delayMs * .75));
		}
		return {
			mode: "run",
			delayMs: this.delayMs
		};
	}
};
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
	refreshInit;
	restarting = false;
	pendingLive = /* @__PURE__ */ new Map();
	pendingControl = /* @__PURE__ */ new Map();
	exitPromise;
	resolveExit;
	constructor(callbacks, workerPath = defaultWorkerPath()) {
		this.callbacks = callbacks;
		this.workerPath = workerPath;
	}
	/** Start or replace the child with a complete initialization snapshot. */
	start(frame, refreshInit) {
		this.initFrame = frame;
		this.refreshInit = refreshInit;
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
		if (this.restarting && this.refreshInit !== void 0) try {
			this.initFrame = this.refreshInit();
		} catch (error) {
			this.failed(`usage ledger worker restart snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.restarting = false;
		const sourceReader = this.initFrame.readerSpec?.workerModule.endsWith(".ts") === true ? ["--import", "tsx/esm"] : [];
		const nodeArgs = [
			"--no-warnings",
			`--max-old-space-size=${String(this.initFrame.config.workerMaxHeapMiB ?? 512)}`,
			...sourceReader,
			this.workerPath
		];
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
			if (frame.type === "error" && frame.fatal === true) {
				this.stopping = true;
				child.stdin.end();
			}
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
			this.restarting = true;
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
//#region lib/types/host/spec.js
/** Durable record types and validation schemas for the private SQLite ledger. */
const nonNegativeInteger = z$1.number().int().nonnegative();
const tokenUsageSchema = z$1.object({
	inputTokens: nonNegativeInteger,
	outputTokens: nonNegativeInteger,
	cacheReadTokens: nonNegativeInteger,
	cacheWriteTokens: nonNegativeInteger
});
const attemptIdSchema = z$1.string().transform(createUsageAttemptId);
/** Zod schema for the lifecycle cursor and active-attempt lookup table. */
const usageLedgerSessionRowSchema = z$1.object({
	createdAt: nonNegativeInteger,
	workspace: z$1.string().optional(),
	observedSeq: z$1.number().int().min(-1),
	activeAttempts: z$1.record(z$1.string(), attemptIdSchema),
	route: z$1.object({
		provider: z$1.string(),
		model: z$1.string()
	}).optional()
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
//#endregion
//#region lib/types/host/index.js
/** Host-side Usage Ledger coordinator with an adaptive isolated history worker. */
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
const DEFAULT_MAX_ACTIVE_ATTEMPTS = 256;
const DEFAULT_EVENT_LIMIT = 256;
const DEFAULT_SCAN_BATCH_ROWS = 256;
const DEFAULT_SAMPLE_INTERVAL_MS = 2e3;
const DEFAULT_MIN_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 6e4;
const DEFAULT_RECOVERY_SAMPLES = 5;
const DEFAULT_BUSY_ELU = .35;
const DEFAULT_PAUSE_ELU = .7;
const DEFAULT_BUSY_DELAY_MS = 40;
const DEFAULT_PAUSE_DELAY_MS = 150;
const DEFAULT_PAUSE_RSS_MIB = 1024;
const DEFAULT_PAUSE_AVAILABLE_MIB = 0;
const POWER_PROBE_INTERVAL_MS = 3e4;
/** Settings namespace used to expose the read-only Usage card in Plugins settings. */
const USAGE_LEDGER_SETTINGS_NAMESPACE = "usage-ledger";
const UsageLedgerSettingsSchema = z.object({});
const BackfillModeSchema = z.union([z.const("process"), z.const("off")]);
const BackfillScopeSchema = z.union([z.const("all"), z.const("recent")]);
const PowerModeSchema = z.union([z.const("ac-only"), z.const("always")]);
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
	const databasePath = config.databasePath;
	if (typeof databasePath !== "string" || databasePath.length === 0) throw new TypeError("usage ledger databasePath must be configured by the profile patch");
	const backfillMode = config.backfillMode ?? "process";
	const backfillScope = config.backfillScope ?? "all";
	const backfillDays = config.backfillDays ?? DEFAULT_DAYS;
	const workerMaxHeapMiB = config.workerMaxHeapMiB ?? DEFAULT_HEAP_MIB;
	const workerMaxActiveAttempts = config.workerMaxActiveAttempts ?? DEFAULT_MAX_ACTIVE_ATTEMPTS;
	const workerBatchEvents = config.workerBatchEvents ?? DEFAULT_BATCH_EVENTS;
	const workerSliceMs = config.workerSliceMs ?? DEFAULT_SLICE_MS;
	const snapshotEventLimit = config.snapshotEventLimit ?? DEFAULT_EVENT_LIMIT;
	const snapshotScanBatchRows = config.snapshotScanBatchRows ?? DEFAULT_SCAN_BATCH_ROWS;
	const adaptive = {
		powerMode: config.backfillPowerMode ?? "ac-only",
		sampleIntervalMs: config.loadSampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
		minDelayMs: config.backfillMinDelayMs ?? DEFAULT_MIN_DELAY_MS,
		maxDelayMs: config.backfillMaxDelayMs ?? DEFAULT_MAX_DELAY_MS,
		recoverySamples: config.backfillRecoverySamples ?? DEFAULT_RECOVERY_SAMPLES,
		busyEventLoopUtilization: config.backfillBusyEventLoopUtilization ?? DEFAULT_BUSY_ELU,
		pauseEventLoopUtilization: config.backfillPauseEventLoopUtilization ?? DEFAULT_PAUSE_ELU,
		busyEventLoopDelayMs: config.backfillBusyEventLoopDelayMs ?? DEFAULT_BUSY_DELAY_MS,
		pauseEventLoopDelayMs: config.backfillPauseEventLoopDelayMs ?? DEFAULT_PAUSE_DELAY_MS,
		pauseRssMiB: config.backfillPauseRssMiB ?? DEFAULT_PAUSE_RSS_MIB,
		pauseAvailableMemoryMiB: config.backfillPauseAvailableMemoryMiB ?? DEFAULT_PAUSE_AVAILABLE_MIB
	};
	if (backfillMode !== "process" && backfillMode !== "off") throw new RangeError("usage ledger backfillMode is invalid: " + String(backfillMode));
	if (backfillScope !== "all" && backfillScope !== "recent") throw new RangeError("usage ledger backfillScope is invalid: " + String(backfillScope));
	if (adaptive.powerMode !== "ac-only" && adaptive.powerMode !== "always") throw new RangeError("usage ledger backfillPowerMode is invalid: " + String(adaptive.powerMode));
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
			"workerMaxActiveAttempts",
			workerMaxActiveAttempts,
			1,
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
		],
		[
			"snapshotEventLimit",
			snapshotEventLimit,
			1,
			4096
		],
		[
			"snapshotScanBatchRows",
			snapshotScanBatchRows,
			1,
			4096
		],
		[
			"loadSampleIntervalMs",
			adaptive.sampleIntervalMs,
			100,
			6e4
		],
		[
			"backfillMinDelayMs",
			adaptive.minDelayMs,
			0,
			6e4
		],
		[
			"backfillMaxDelayMs",
			adaptive.maxDelayMs,
			1,
			6e4
		],
		[
			"backfillRecoverySamples",
			adaptive.recoverySamples,
			1,
			1e3
		],
		[
			"backfillBusyEventLoopDelayMs",
			adaptive.busyEventLoopDelayMs,
			1,
			6e4
		],
		[
			"backfillPauseEventLoopDelayMs",
			adaptive.pauseEventLoopDelayMs,
			1,
			6e4
		],
		[
			"backfillPauseRssMiB",
			adaptive.pauseRssMiB,
			64,
			1048576
		],
		[
			"backfillPauseAvailableMemoryMiB",
			adaptive.pauseAvailableMemoryMiB,
			0,
			1048576
		]
	]) if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError("usage ledger " + name + " must be a safe integer from " + String(min) + " through " + String(max));
	for (const [name, value] of [["backfillBusyEventLoopUtilization", adaptive.busyEventLoopUtilization], ["backfillPauseEventLoopUtilization", adaptive.pauseEventLoopUtilization]]) if (!Number.isFinite(value) || value <= 0 || value > 1) throw new RangeError("usage ledger " + name + " must be a number greater than 0 through 1");
	if (adaptive.minDelayMs > adaptive.maxDelayMs) throw new RangeError("usage ledger backfillMinDelayMs must not exceed backfillMaxDelayMs");
	if (adaptive.busyEventLoopUtilization > adaptive.pauseEventLoopUtilization) throw new RangeError("usage ledger busy utilization must not exceed pause utilization");
	if (adaptive.busyEventLoopDelayMs > adaptive.pauseEventLoopDelayMs) throw new RangeError("usage ledger busy event-loop delay must not exceed pause delay");
	return {
		databasePath,
		backfillMode,
		backfillScope,
		backfillDays,
		workerMaxHeapMiB,
		workerMaxActiveAttempts,
		workerBatchEvents,
		workerSliceMs,
		snapshotEventLimit,
		snapshotScanBatchRows,
		adaptive
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
	if (year === void 0 || month === void 0 || day === void 0) throw new Error("usage ledger could not format date in timezone " + timeZone);
	return year + "-" + month + "-" + day;
}
function utcDay(time) {
	return new Date(time).toISOString().slice(0, 10);
}
function shiftDay(day, offset) {
	const instant = /* @__PURE__ */ new Date(day + "T00:00:00.000Z");
	instant.setUTCDate(instant.getUTCDate() + offset);
	return utcDay(instant.getTime());
}
function dayCount(fromDay, throughDay) {
	return Math.round((Date.parse(throughDay + "T00:00:00.000Z") - Date.parse(fromDay + "T00:00:00.000Z")) / 864e5) + 1;
}
function zoneOffset(time, timeZone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23"
	}).formatToParts(new Date(time));
	const number = (kind) => {
		const value = parts.find((part) => part.type === kind)?.value;
		if (value === void 0) throw new Error("usage ledger could not resolve time zone part " + kind);
		return Number(value);
	};
	return Date.UTC(number("year"), number("month") - 1, number("day"), number("hour"), number("minute"), number("second")) - time;
}
/** Resolve a local calendar midnight to an epoch, including normal DST offset changes. */
function zoneDayStart(day, timeZone) {
	const [year, month, date] = day.split("-").map(Number);
	if (year === void 0 || month === void 0 || date === void 0) throw new Error("usage ledger received invalid day " + day);
	const base = Date.UTC(year, month - 1, date);
	let candidate = base - zoneOffset(base, timeZone);
	candidate = base - zoneOffset(candidate, timeZone);
	return candidate;
}
function resolveSnapshotRequest(request) {
	const workspace = request?.workspace ?? null;
	const provider = request?.provider ?? null;
	const model = request?.model ?? null;
	const all = request?.all ?? false;
	const days = request?.days ?? DEFAULT_DAYS;
	const timeZone = request?.timeZone ?? "UTC";
	for (const [name, value] of [
		["workspace", workspace],
		["provider", provider],
		["model", model]
	]) if (value !== null && typeof value !== "string") throw new TypeError("usage ledger " + name + " must be a string or null");
	if (typeof timeZone !== "string" || timeZone.length === 0) throw new TypeError("usage ledger timeZone must be a non-empty IANA timezone");
	if (typeof all !== "boolean") throw new TypeError("usage ledger all must be a boolean");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format();
	} catch {
		throw new RangeError("usage ledger timeZone is invalid: " + timeZone);
	}
	if (!all && (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS)) throw new RangeError("usage ledger days must be a safe integer from 1 through " + String(MAX_DAYS));
	return {
		workspace,
		provider,
		model,
		all,
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
async function listFallbackSessions(persistence, scope, days) {
	const listed = await persistence.list();
	if (!Array.isArray(listed)) throw new TypeError("usage ledger received an invalid session listing");
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1e3;
	const result = [];
	for (const value of listed) {
		const header = validateHeader(isRecord(value) && isRecord(value.header) ? value.header : value);
		if (scope === "all" || header.createdAt >= cutoff) result.push({ header });
	}
	return result;
}
function validateReaderSpec(value) {
	if (value === void 0) return void 0;
	if (!isRecord(value) || typeof value.protocolVersion !== "number" || typeof value.workerModule !== "string" || value.workerModule.length === 0) throw new TypeError("usage ledger received an invalid background reader spec");
	if (value.options !== void 0 && (!isRecord(value.options) || Object.values(value.options).some((option) => typeof option !== "string" && typeof option !== "number" && typeof option !== "boolean"))) throw new TypeError("usage ledger background reader options must be JSON-safe primitives");
	if (value.supportsSessionListing !== void 0 && typeof value.supportsSessionListing !== "boolean") throw new TypeError("usage ledger background reader supportsSessionListing must be boolean");
	return value;
}
/** Copy only usage-bearing event fields across the process boundary. */
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
function csvCell(value) {
	return "\"" + (value === void 0 ? "" : String(value)).replaceAll("\"", "\"\"") + "\"";
}
async function writeCsv(stream, row) {
	if (stream.write(row.map(csvCell).join(",") + "\n")) return;
	await once(stream, "drain");
}
async function powerSource() {
	if (process.platform !== "darwin") return "unknown";
	return new Promise((resolve) => {
		execFile("/usr/bin/pmset", ["-g", "batt"], {
			encoding: "utf8",
			timeout: 1e3
		}, (error, stdout) => {
			if (error !== null) {
				resolve("unknown");
				return;
			}
			if (stdout.includes("Now drawing from 'AC Power'")) {
				resolve("ac");
				return;
			}
			if (stdout.includes("Now drawing from 'Battery Power'")) {
				resolve("battery");
				return;
			}
			resolve("unknown");
		});
	});
}
/** Host service that keeps all heavyweight ledger work outside the task process. */
let UsageLedgerService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _snapshot_decorators;
	let _exportCsv_decorators;
	let _statusSnapshot_decorators;
	return class UsageLedgerService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_snapshot_decorators = [Remote("snapshot")];
			_exportCsv_decorators = [Remote("exportCsv")];
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
			__esDecorate(this, null, _exportCsv_decorators, {
				kind: "method",
				name: "exportCsv",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportCsv" in obj,
					get: (obj) => obj.exportCsv
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
		static inject = ["sessions", "sessionPersistence"];
		static Config = z.object({
			databasePath: z.string().required(),
			backfillMode: BackfillModeSchema.default("process"),
			backfillScope: BackfillScopeSchema.default("all"),
			backfillDays: z.number().step(1).min(1).max(MAX_DAYS).default(DEFAULT_DAYS),
			workerMaxHeapMiB: z.number().step(1).min(128).max(4096).default(DEFAULT_HEAP_MIB),
			workerMaxActiveAttempts: z.number().step(1).min(1).max(4096).default(DEFAULT_MAX_ACTIVE_ATTEMPTS),
			workerBatchEvents: z.number().step(1).min(1).max(4096).default(DEFAULT_BATCH_EVENTS),
			workerSliceMs: z.number().step(1).min(1).max(1e3).default(DEFAULT_SLICE_MS),
			backfillPowerMode: PowerModeSchema.default("ac-only"),
			loadSampleIntervalMs: z.number().step(1).min(100).max(6e4).default(DEFAULT_SAMPLE_INTERVAL_MS),
			backfillMinDelayMs: z.number().step(1).min(0).max(6e4).default(DEFAULT_MIN_DELAY_MS),
			backfillMaxDelayMs: z.number().step(1).min(1).max(6e4).default(DEFAULT_MAX_DELAY_MS),
			backfillRecoverySamples: z.number().step(1).min(1).max(1e3).default(DEFAULT_RECOVERY_SAMPLES),
			backfillBusyEventLoopUtilization: z.number().min(.001).max(1).default(DEFAULT_BUSY_ELU),
			backfillPauseEventLoopUtilization: z.number().min(.001).max(1).default(DEFAULT_PAUSE_ELU),
			backfillBusyEventLoopDelayMs: z.number().step(1).min(1).max(6e4).default(DEFAULT_BUSY_DELAY_MS),
			backfillPauseEventLoopDelayMs: z.number().step(1).min(1).max(6e4).default(DEFAULT_PAUSE_DELAY_MS),
			backfillPauseRssMiB: z.number().step(1).min(64).max(1048576).default(DEFAULT_PAUSE_RSS_MIB),
			backfillPauseAvailableMemoryMiB: z.number().step(1).min(0).max(1048576).default(DEFAULT_PAUSE_AVAILABLE_MIB),
			snapshotEventLimit: z.number().step(1).min(1).max(4096).default(DEFAULT_EVENT_LIMIT),
			snapshotScanBatchRows: z.number().step(1).min(1).max(4096).default(DEFAULT_SCAN_BATCH_ROWS)
		});
		resolvedConfig = __runInitializers(this, _instanceExtraInitializers);
		worker;
		loopDelay = monitorEventLoopDelay({ resolution: 20 });
		governor;
		lastUtilization = performance.eventLoopUtilization();
		hasLoadSample = false;
		database;
		sampleTimer;
		powerSource = "unknown";
		lastPowerProbe = 0;
		powerProbe;
		pace;
		status;
		constructor(ctx, config = {}) {
			super(ctx, "usageLedger", { namespace: "usageLedgerPlugin" });
			this.resolvedConfig = resolveConfig(config);
			this.governor = new UsageLedgerGovernor(this.resolvedConfig.adaptive);
			this.status = {
				state: this.resolvedConfig.backfillMode === "off" ? "paused" : "idle",
				totalSessions: 0,
				processedSessions: 0,
				processedEvents: 0,
				backfillDays: this.resolvedConfig.backfillDays,
				backfillScope: this.resolvedConfig.backfillScope,
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
		/** Open only a bounded SQLite connection; no call rows enter the Host heap. */
		async [Service.init]() {
			this.database = await openUsageLedgerDatabase(this.resolvedConfig.databasePath);
			this.ctx.effect(() => async () => {
				this.stopGovernor();
				await this.worker.stop();
				this.database?.close();
				this.database = void 0;
			}, "usage-ledger.database-close");
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
			this.startGovernor();
			this.startWorker(this.ctx.sessionPersistence);
		}
		/** Start independently of task initialization and keep fallback listing out of capable providers. */
		async startWorker(persistence) {
			let readerSpec;
			try {
				const runtime = persistence;
				readerSpec = validateReaderSpec(typeof runtime.backgroundReaderSpec === "function" ? runtime.backgroundReaderSpec() : void 0);
			} catch (error) {
				this.recordFailure("provider-owned reader unavailable: " + (error instanceof Error ? error.message : String(error)));
			}
			let fallback = [];
			if (readerSpec !== void 0 && readerSpec.supportsSessionListing !== true) try {
				fallback = await listFallbackSessions(persistence, this.resolvedConfig.backfillScope, this.resolvedConfig.backfillDays);
			} catch (error) {
				this.recordFailure("historical session listing failed: " + (error instanceof Error ? error.message : String(error)));
			}
			try {
				const makeInitFrame = () => ({
					type: "init",
					protocolVersion: 1,
					config: {
						databasePath: this.resolvedConfig.databasePath,
						backfillScope: this.resolvedConfig.backfillScope,
						backfillDays: this.resolvedConfig.backfillDays,
						workerBatchEvents: this.resolvedConfig.workerBatchEvents,
						workerSliceMs: this.resolvedConfig.workerSliceMs,
						workerMaxHeapMiB: this.resolvedConfig.workerMaxHeapMiB,
						workerMaxActiveAttempts: this.resolvedConfig.workerMaxActiveAttempts
					},
					...readerSpec === void 0 ? {} : { readerSpec },
					sessions: fallback.map(({ header }) => ({
						id: header.id,
						createdAt: header.createdAt,
						...header.cwd === void 0 ? {} : { cwd: header.cwd },
						inheritedEventCount: 0
					})),
					liveSessionIds: this.ctx.sessions.list().map((session) => session.id)
				});
				this.status = {
					...this.status,
					state: readerSpec === void 0 ? "paused" : "running",
					totalSessions: fallback.length,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
					...readerSpec === void 0 ? { lastError: "session persistence does not expose backgroundReaderSpec; historical backfill is paused" } : {}
				};
				if (readerSpec === void 0) this.ctx.logger.warn("usage ledger: persistence has no provider-owned background reader; live ledger remains enabled");
				this.worker.start(makeInitFrame(), makeInitFrame);
			} catch (error) {
				this.recordFailure("background worker initialization failed: " + (error instanceof Error ? error.message : String(error)));
			}
		}
		/** Return complete aggregates and a bounded event page without materializing the SQLite ledger. */
		async snapshot(request) {
			const resolved = resolveSnapshotRequest(request);
			const { fromDay, days, start, end } = this.resolveRange(resolved);
			const models = /* @__PURE__ */ new Map();
			const daily = /* @__PURE__ */ new Map();
			const selected = [];
			let eventsTruncated = false;
			for (let offset = 0; offset < days; offset += 1) {
				const day = shiftDay(fromDay, offset);
				daily.set(day, {
					day,
					...ZERO_TOTALS
				});
			}
			let after;
			do {
				const page = this.requireDatabase().callsPage({
					startedAtInclusive: start,
					startedAtExclusive: end,
					workspace: resolved.workspace,
					provider: resolved.provider,
					model: resolved.model,
					...after === void 0 ? {} : { after },
					limit: this.resolvedConfig.snapshotScanBatchRows
				});
				for (const { row } of page.rows) {
					const localDay = zoneDay(row.startedAt, resolved.timeZone);
					if (localDay < fromDay || localDay > resolved.throughDay) continue;
					if (selected.length < this.resolvedConfig.snapshotEventLimit) selected.push(row);
					else eventsTruncated = true;
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
				after = page.next;
				if (after !== void 0) await new Promise((resolve) => setImmediate(resolve));
			} while (after !== void 0);
			return Object.freeze({
				workspace: resolved.workspace,
				days,
				all: resolved.all,
				fromDay,
				throughDay: resolved.throughDay,
				timeZone: resolved.timeZone,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				events: Object.freeze(projectEvents(selected).map((row) => Object.freeze(row))),
				eventsTruncated,
				models: Object.freeze([...models.values()].sort(compareModels).map((row) => Object.freeze(row))),
				daily: Object.freeze([...daily.values()].map((row) => Object.freeze(row)))
			});
		}
		/** Write all matching call rows in bounded SQLite pages to an owner-only CSV. */
		async exportCsv(request) {
			const resolved = resolveSnapshotRequest(request);
			const range = this.resolveRange(resolved);
			const outputDirectory = join(dirname(resolve(this.resolvedConfig.databasePath)), "usage-ledger-exports");
			await mkdir(outputDirectory, {
				recursive: true,
				mode: 448
			});
			const path = join(outputDirectory, "usage-ledger-" + (/* @__PURE__ */ new Date()).toISOString().replaceAll(/[:.]/g, "-") + "-" + randomUUID() + ".csv");
			const stream = createWriteStream(path, {
				flags: "wx",
				mode: 384
			});
			let rows = 0;
			try {
				await writeCsv(stream, [
					"sessionId",
					"createdAt",
					"workspace",
					"attemptId",
					"turn",
					"step",
					"provider",
					"model",
					"startedAt",
					"outcome",
					"retryScheduled",
					"inputTokens",
					"outputTokens",
					"cacheReadTokens",
					"cacheWriteTokens"
				]);
				let after;
				do {
					const page = this.requireDatabase().callsPage({
						startedAtInclusive: range.start,
						startedAtExclusive: range.end,
						workspace: resolved.workspace,
						provider: resolved.provider,
						model: resolved.model,
						...after === void 0 ? {} : { after },
						limit: this.resolvedConfig.snapshotScanBatchRows
					});
					for (const { row } of page.rows) {
						const localDay = zoneDay(row.startedAt, resolved.timeZone);
						if (localDay < range.fromDay || localDay > resolved.throughDay) continue;
						const usage = row.finalUsage ?? row.provisionalUsage;
						await writeCsv(stream, [
							row.sessionId,
							row.createdAt,
							row.workspace,
							row.attemptId,
							row.turn,
							row.step,
							row.provider,
							row.model,
							row.startedAt,
							row.outcome,
							row.retryScheduled === true,
							usage?.inputTokens,
							usage?.outputTokens,
							usage?.cacheReadTokens,
							usage?.cacheWriteTokens
						]);
						rows += 1;
					}
					after = page.next;
					if (after !== void 0) await new Promise((resolve) => setImmediate(resolve));
				} while (after !== void 0);
				stream.end();
				await once(stream, "close");
			} catch (error) {
				stream.destroy();
				throw error;
			}
			return {
				path,
				rows,
				fromDay: range.fromDay,
				throughDay: resolved.throughDay
			};
		}
		/** Non-blocking worker and workload state for the Usage page. */
		statusSnapshot() {
			return Object.freeze({
				...this.status,
				...this.pace === void 0 ? {} : { pace: this.pace }
			});
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
				case "checkpoint":
				case "done": return;
				case "error":
					this.recordFailure(frame.sessionId === void 0 ? frame.message : "session " + frame.sessionId + ": " + frame.message);
					return;
			}
		}
		startGovernor() {
			this.loopDelay.enable();
			this.sampleLoad();
			this.sampleTimer = setInterval(() => {
				this.sampleLoad();
			}, this.resolvedConfig.adaptive.sampleIntervalMs);
			this.sampleTimer.unref?.();
		}
		stopGovernor() {
			if (this.sampleTimer !== void 0) clearInterval(this.sampleTimer);
			this.sampleTimer = void 0;
			this.loopDelay.disable();
		}
		async sampleLoad() {
			const now = Date.now();
			if (now - this.lastPowerProbe >= POWER_PROBE_INTERVAL_MS && this.powerProbe === void 0) {
				this.lastPowerProbe = now;
				this.powerProbe = powerSource().then((source) => {
					this.powerSource = source;
				}).catch(() => {
					this.powerSource = "unknown";
				}).finally(() => {
					this.powerProbe = void 0;
				});
				await this.powerProbe;
			}
			const utilization = performance.eventLoopUtilization(this.lastUtilization);
			this.lastUtilization = performance.eventLoopUtilization();
			const delayMs = this.loopDelay.percentile(99) / 1e6;
			this.loopDelay.reset();
			const rssMiB = process.memoryUsage().rss / (1024 * 1024);
			const available = typeof process.availableMemory === "function" ? process.availableMemory() / (1024 * 1024) : void 0;
			const firstSample = !this.hasLoadSample;
			this.hasLoadSample = true;
			const next = this.governor.observe({
				powerSource: this.powerSource,
				eventLoopUtilization: firstSample ? 0 : utilization.utilization,
				eventLoopDelayMs: firstSample || !Number.isFinite(delayMs) ? 0 : delayMs,
				rssMiB,
				availableMemoryMiB: available
			});
			if (this.pace?.mode === next.mode && this.pace.delayMs === next.delayMs && this.pace.reason === next.reason) return;
			this.pace = next;
			this.worker.sendControl({
				type: "pace",
				mode: next.mode,
				delayMs: next.delayMs,
				...next.reason === void 0 ? {} : { reason: next.reason }
			}, "pace");
			if (next.mode === "pause" && this.status.state !== "failed") this.status = {
				...this.status,
				state: "paused",
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
		}
		recordFailure(message) {
			this.status = {
				...this.status,
				state: "failed",
				lastError: message,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			this.ctx.logger.warn("usage ledger: " + message);
		}
		resolveRange(resolved) {
			const earliest = resolved.all ? this.requireDatabase().firstCallTime(resolved.workspace, resolved.provider, resolved.model) : void 0;
			const fromDay = earliest === void 0 ? resolved.all ? resolved.throughDay : shiftDay(resolved.throughDay, 1 - resolved.days) : zoneDay(earliest, resolved.timeZone);
			return {
				fromDay,
				days: resolved.all ? dayCount(fromDay, resolved.throughDay) : resolved.days,
				start: zoneDayStart(fromDay, resolved.timeZone),
				end: zoneDayStart(shiftDay(resolved.throughDay, 1), resolved.timeZone)
			};
		}
		requireDatabase() {
			if (this.database === void 0) throw new Error("usage ledger is not initialized");
			return this.database;
		}
	};
})();
//#endregion
export { USAGE_LEDGER_SETTINGS_NAMESPACE, UsageLedgerService, UsageLedgerService as default, usageLedgerCallRowSchema, usageLedgerSessionRowSchema };
