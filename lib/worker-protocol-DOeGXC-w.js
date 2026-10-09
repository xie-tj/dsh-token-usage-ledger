//#region lib/types/host/worker-protocol.js
/** Brand a reader-generated source identity. @param value - stable source description. @returns branded identity. */
function workerSourceIdentity(value) {
	return value;
}
/** Brand a reader-generated fingerprint. @param value - durable metadata fingerprint. @returns branded fingerprint. */
function workerSourceFingerprint(value) {
	return value;
}
/** Stable failure code reported when a reader cannot decode the selected stored generation. */
const USAGE_LEDGER_UNREADABLE_SOURCE = "usage-ledger-unreadable-source";
/** Failure raised for a stored generation the installed reader refuses to migrate. */
var UsageLedgerUnreadableSourceError = class extends Error {
	/** Stable marker read across the reader/worker module boundary. */
	code = USAGE_LEDGER_UNREADABLE_SOURCE;
	/** @param message - reader refusal text retained for diagnostics. */
	constructor(message) {
		super(message);
		this.name = "UsageLedgerUnreadableSourceError";
	}
};
/**
* Whether one reader failure refuses the stored generation itself.
* @param error - failure observed while reading inside the worker.
* @returns true when re-reading the same source revision cannot succeed.
*/
function isUnreadableSourceFailure(error) {
	return typeof error === "object" && error !== null && error.code === "usage-ledger-unreadable-source";
}
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
export { workerSourceFingerprint as a, isUnreadableSourceFailure as i, decodeWorkerFrame as n, workerSourceIdentity as o, encodeWorkerFrame as r, UsageLedgerUnreadableSourceError as t };
