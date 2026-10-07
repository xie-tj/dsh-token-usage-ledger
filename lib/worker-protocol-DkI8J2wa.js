//#region lib/types/host/worker-protocol.js
/** Brand a reader-generated source identity. @param value - stable source description. @returns branded identity. */
function workerSourceIdentity(value) {
	return value;
}
/** Brand a reader-generated fingerprint. @param value - durable metadata fingerprint. @returns branded fingerprint. */
function workerSourceFingerprint(value) {
	return value;
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
export { workerSourceIdentity as i, encodeWorkerFrame as n, workerSourceFingerprint as r, decodeWorkerFrame as t };
