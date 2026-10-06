/** Read-only worker adapter using released JSONL public handles, not physical log parsing. */
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { WorkerReaderModule } from './host/worker-protocol.ts'

type Options = Readonly<Record<string, boolean | number | string>> | undefined

function resolveOptions(options: Options) {
  if (typeof options?.root !== 'string' || !isAbsolute(options.root)) throw new TypeError('JSONL reader root must be an absolute path')
  if (options.compression !== 'none' && options.compression !== 'zstd') throw new TypeError('JSONL reader compression must be none or zstd')
  if (typeof options.providerModule !== 'string') throw new TypeError('JSONL reader providerModule must be a file URL')
  const providerModule = new URL(options.providerModule)
  if (providerModule.protocol !== 'file:') throw new TypeError('JSONL reader providerModule must be a file URL')
  return {root:options.root,compression:options.compression,providerModule} as const
}

async function openProvider(options: Options) {
  const config=resolveOptions(options)
  // Resolve peers beside the Host-selected provider, including app.asar deployments.
  const require=createRequire(config.providerModule)
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href) as typeof import('@deepseek-ai/cordis')
  const {SessionId}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href) as typeof import('@deepseek-ai/dsh-session')
  const {SessionPersistenceNotFoundError}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')).href) as typeof import('@deepseek-ai/dsh-session-persistence')
  const {default:Jsonl}=await import(config.providerModule.href) as typeof import('@deepseek-ai/dsh-session-persistence-jsonl')
  const ctx=new Context()
  const fiber=ctx.plugin(Jsonl,{root:config.root,compression:config.compression})
  try {await fiber.await()} catch (error: unknown) {await fiber.dispose();throw error}
  return {provider:ctx.sessionPersistence,fiber,SessionId,SessionPersistenceNotFoundError}
}

/**
 * List headers inside the isolated worker through the released provider's metadata API.
 * @param options - provider file URL, root, and physical encoding from the Host.
 * @param request - creation-time window used for recent-first replay.
 * @param signal - optional cancellation.
 * @returns headers without event bodies; the public list API materializes metadata in the worker.
 */
export const listSessionHeaders: NonNullable<WorkerReaderModule['listSessionHeaders']> = async function* (options,request,signal) {
  signal?.throwIfAborted()
  const {provider,fiber}=await openProvider(options)
  try {
    const snapshots=await provider.list({signal})
    for(const {header} of snapshots) {
      signal?.throwIfAborted()
      if(request.createdAtAfter !== undefined && header.createdAt < request.createdAtAfter)continue
      if(request.createdAtBefore !== undefined && header.createdAt >= request.createdAtBefore)continue
      yield {id:header.id,createdAt:header.createdAt,...(header.cwd===undefined?{}:{cwd:header.cwd})}
    }
  } finally {await fiber.dispose()}
}

/**
 * Read one logical session in bounded reducer batches through public read-only handles.
 * @param options - provider file URL, root, and encoding from the Host.
 * @param request - session identity, persisted cursor, and maximum batch length.
 * @param signal - optional cancellation.
 * @returns current logical event batches with the provider-owned inherited prefix length.
 * The provider may decode a whole session while opening it; a fresh instance per session
 * prevents its decoded-log memo retaining previous sessions. No write handle is opened.
 */
export const readSessionBatches: WorkerReaderModule['readSessionBatches'] = async function* (options,request,signal) {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(request.fromSeq) || request.fromSeq < 0) throw new TypeError('JSONL reader fromSeq must be nonnegative')
  if (!Number.isSafeInteger(request.batchEvents) || request.batchEvents < 1) throw new TypeError('JSONL reader batchEvents must be positive')
  const {provider,fiber,SessionId,SessionPersistenceNotFoundError}=await openProvider(options)
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
    try {await handle?.close()} finally {await fiber.dispose()}
  }
}
