import type { WorkerReaderBatch } from './host/worker-protocol.js';
/** One stored record as written by the session log writer. */
interface StoredRow {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: Record<string, unknown>;
}
/**
 * Read the physical raw-log path a refusal reports.
 * @param error - failure raised by the released provider while opening one stored generation.
 * @returns an absolute stored-log path, or undefined when the refusal names no artifact.
 */
export declare function storedLogPath(error: unknown): string | undefined;
/**
 * Locate the end of one Zstandard frame without decompressing it.
 * @param bytes - whole stored log.
 * @param start - offset of the frame magic.
 * @returns the offset just past the frame, or undefined when the frame is truncated or malformed.
 * Node decompresses only the first frame of a concatenated stream, so frame boundaries are found by
 * walking the frame header and block headers the format writes before each block.
 */
export declare function zstdFrameEnd(bytes: Uint8Array, start: number): number | undefined;
/**
 * Decode every stored record of one concatenated-frame log.
 * @param bytes - whole stored log.
 * @returns records in file order.
 * Only one frame is decompressed at a time and a record split across frames is carried forward,
 * so memory stays proportional to the stored bytes rather than to the decoded session.
 */
export declare function decodeStoredRows(bytes: Uint8Array): Generator<StoredRow>;
/**
 * Stream one refused generation as bounded reducer batches.
 * @param path - stored log reported by the refusal.
 * @param request - session identity, persisted cursor, and maximum batch length.
 * @param signal - optional cancellation.
 * @returns batches of reducible events, in stored order.
 */
export declare function readLegacyBatches(path: string, request: {
    readonly session: {
        readonly id: string;
    };
    readonly fromSeq: number;
    readonly batchEvents: number;
}, signal?: AbortSignal): AsyncGenerator<WorkerReaderBatch>;
export {};
