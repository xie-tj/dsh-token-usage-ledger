/** Versioned NDJSON protocol shared by the Host supervisor and backfill worker. */
export const USAGE_LEDGER_WORKER_PROTOCOL = 1;
/** Serialize a single protocol frame with exactly one newline. */
export function encodeWorkerFrame(frame) {
    return `${JSON.stringify(frame)}\n`;
}
/** Parse and minimally validate an incoming NDJSON frame. */
export function decodeWorkerFrame(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || typeof value.type !== 'string') {
        return undefined;
    }
    return value;
}
