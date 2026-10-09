import { a as workerSourceFingerprint, o as workerSourceIdentity, t as UsageLedgerUnreadableSourceError } from "./worker-protocol-DOeGXC-w.js";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
//#region lib/types/legacy-log.js
/** Streaming reader for stored generations the released provider refuses to migrate. */
/** Little-endian encoding of the Zstandard frame magic number. */
const ZSTD_FRAME_MAGIC = 4247762216;
/**
* Event types the ledger reducer reads.
* A refused generation is replayed row by row, so the reader keeps only these and never
* materializes the chunk rows that carry no accounting meaning.
*/
const REDUCED_EVENT_TYPES = /* @__PURE__ */ new Set([
	"assistant/attempt",
	"assistant/message",
	"llm/request-attempt",
	"llm/retry",
	"llm/retry-started",
	"request/context",
	"request/header",
	"step/start",
	"turn/end"
]);
/**
* Read the physical raw-log path a refusal reports.
* @param error - failure raised by the released provider while opening one stored generation.
* @returns an absolute stored-log path, or undefined when the refusal names no artifact.
*/
function storedLogPath(error) {
	if (typeof error !== "object" || error === null) return void 0;
	const location = error.location;
	if (typeof location === "string") return isAbsolute(location) ? location : void 0;
	if (typeof location !== "object" || location === null) return void 0;
	const path = location.path;
	return typeof path === "string" && isAbsolute(path) ? path : void 0;
}
/**
* Locate the end of one Zstandard frame without decompressing it.
* @param bytes - whole stored log.
* @param start - offset of the frame magic.
* @returns the offset just past the frame, or undefined when the frame is truncated or malformed.
* Node decompresses only the first frame of a concatenated stream, so frame boundaries are found by
* walking the frame header and block headers the format writes before each block.
*/
function zstdFrameEnd(bytes, start) {
	let offset = start;
	const has = (count) => offset + count <= bytes.length;
	if (!has(4)) return void 0;
	if ((bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0 !== ZSTD_FRAME_MAGIC) return void 0;
	offset += 4;
	if (!has(1)) return void 0;
	const descriptor = bytes[offset];
	offset += 1;
	const contentSizeFlag = descriptor >> 6;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryFlag = descriptor & 3;
	if (!singleSegment) {
		if (!has(1)) return void 0;
		offset += 1;
	}
	const dictionaryBytes = dictionaryFlag === 0 ? 0 : dictionaryFlag === 3 ? 4 : dictionaryFlag;
	if (!has(dictionaryBytes)) return void 0;
	offset += dictionaryBytes;
	const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
	if (!has(contentSizeBytes)) return void 0;
	offset += contentSizeBytes;
	for (;;) {
		if (!has(3)) return void 0;
		const header = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
		offset += 3;
		const lastBlock = (header & 1) !== 0;
		const blockType = header >> 1 & 3;
		if (blockType === 3) return void 0;
		const body = blockType === 1 ? 1 : header >>> 3;
		if (!has(body)) return void 0;
		offset += body;
		if (lastBlock) break;
	}
	if (checksum) {
		if (!has(4)) return void 0;
		offset += 4;
	}
	return offset;
}
/**
* Decode every stored record of one concatenated-frame log.
* @param bytes - whole stored log.
* @returns records in file order.
* Only one frame is decompressed at a time and a record split across frames is carried forward,
* so memory stays proportional to the stored bytes rather than to the decoded session.
*/
function* decodeStoredRows(bytes) {
	let offset = 0;
	let remainder = "";
	while (offset < bytes.length) {
		const end = zstdFrameEnd(bytes, offset);
		if (end === void 0) throw new Error("stored log has a malformed Zstandard frame at byte " + String(offset));
		const lines = (remainder + zstdDecompressSync(bytes.subarray(offset, end)).toString("utf8")).split("\n");
		remainder = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length === 0) continue;
			yield JSON.parse(line);
		}
		offset = end;
	}
	if (remainder.length > 0) yield JSON.parse(remainder);
}
/**
* Stream one refused generation as bounded reducer batches.
* @param path - stored log reported by the refusal.
* @param request - session identity, persisted cursor, and maximum batch length.
* @param signal - optional cancellation.
* @returns batches of reducible events, in stored order.
*/
async function* readLegacyBatches(path, request, signal) {
	const bytes = await readFile(path);
	let events = [];
	for (const row of decodeStoredRows(bytes)) {
		signal?.throwIfAborted();
		if (!REDUCED_EVENT_TYPES.has(row.type) || !Number.isSafeInteger(row.seq) || row.seq < request.fromSeq) continue;
		events.push(row);
		if (events.length < request.batchEvents) continue;
		const batch = events;
		events = [];
		yield {
			meta: { id: request.session.id },
			inheritedEventCount: 0,
			events: batch
		};
	}
	if (events.length > 0) yield {
		meta: { id: request.session.id },
		inheritedEventCount: 0,
		events
	};
}
//#endregion
//#region lib/types/jsonl-reader.js
/** Read-only worker adapter using released JSONL public handles, not physical log parsing. */
var __rewriteRelativeImportExtension = function(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
};
function resolveOptions(options) {
	if (typeof options?.root !== "string" || !isAbsolute(options.root)) throw new TypeError("JSONL reader root must be an absolute path");
	if (options.compression !== "none" && options.compression !== "zstd") throw new TypeError("JSONL reader compression must be none or zstd");
	if (typeof options.providerModule !== "string") throw new TypeError("JSONL reader providerModule must be a file URL");
	const providerModule = new URL(options.providerModule);
	if (providerModule.protocol !== "file:") throw new TypeError("JSONL reader providerModule must be a file URL");
	return {
		root: options.root,
		compression: options.compression,
		providerModule
	};
}
async function createProvider(options) {
	const config = resolveOptions(options);
	const require = createRequire(config.providerModule);
	const { Context } = await import(__rewriteRelativeImportExtension(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href));
	const { SessionId } = await import(__rewriteRelativeImportExtension(pathToFileURL(require.resolve("@deepseek-ai/dsh-session")).href));
	const { SessionFormatUnsupportedError, SessionPersistenceNotFoundError } = await import(__rewriteRelativeImportExtension(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-persistence")).href));
	const { default: Jsonl } = await import(__rewriteRelativeImportExtension(config.providerModule.href));
	const packageJson = JSON.parse(await readFile(require.resolve("@deepseek-ai/dsh-session-persistence-jsonl/package.json"), "utf8"));
	const ctx = new Context();
	const fiber = ctx.plugin(Jsonl, {
		root: config.root,
		compression: config.compression
	});
	try {
		await fiber.await();
	} catch (error) {
		await fiber.dispose();
		throw error;
	}
	return {
		provider: ctx.sessionPersistence,
		fiber,
		SessionId,
		SessionFormatUnsupportedError,
		SessionPersistenceNotFoundError,
		config,
		providerVersion: packageJson.version
	};
}
const providers = /* @__PURE__ */ new WeakMap();
/**
* Open the released provider once per reader options value.
* @param options - root, encoding, and selected provider module.
* @returns the shared provider instance.
* The released provider caches its root-encoding directory walk on the instance, so opening a
* provider per observed session would re-walk the whole session tree for every session. The
* instance is intentionally not disposed here: it is owned by the option value and the worker
* process reclaims it on exit. A failed open is not cached.
*/
async function openProvider(options) {
	if (options === void 0) return createProvider(options);
	const cached = providers.get(options);
	if (cached !== void 0) return cached;
	const pending = createProvider(options);
	providers.set(options, pending);
	try {
		return await pending;
	} catch (error) {
		providers.delete(options);
		throw error;
	}
}
/**
/**
* Checkpoint identity for the released JSONL adapter.
* Changing this string invalidates every stored checkpoint and forces one full re-verification of
* all history, so it must only change when the fingerprint encoding itself becomes incompatible.
*/
const SOURCE_READER_ID = "released-jsonl-checkpoint-v2";
/**
* Identify the reader configuration and released provider version that produced a fingerprint.
* @param config - validated reader options.
* @param providerVersion - installed released provider version.
* @returns an opaque identity; it excludes the plugin install path and plugin version.
*/
function sourceIdentity(config, providerVersion) {
	return workerSourceIdentity(JSON.stringify({
		reader: SOURCE_READER_ID,
		root: config.root,
		compression: config.compression,
		providerVersion
	}));
}
/**
* Encode the durable part of a released provider revision.
* @param revision - provider revision for one stored log.
* @param sizeBytes - stored log length reported beside the revision.
* @returns a fingerprint comparable across processes, or undefined when the revision is unrecognized.
* A revision is device, inode, size, and nanosecond mtime and ctime, optionally followed by a
* process-scoped digest. Only the leading durable components are kept, so both a revision with that
* digest and one without it produce a comparable fingerprint.
*/
function durableFingerprint(revision, sizeBytes) {
	if (revision === void 0) return void 0;
	const parts = revision.split(":");
	if (parts.length < 5) return void 0;
	const durable = parts.slice(0, 5);
	if (!durable.every((part) => /^[0-9]+$/.test(part))) return void 0;
	if (sizeBytes !== void 0 && Number(durable[2]) !== sizeBytes) return void 0;
	return workerSourceFingerprint(JSON.stringify({ artifact: durable }));
}
/**
* Observe the JSONL inputs of a replay without decoding event bodies.
* @param options - root, encoding, and selected provider module.
* @param request - stored lifecycle and whether this is a mid-pass lookup or a post-EOF verification.
* @param signal - optional cancellation.
* @returns a durable fingerprint; missing or unmaterialized sessions provide no reusable checkpoint.
* A single session is observed through its own stored revision, which is the durable value the
* listing reports for the same log.
*/
const getSourceStamp = async (options, request, signal) => {
	signal?.throwIfAborted();
	const { provider, SessionId, config, providerVersion } = await openProvider(options);
	const snapshot = await provider.stat(SessionId(request.session.id), { signal });
	if (snapshot === void 0 || snapshot.header.createdAt !== request.session.createdAt) return void 0;
	const fingerprint = durableFingerprint(snapshot.revision, snapshot.sizeBytes);
	if (fingerprint === void 0) return void 0;
	return {
		source: sourceIdentity(config, providerVersion),
		fingerprint
	};
};
/**
* List headers inside the isolated worker through the released provider's metadata API.
* @param options - provider file URL, root, and physical encoding from the Host.
* @param request - creation-time window used for recent-first replay.
* @param signal - optional cancellation.
* @returns headers without event bodies, each carrying the durable fingerprint of its stored log.
* One list call reports every selected session, so discovery never observes sessions one by one.
*/
const listSessionHeaders = async function* (options, request, signal) {
	signal?.throwIfAborted();
	const { provider, config, providerVersion } = await openProvider(options);
	const source = sourceIdentity(config, providerVersion);
	const snapshots = await provider.list({ signal });
	for (const snapshot of snapshots) {
		signal?.throwIfAborted();
		const { header } = snapshot;
		if (request.createdAtAfter !== void 0 && header.createdAt < request.createdAtAfter) continue;
		if (request.createdAtBefore !== void 0 && header.createdAt >= request.createdAtBefore) continue;
		const fingerprint = durableFingerprint(snapshot.revision, snapshot.sizeBytes);
		yield {
			id: header.id,
			createdAt: header.createdAt,
			...header.cwd === void 0 ? {} : { cwd: header.cwd },
			source,
			...fingerprint === void 0 ? {} : { fingerprint }
		};
	}
};
/**
* Read one logical session in bounded reducer batches through public read-only handles.
* @param options - provider file URL, root, and encoding from the Host.
* @param request - session identity, persisted cursor, and maximum batch length.
* @param signal - optional cancellation.
* @returns current logical event batches with the provider-owned inherited prefix length.
* The provider may decode a whole session while opening it; its decoded-log memo is bounded, and
* the instance is shared with the metadata observers above. No write handle is opened.
*/
const readSessionBatches = async function* (options, request, signal) {
	signal?.throwIfAborted();
	if (!Number.isSafeInteger(request.fromSeq) || request.fromSeq < 0) throw new TypeError("JSONL reader fromSeq must be nonnegative");
	if (!Number.isSafeInteger(request.batchEvents) || request.batchEvents < 1) throw new TypeError("JSONL reader batchEvents must be positive");
	const { provider, SessionId, SessionFormatUnsupportedError, SessionPersistenceNotFoundError, config } = await openProvider(options);
	let handle;
	try {
		try {
			handle = await provider.open(SessionId(request.session.id), "read", { signal });
		} catch (error) {
			if (error instanceof SessionPersistenceNotFoundError) return;
			if (error instanceof SessionFormatUnsupportedError) {
				const stored = storedLogPath(error);
				if (stored !== void 0 && config.compression === "zstd") {
					yield* readLegacyBatches(stored, request, signal);
					return;
				}
				throw new UsageLedgerUnreadableSourceError(error.message);
			}
			throw error;
		}
		let offset = request.fromSeq;
		while (true) {
			signal?.throwIfAborted();
			const { events } = await handle.read(offset, request.batchEvents, { signal });
			if (events.length === 0) break;
			yield {
				meta: { id: handle.header.id },
				inheritedEventCount: handle.inheritedEventCount,
				events
			};
			offset += events.length;
			if (events.length < request.batchEvents) break;
		}
	} finally {
		await handle?.close();
	}
};
//#endregion
export { getSourceStamp, listSessionHeaders, readSessionBatches };
