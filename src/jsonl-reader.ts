/** Read-only worker adapter using released JSONL public handles, not physical log parsing. */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { workerSourceFingerprint, workerSourceIdentity, type WorkerReaderModule, type WorkerSourceFingerprint, type WorkerSourceStamp } from './host/worker-protocol.ts'

type Options = Readonly<Record<string, boolean | number | string>> | undefined

function resolveOptions(options: Options) {
  if (typeof options?.root !== 'string' || !isAbsolute(options.root)) throw new TypeError('JSONL reader root must be an absolute path')
  if (options.compression !== 'none' && options.compression !== 'zstd') throw new TypeError('JSONL reader compression must be none or zstd')
  if (typeof options.providerModule !== 'string') throw new TypeError('JSONL reader providerModule must be a file URL')
  const providerModule = new URL(options.providerModule)
  if (providerModule.protocol !== 'file:') throw new TypeError('JSONL reader providerModule must be a file URL')
  return {root:options.root,compression:options.compression,providerModule} as const
}

async function createProvider(options: Options) {
  const config=resolveOptions(options)
  // Resolve peers beside the Host-selected provider, including app.asar deployments.
  const require=createRequire(config.providerModule)
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href) as typeof import('@deepseek-ai/cordis')
  const {SessionId}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href) as typeof import('@deepseek-ai/dsh-session')
  const {SessionPersistenceNotFoundError}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')).href) as typeof import('@deepseek-ai/dsh-session-persistence')
  const {default:Jsonl}=await import(config.providerModule.href) as typeof import('@deepseek-ai/dsh-session-persistence-jsonl')
  const packageJson=JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json'),'utf8')) as {version:string}
  const ctx=new Context()
  const fiber=ctx.plugin(Jsonl,{root:config.root,compression:config.compression})
  try {await fiber.await()} catch (error: unknown) {await fiber.dispose();throw error}
  return {provider:ctx.sessionPersistence as InstanceType<typeof Jsonl>,fiber,SessionId,SessionPersistenceNotFoundError,config,providerVersion:packageJson.version}
}

type OpenedProvider = Awaited<ReturnType<typeof createProvider>>

// Keyed by the worker's immutable reader options, which live until the worker exits.
const providers = new WeakMap<NonNullable<Options>, Promise<OpenedProvider>>()

/**
 * Open the released provider once per reader options value.
 * @param options - root, encoding, and selected provider module.
 * @returns the shared provider instance.
 * The released provider caches its root-encoding directory walk on the instance, so opening a
 * provider per observed session would re-walk the whole session tree for every session. The
 * instance is intentionally not disposed here: it is owned by the option value and the worker
 * process reclaims it on exit. A failed open is not cached.
 */
async function openProvider(options: Options): Promise<OpenedProvider> {
  if(options===undefined)return createProvider(options)
  const cached=providers.get(options)
  if(cached!==undefined)return cached
  const pending=createProvider(options)
  providers.set(options,pending)
  try {return await pending} catch (error: unknown) {providers.delete(options);throw error}
}

/**
/**
 * Checkpoint identity for the released JSONL adapter.
 * Changing this string invalidates every stored checkpoint and forces one full re-verification of
 * all history, so it must only change when the fingerprint encoding itself becomes incompatible.
 */
const SOURCE_READER_ID='released-jsonl-checkpoint-v2'

/**
 * Identify the reader configuration and released provider version that produced a fingerprint.
 * @param config - validated reader options.
 * @param providerVersion - installed released provider version.
 * @returns an opaque identity; it excludes the plugin install path and plugin version.
 */
function sourceIdentity(config: ReturnType<typeof resolveOptions>, providerVersion: string) {
  return workerSourceIdentity(JSON.stringify({reader:SOURCE_READER_ID,root:config.root,compression:config.compression,providerVersion}))
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
function durableFingerprint(revision: string|undefined, sizeBytes: number|undefined): WorkerSourceFingerprint|undefined {
  if(revision===undefined)return undefined
  const parts=revision.split(':')
  if(parts.length<5)return undefined
  const durable=parts.slice(0,5)
  if(!durable.every(part=>/^[0-9]+$/.test(part)))return undefined
  if(sizeBytes!==undefined && Number(durable[2])!==sizeBytes)return undefined
  return workerSourceFingerprint(JSON.stringify({artifact:durable}))
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
export const getSourceStamp: NonNullable<WorkerReaderModule['getSourceStamp']> = async (options,request,signal) => {
  signal?.throwIfAborted()
  const {provider,SessionId,config,providerVersion}=await openProvider(options)
  const snapshot=await provider.stat(SessionId(request.session.id),{signal})
  if(snapshot===undefined || snapshot.header.createdAt!==request.session.createdAt)return undefined
  const fingerprint=durableFingerprint(snapshot.revision,snapshot.sizeBytes)
  if(fingerprint===undefined)return undefined
  return {source:sourceIdentity(config,providerVersion),fingerprint}
}

/**
 * List headers inside the isolated worker through the released provider's metadata API.
 * @param options - provider file URL, root, and physical encoding from the Host.
 * @param request - creation-time window used for recent-first replay.
 * @param signal - optional cancellation.
 * @returns headers without event bodies, each carrying the durable fingerprint of its stored log.
 * One list call reports every selected session, so discovery never observes sessions one by one.
 */
export const listSessionHeaders: NonNullable<WorkerReaderModule['listSessionHeaders']> = async function* (options,request,signal) {
  signal?.throwIfAborted()
  const {provider,config,providerVersion}=await openProvider(options)
  const source=sourceIdentity(config,providerVersion)
  const snapshots=await provider.list({signal})
  for(const snapshot of snapshots) {
    signal?.throwIfAborted()
    const {header}=snapshot
    if(request.createdAtAfter !== undefined && header.createdAt < request.createdAtAfter)continue
    if(request.createdAtBefore !== undefined && header.createdAt >= request.createdAtBefore)continue
    const fingerprint=durableFingerprint(snapshot.revision,snapshot.sizeBytes)
    yield {
      id:header.id,
      createdAt:header.createdAt,
      ...(header.cwd===undefined?{}:{cwd:header.cwd}),
      source,
      ...(fingerprint===undefined?{}:{fingerprint}),
    }
  }
}

/**
 * Read one logical session in bounded reducer batches through public read-only handles.
 * @param options - provider file URL, root, and encoding from the Host.
 * @param request - session identity, persisted cursor, and maximum batch length.
 * @param signal - optional cancellation.
 * @returns current logical event batches with the provider-owned inherited prefix length.
 * The provider may decode a whole session while opening it; its decoded-log memo is bounded, and
 * the instance is shared with the metadata observers above. No write handle is opened.
 */
export const readSessionBatches: WorkerReaderModule['readSessionBatches'] = async function* (options,request,signal) {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(request.fromSeq) || request.fromSeq < 0) throw new TypeError('JSONL reader fromSeq must be nonnegative')
  if (!Number.isSafeInteger(request.batchEvents) || request.batchEvents < 1) throw new TypeError('JSONL reader batchEvents must be positive')
  const {provider,SessionId,SessionPersistenceNotFoundError}=await openProvider(options)
  let handle: SessionHandle | undefined
  try {
    try {
      handle=await provider.open(SessionId(request.session.id),'read',{signal})
    } catch (error: unknown) {
      // Live session notifications can precede physical materialization; a later
      // rescan observes the durable prefix without taking a write handle.
      if (error instanceof SessionPersistenceNotFoundError) return
      throw error
    }
    let offset=request.fromSeq
    while(true) {
      signal?.throwIfAborted()
      const {events}=await handle.read(offset,request.batchEvents,{signal})
      if(events.length===0)break
      yield {meta:{id:handle.header.id},inheritedEventCount:handle.inheritedEventCount,events}
      offset+=events.length
      if(events.length < request.batchEvents)break
    }
  } finally {
    await handle?.close()
  }
}
