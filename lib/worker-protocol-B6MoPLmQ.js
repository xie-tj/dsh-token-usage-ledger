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
export { encodeWorkerFrame as n, createUsageAttemptId as r, decodeWorkerFrame as t };
