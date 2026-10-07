import { type WorkerReaderModule } from './host/worker-protocol.js';
/**
 * Observe the JSONL inputs of a replay without decoding event bodies.
 * @param options - root, encoding, and selected provider module.
 * @param request - stored lifecycle and whether to reuse listing-time metadata or verify fresh EOF inputs.
 * @param signal - optional cancellation.
 * @returns a durable fingerprint; missing or unmaterialized sessions provide no reusable checkpoint.
 * Current logs use their physical revision. Historical projections also depend on the selected corpus.
 */
export declare const getSourceStamp: NonNullable<WorkerReaderModule['getSourceStamp']>;
/**
 * List headers inside the isolated worker through the released provider's metadata API.
 * @param options - provider file URL, root, and physical encoding from the Host.
 * @param request - creation-time window used for recent-first replay.
 * @param signal - optional cancellation.
 * @returns headers without event bodies; the public list API materializes metadata in the worker.
 */
export declare const listSessionHeaders: NonNullable<WorkerReaderModule['listSessionHeaders']>;
/**
 * Read one logical session in bounded reducer batches through public read-only handles.
 * @param options - provider file URL, root, and encoding from the Host.
 * @param request - session identity, persisted cursor, and maximum batch length.
 * @param signal - optional cancellation.
 * @returns current logical event batches with the provider-owned inherited prefix length.
 * The provider may decode a whole session while opening it; a fresh instance per session
 * prevents its decoded-log memo retaining previous sessions. No write handle is opened.
 */
export declare const readSessionBatches: WorkerReaderModule['readSessionBatches'];
