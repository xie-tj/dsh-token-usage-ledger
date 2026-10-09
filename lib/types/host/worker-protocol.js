/** Versioned NDJSON protocol shared by the Host supervisor and backfill worker. */
export const USAGE_LEDGER_WORKER_PROTOCOL = 1;
/** Brand a reader-generated source identity. @param value - stable source description. @returns branded identity. */
export function workerSourceIdentity(value) { return value; }
/** Brand a reader-generated fingerprint. @param value - durable metadata fingerprint. @returns branded fingerprint. */
export function workerSourceFingerprint(value) { return value; }
/** Stable failure code reported when a reader cannot decode the selected stored generation. */
export const USAGE_LEDGER_UNREADABLE_SOURCE = 'usage-ledger-unreadable-source';
/** Failure raised for a stored generation the installed reader refuses to migrate. */
export class UsageLedgerUnreadableSourceError extends Error {
    /** Stable marker read across the reader/worker module boundary. */
    code = USAGE_LEDGER_UNREADABLE_SOURCE;
    /** @param message - reader refusal text retained for diagnostics. */
    constructor(message) {
        super(message);
        this.name = 'UsageLedgerUnreadableSourceError';
    }
}
/**
 * Whether one reader failure refuses the stored generation itself.
 * @param error - failure observed while reading inside the worker.
 * @returns true when re-reading the same source revision cannot succeed.
 */
export function isUnreadableSourceFailure(error) {
    return typeof error === 'object' && error !== null
        && error.code === USAGE_LEDGER_UNREADABLE_SOURCE;
}
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
