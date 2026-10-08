import { i as workerSourceIdentity, r as workerSourceFingerprint } from "./worker-protocol-DkI8J2wa.js";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
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
	const { SessionPersistenceNotFoundError } = await import(__rewriteRelativeImportExtension(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-persistence")).href));
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
* Identify the reader configuration and released provider version that produced a fingerprint.
* @param config - validated reader options.
* @param providerVersion - installed released provider version.
* @returns an opaque identity; it excludes the plugin install path and plugin version.
*/
function sourceIdentity(config, providerVersion) {
	return workerSourceIdentity(JSON.stringify({
		reader: "released-jsonl-checkpoint-v2",
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
	const { provider, SessionId, SessionPersistenceNotFoundError } = await openProvider(options);
	let handle;
	try {
		try {
			handle = await provider.open(SessionId(request.session.id), "read", { signal });
		} catch (error) {
			if (error instanceof SessionPersistenceNotFoundError) return;
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
