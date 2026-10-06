/** Isolated read adapter for the released JSONL persistence provider. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { USAGE_LEDGER_WORKER_PROTOCOL } from "./worker-protocol.js";
/**
 * Describe the released provider's read-only worker adapter, without listing or opening logs on the Host.
 * @param persistence - the currently mounted persistence provider.
 * @returns an adapter spec for released JSONL instances, otherwise no match.
 */
export async function releasedJsonlReaderSpec(persistence) {
    if (persistence.name !== 'session-persistence-jsonl')
        return undefined;
    let module;
    try {
        module = await import('@deepseek-ai/dsh-session-persistence-jsonl');
    }
    catch (error) {
        // The optional peer is absent in deployments using a custom persistence provider.
        if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND'
            && error.message.includes('@deepseek-ai/dsh-session-persistence-jsonl'))
            return undefined;
        throw error;
    }
    if (!(persistence instanceof module.default))
        return undefined;
    const worker = import.meta.url.endsWith('.ts')
        ? new URL('../../lib/jsonl-reader.js', import.meta.url)
        : new URL('./jsonl-reader.js', import.meta.url);
    return {
        protocolVersion: USAGE_LEDGER_WORKER_PROTOCOL,
        workerModule: fileURLToPath(worker),
        supportsSessionListing: true,
        options: {
            providerModule: pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href,
            root: resolve(persistence.config.root),
            compression: persistence.config.compression ?? 'zstd',
        },
    };
}
