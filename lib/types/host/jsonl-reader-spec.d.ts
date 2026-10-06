import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { type WorkerReaderSpec } from './worker-protocol.js';
/**
 * Describe the released provider's read-only worker adapter, without listing or opening logs on the Host.
 * @param persistence - the currently mounted persistence provider.
 * @returns an adapter spec for released JSONL instances, otherwise no match.
 */
export declare function releasedJsonlReaderSpec(persistence: SessionPersistence): Promise<WorkerReaderSpec | undefined>;
