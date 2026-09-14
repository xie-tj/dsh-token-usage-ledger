import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
//#region lib/types/host/event-types.js
/** Compatibility event vocabulary for session versions with provider-attempt records. */
/**
* Attach the provider-attempt brand to an identifier derived by this plugin.
* @param value - Stable identifier from an official session event.
* @returns The same identifier with its compile-time domain brand.
*/
function createUsageAttemptId(value) {
	return value;
}
/** SQLite application id used to reject unrelated user files. */
const USAGE_LEDGER_SQLITE_APPLICATION_ID = 1146309684;
const CALL_COLUMNS = `
  key, session_id, created_at, workspace, attempt_id, turn, step, provider, model,
  started_at, outcome, retry_scheduled,
  provisional_input_tokens, provisional_output_tokens, provisional_cache_read_tokens, provisional_cache_write_tokens,
  final_input_tokens, final_output_tokens, final_cache_read_tokens, final_cache_write_tokens
`;
/**
* Create a missing private database file with owner-only permissions.
* Existing files retain their permissions.
*/
async function createDatabaseFile(path) {
	try {
		await (await open(path, "wx", 384)).close();
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
}
/** Open and validate the private SQLite file without touching legacy ledger files. */
async function openUsageLedgerDatabase(path) {
	const actual = path === ":memory:" ? path : resolve(path);
	if (actual !== ":memory:") {
		await mkdir(dirname(actual), {
			recursive: true,
			mode: 448
		});
		await createDatabaseFile(actual);
	}
	const db = new DatabaseSync(actual);
	try {
		configureDatabase(db, actual);
		return new UsageLedgerDatabase(db);
	} catch (error) {
		db.close();
		throw error;
	}
}
function configureDatabase(db, path) {
	const applicationId = db.prepare("PRAGMA application_id").get();
	const version = db.prepare("PRAGMA user_version").get();
	const userTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
	if (applicationId.application_id !== 0 && applicationId.application_id !== 1146309684) throw new Error(`usage ledger database at "${path}" belongs to another application`);
	if (applicationId.application_id === 0 && userTables.length > 0) throw new Error(`usage ledger database at "${path}" is not empty`);
	if (applicationId.application_id === 1146309684 && version.user_version !== 4) throw new Error(`usage ledger database at "${path}" has schema ${String(version.user_version)}, expected ${String(4)}`);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA cache_size = -8192");
	db.exec("PRAGMA temp_store = FILE");
	db.exec("PRAGMA mmap_size = 0");
	db.exec(`PRAGMA application_id = ${String(USAGE_LEDGER_SQLITE_APPLICATION_ID)}`);
	db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id      TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      workspace       TEXT,
      observed_seq    INTEGER NOT NULL,
      active_attempts TEXT NOT NULL,
      route_provider  TEXT,
      route_model     TEXT,
      PRIMARY KEY (session_id, created_at)
    ) STRICT
  `);
	db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      key                            TEXT PRIMARY KEY,
      session_id                     TEXT NOT NULL,
      created_at                     INTEGER NOT NULL,
      workspace                      TEXT,
      attempt_id                     TEXT NOT NULL,
      turn                           INTEGER NOT NULL,
      step                           INTEGER NOT NULL,
      provider                       TEXT NOT NULL,
      model                          TEXT NOT NULL,
      started_at                     INTEGER NOT NULL,
      outcome                        TEXT CHECK (outcome IN ('success', 'failure', 'aborted')),
      retry_scheduled                INTEGER NOT NULL CHECK (retry_scheduled IN (0, 1)),
      provisional_input_tokens       INTEGER,
      provisional_output_tokens      INTEGER,
      provisional_cache_read_tokens  INTEGER,
      provisional_cache_write_tokens INTEGER,
      final_input_tokens             INTEGER,
      final_output_tokens            INTEGER,
      final_cache_read_tokens        INTEGER,
      final_cache_write_tokens       INTEGER
    ) STRICT
  `);
	db.exec("CREATE INDEX IF NOT EXISTS calls_started_at ON calls (started_at, key)");
	db.exec("CREATE INDEX IF NOT EXISTS calls_session ON calls (session_id, created_at, attempt_id)");
	db.exec(`PRAGMA user_version = ${String(4)}`);
}
function decodeUsage(input, output, cacheRead, cacheWrite) {
	if (input === null || output === null || cacheRead === null || cacheWrite === null) return void 0;
	return {
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite
	};
}
function callFromSql(row) {
	return {
		sessionId: row.session_id,
		createdAt: row.created_at,
		...row.workspace === null ? {} : { workspace: row.workspace },
		day: new Date(row.started_at).toISOString().slice(0, 10),
		attemptId: createUsageAttemptId(row.attempt_id),
		turn: row.turn,
		step: row.step,
		provider: row.provider,
		model: row.model,
		startedAt: row.started_at,
		...row.outcome === null ? {} : { outcome: row.outcome },
		...row.retry_scheduled === 0 ? {} : { retryScheduled: true },
		...decodeUsage(row.provisional_input_tokens, row.provisional_output_tokens, row.provisional_cache_read_tokens, row.provisional_cache_write_tokens) === void 0 ? {} : { provisionalUsage: decodeUsage(row.provisional_input_tokens, row.provisional_output_tokens, row.provisional_cache_read_tokens, row.provisional_cache_write_tokens) },
		...decodeUsage(row.final_input_tokens, row.final_output_tokens, row.final_cache_read_tokens, row.final_cache_write_tokens) === void 0 ? {} : { finalUsage: decodeUsage(row.final_input_tokens, row.final_output_tokens, row.final_cache_read_tokens, row.final_cache_write_tokens) }
	};
}
function sessionFromSql(row) {
	const active = JSON.parse(row.active_attempts);
	return {
		createdAt: row.created_at,
		...row.workspace === null ? {} : { workspace: row.workspace },
		observedSeq: row.observed_seq,
		activeAttempts: Object.fromEntries(Object.entries(active).map(([key, value]) => [key, createUsageAttemptId(value)])),
		...row.route_provider === null || row.route_model === null ? {} : { route: {
			provider: row.route_provider,
			model: row.route_model
		} }
	};
}
function usageBindings(usage) {
	return usage === void 0 ? [
		null,
		null,
		null,
		null
	] : [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheWriteTokens
	];
}
/** Dedicated, bounded access to the private ledger database. */
var UsageLedgerDatabase = class {
	db;
	putCall;
	putSession;
	constructor(db) {
		this.db = db;
		this.putCall = db.prepare(`
    INSERT INTO calls (${CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      session_id = excluded.session_id,
      created_at = excluded.created_at,
      workspace = excluded.workspace,
      attempt_id = excluded.attempt_id,
      turn = excluded.turn,
      step = excluded.step,
      provider = excluded.provider,
      model = excluded.model,
      started_at = excluded.started_at,
      outcome = excluded.outcome,
      retry_scheduled = excluded.retry_scheduled,
      provisional_input_tokens = excluded.provisional_input_tokens,
      provisional_output_tokens = excluded.provisional_output_tokens,
      provisional_cache_read_tokens = excluded.provisional_cache_read_tokens,
      provisional_cache_write_tokens = excluded.provisional_cache_write_tokens,
      final_input_tokens = excluded.final_input_tokens,
      final_output_tokens = excluded.final_output_tokens,
      final_cache_read_tokens = excluded.final_cache_read_tokens,
      final_cache_write_tokens = excluded.final_cache_write_tokens
  `);
		this.putSession = db.prepare(`
    INSERT INTO sessions (session_id, created_at, workspace, observed_seq, active_attempts, route_provider, route_model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, created_at) DO UPDATE SET
      workspace = excluded.workspace,
      observed_seq = excluded.observed_seq,
      active_attempts = excluded.active_attempts,
      route_provider = excluded.route_provider,
      route_model = excluded.route_model
  `);
	}
	/** Apply a bounded mutation batch as one durable SQLite transaction. */
	applyMutations(mutations) {
		if (mutations.length === 0) return;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const mutation of mutations) if (mutation.type === "call-upsert") {
				const row = mutation.row;
				this.putCall.run(mutation.key, row.sessionId, row.createdAt, row.workspace ?? null, row.attemptId, row.turn, row.step, row.provider, row.model, row.startedAt, row.outcome ?? null, row.retryScheduled === true ? 1 : 0, ...usageBindings(row.provisionalUsage), ...usageBindings(row.finalUsage));
			} else if (mutation.type === "cursor-upsert") {
				const row = mutation.row;
				this.putSession.run(mutation.sessionId, row.createdAt, row.workspace ?? null, row.observedSeq, JSON.stringify(row.activeAttempts), row.route?.provider ?? null, row.route?.model ?? null);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}
	/** Load only one session's cursor and currently active call rows. */
	sessionSeed(sessionId, createdAt, maxActiveAttempts) {
		const stored = this.db.prepare(`
      SELECT session_id, created_at, workspace, observed_seq, active_attempts, route_provider, route_model
      FROM sessions WHERE session_id = ? AND created_at = ?
    `).get(sessionId, createdAt);
		const cursor = stored === void 0 ? void 0 : sessionFromSql(stored);
		const attemptIds = cursor === void 0 ? [] : [...new Set(Object.values(cursor.activeAttempts))];
		if (attemptIds.length > maxActiveAttempts) throw new Error("usage ledger session active attempt count exceeds workerMaxActiveAttempts");
		const calls = [];
		for (const attemptId of attemptIds) {
			const row = this.db.prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE session_id = ? AND created_at = ? AND attempt_id = ?`).get(sessionId, createdAt, attemptId);
			if (row !== void 0) calls.push({
				key: row.key,
				row: callFromSql(row)
			});
		}
		return {
			cursor,
			calls
		};
	}
	/** Read one bounded chronological page without materializing the ledger. */
	callsPage(request) {
		const clauses = ["started_at >= ?", "started_at < ?"];
		const values = [request.startedAtInclusive, request.startedAtExclusive];
		if (request.workspace !== null) {
			clauses.push("workspace = ?");
			values.push(request.workspace);
		}
		if (request.provider !== null) {
			clauses.push("provider = ?");
			values.push(request.provider);
		}
		if (request.model !== null) {
			clauses.push("model = ?");
			values.push(request.model);
		}
		if (request.after !== void 0) {
			clauses.push("(started_at > ? OR (started_at = ? AND key > ?))");
			values.push(request.after.startedAt, request.after.startedAt, request.after.key);
		}
		values.push(request.limit);
		const sql = `SELECT ${CALL_COLUMNS} FROM calls WHERE ${clauses.join(" AND ")} ORDER BY started_at, key LIMIT ?`;
		const rows = this.db.prepare(sql).all(...values).map((row) => ({
			key: row.key,
			row: callFromSql(row)
		}));
		const tail = rows.at(-1);
		return {
			rows,
			next: rows.length < request.limit || tail === void 0 ? void 0 : {
				startedAt: tail.row.startedAt,
				key: tail.key
			}
		};
	}
	/** Return the earliest matching attempt timestamp without loading call rows. */
	firstCallTime(workspace, provider, model) {
		const clauses = [];
		const values = [];
		if (workspace !== null) {
			clauses.push("workspace = ?");
			values.push(workspace);
		}
		if (provider !== null) {
			clauses.push("provider = ?");
			values.push(provider);
		}
		if (model !== null) {
			clauses.push("model = ?");
			values.push(model);
		}
		const where = clauses.length === 0 ? "" : " WHERE " + clauses.join(" AND ");
		const row = this.db.prepare("SELECT MIN(started_at) AS started_at FROM calls" + where).get(...values);
		return row.started_at === null ? void 0 : row.started_at;
	}
	/** Close this connection after the owning service or worker reaches quiescence. */
	close() {
		this.db.close();
	}
};
//#endregion
//#region lib/types/host/worker-protocol.js
/** Serialize a single protocol frame with exactly one newline. */
function encodeWorkerFrame(frame) {
	return `${JSON.stringify(frame)}\n`;
}
/** Parse and minimally validate an incoming NDJSON frame. */
function decodeWorkerFrame(line) {
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null || typeof value.type !== "string") return;
	return value;
}
//#endregion
export { createUsageAttemptId as i, encodeWorkerFrame as n, openUsageLedgerDatabase as r, decodeWorkerFrame as t };
