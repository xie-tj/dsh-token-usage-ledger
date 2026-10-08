/** Read-only worker adapter using released JSONL public handles, not physical log parsing. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readdir, stat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { workerSourceFingerprint, workerSourceIdentity, type WorkerReaderModule, type WorkerSourceStamp } from './host/worker-protocol.ts'

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

async function physicalObservation(path: string, root: string): Promise<readonly string[]> {
  const value=await stat(path,{bigint:true})
  if(!value.isFile())throw new Error('JSONL source artifact is not a file')
  return [relative(root,path),value.dev.toString(),value.ino.toString(),value.size.toString(),value.mtimeNs.toString(),value.ctimeNs.toString()]
}

async function corpusFingerprint(root: string, compression: 'none' | 'zstd', signal?: AbortSignal): Promise<string> {
  const observations: (readonly string[])[]=[]
  for(const project of await readdir(root,{withFileTypes:true})) {
    signal?.throwIfAborted()
    if(!project.isDirectory())continue
    const projectPath=join(root,project.name)
    for(const session of await readdir(projectPath,{withFileTypes:true})) {
      signal?.throwIfAborted()
      if(!session.isDirectory())continue
      const path=join(projectPath,session.name)
      let selected: {name:string;version:number}|undefined
      for(const file of await readdir(path)) {
        const match=/^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(file)
        if(match===null || (compression==='zstd')!==(match[2]!==undefined))continue
        const version=match[1]===undefined?0:Number(match[1])
        if(selected===undefined || version>selected.version)selected={name:file,version}
      }
      if(selected!==undefined)observations.push(await physicalObservation(join(path,selected.name),root))
    }
  }
  observations.sort((left,right)=>left[0].localeCompare(right[0]))
  return createHash('sha256').update(JSON.stringify(observations)).digest('hex')
}

function sourceIdentity(config: ReturnType<typeof resolveOptions>, providerVersion: string) {
  return workerSourceIdentity(JSON.stringify({reader:'released-jsonl-checkpoint-v1',root:config.root,compression:config.compression,providerVersion}))
}

/**
 * Observe the JSONL inputs of a replay without decoding event bodies.
 * @param options - root, encoding, and selected provider module.
 * @param request - stored lifecycle and whether this is a mid-pass lookup or a post-EOF verification.
 * @param signal - optional cancellation.
 * @returns a durable fingerprint; missing or unmaterialized sessions provide no reusable checkpoint.
 * Current logs use their physical revision; historical projections use the freshly observed corpus.
 */
export const getSourceStamp: NonNullable<WorkerReaderModule['getSourceStamp']> = async (options,request,signal) => {
  signal?.throwIfAborted()
  const {provider,SessionId,config,providerVersion}=await openProvider(options)
  {
    const id=SessionId(request.session.id)
    const snapshot=await provider.stat(id,{signal})
    if(snapshot===undefined || snapshot.header.createdAt!==request.session.createdAt)return undefined
    const source=sourceIdentity(config,providerVersion)
    const current=await provider.resolveCurrentLog(id,signal)
    if(current!==undefined) {
      const observation=await physicalObservation(current,config.root)
      return {source,fingerprint:workerSourceFingerprint(createHash('sha256').update(JSON.stringify({current:observation})).digest('hex'))}
    }
    // Historical projections also depend on sibling generations, so the selected corpus is
    // observed fresh: a digest taken at listing time can predate a change made during the pass.
    const corpus=await corpusFingerprint(config.root,config.compression,signal)
    return {source,fingerprint:workerSourceFingerprint('historical:'+corpus)}
  }
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
  const {provider}=await openProvider(options)
  {
    const snapshots=await provider.list({signal})
    for(const {header} of snapshots) {
      signal?.throwIfAborted()
      if(request.createdAtAfter !== undefined && header.createdAt < request.createdAtAfter)continue
      if(request.createdAtBefore !== undefined && header.createdAt >= request.createdAtBefore)continue
      yield {id:header.id,createdAt:header.createdAt,...(header.cwd===undefined?{}:{cwd:header.cwd})}
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
