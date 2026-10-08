import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readSessionBatches } from '../lib/types/jsonl-reader.js'
import { releasedJsonlReaderSpec } from '../src/host/jsonl-reader-spec.ts'
import { Context } from '@deepseek-ai/cordis'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type {} from '../lib/types/host/index.js'
// @ts-expect-error packed root runtime has declarations in its types export
import Ledger from '../lib/index.js'

async function logBytes(root: string): Promise<Map<string, Buffer>> {
  const files = await readdir(root, {recursive:true})
  const result = new Map<string, Buffer>()
  for (const file of files) {
    if (file.endsWith('.jsonl') || file.endsWith('.jsonl.zstd')) result.set(file, await readFile(join(root,file)))
  }
  return result
}

interface ProbeLine { readonly kind: 'construct' | 'open'; readonly id?: string }

async function probeLines(temporary: string): Promise<readonly ProbeLine[]> {
  const text = await readFile(join(temporary, 'log-opens.ndjson'), 'utf8')
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as ProbeLine)
}

async function waitForHistory(ctx: Context, sessions: number): Promise<void> {
  const deadline=Date.now()+5000
  while(Date.now()<deadline) {
    const status=ctx.usageLedger.statusSnapshot()
    if(status.lastError !== undefined) throw new Error(status.lastError)
    if(status.state==='idle' && status.processedSessions===sessions)return
    await new Promise(resolve=>setTimeout(resolve,20))
  }
  throw new Error('Released JSONL replay did not finish')
}

describe('Released JSONL persistence compatibility', () => {
  it('leaves a newly created but not yet durable session for a later rescan', async () => {
    const temporary=await mkdtemp(join(tmpdir(),'usage-pending-jsonl-'))
    const root=join(temporary,'sessions')
    const ctx=new Context()
    const provider=ctx.plugin(JsonlPersistence,{root,compression:'none'})
    let pending: Awaited<ReturnType<typeof ctx.sessionPersistence.create>> | undefined
    try {
      await provider.await()
      const id=SessionId('pending')
      pending=await ctx.sessionPersistence.create({id,version:SESSION_FORMAT_VERSION,createdAt:Date.now(),isSeeded:false})
      expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
      const options={root,compression:'none',providerModule:pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href}
      const batches=[]
      for await(const batch of readSessionBatches(options,{session:{id},fromSeq:0,batchEvents:10}))batches.push(batch)
      expect(batches).toEqual([])
      expect(await readdir(temporary)).toEqual([])
    } finally {
      await pending?.close()
      await provider.dispose()
      await rm(temporary,{recursive:true,force:true})
    }
  })

  it.each(['none','zstd'] as const)('backfills through the actual 0.2.0-rc.2 read handles (%s) without publishing session changes', async compression => {
    const temporary = await mkdtemp(join(tmpdir(),'usage-released-jsonl-'))
    const root = join(temporary,'sessions')
    const ctx = new Context()
    ctx.provide('sessions', {list:()=>[],get:()=>undefined} as never)
    const provider = ctx.plugin(JsonlPersistence,{root,compression})
    let ledger: ReturnType<typeof ctx.plugin> | undefined
    try {
      await provider.await()
      const now=Date.now()-1000
      const events: SessionEvent[] = [
        {type:'turn/start',seq:SessionSeq(0),time:now,data:{turn:1}},
        {type:'step/start',seq:SessionSeq(1),time:now,data:{turn:1,step:1}},
        {type:'assistant/attempt',seq:SessionSeq(2),time:now+1,data:{turn:1,step:1,stream:[
          {type:'chunk',time:now+1,chunk:{type:'usage',usage:{inputTokens:12,outputTokens:8}}},
          {type:'chunk',time:now+2,chunk:{type:'finish',reason:{kind:'stop'}}},
        ]}},
      ]
      for(const [id,createdAt,body] of [
        [SessionId('recent'),now,events],
        [SessionId('older'),now-40*24*60*60*1000,[]],
      ] as const) {
        const handle = await ctx.sessionPersistence.create({id,version:SESSION_FORMAT_VERSION,createdAt,cwd:'/example',isSeeded:false})
        try {if(body.length>0)await handle.append(body);await handle.flush()} finally {await handle.close()}
      }
      const before = await logBytes(root)
      expect(before.size).toBe(2)
      const actualReader=await releasedJsonlReaderSpec(ctx.sessionPersistence)
      if(actualReader===undefined)throw new Error('Released JSONL reader not resolved')
      Object.defineProperty(ctx.get('sessionPersistence'),'backgroundReaderSpec',{configurable:true,writable:true,value:()=>({
        ...actualReader,
        options:{...actualReader.options,providerModule:new URL('./fixtures/jsonl-observed-provider.mjs',import.meta.url).href},
      })})
      ledger = ctx.plugin(Ledger,{databasePath:join(temporary,'ledger.sqlite'),backfillPowerMode:'always',backfillPauseRssMiB:1048576})
      await ledger.await()
      await waitForHistory(ctx,2)
      expect(ctx.usageLedger.statusSnapshot()).toMatchObject({state:'idle',totalSessions:2,processedSessions:2})
      const snapshot=await ctx.usageLedger.snapshot({all:true,timeZone:'UTC'})
      expect(snapshot.models).toMatchObject([{requests:1,inputTokens:12,outputTokens:8}])
      await ledger.dispose()
      await writeFile(join(temporary,'log-opens.ndjson'),'')
      ledger=ctx.plugin(Ledger,{databasePath:join(temporary,'ledger.sqlite'),backfillPowerMode:'always',backfillPauseRssMiB:1048576})
      await ledger.await()
      await waitForHistory(ctx,2)
      const resumed=await ctx.usageLedger.snapshot({all:true,timeZone:'UTC'})
      expect(resumed.models).toEqual(snapshot.models)
      expect(await logBytes(root)).toEqual(before)
      const resumedProbe=await probeLines(temporary)
      expect(resumedProbe.filter(line=>line.kind==='open'), 'unchanged logs should not be decoded after a plugin restart').toEqual([])
      expect(resumedProbe.filter(line=>line.kind==='construct').length, 'one provider instance serves the whole pass instead of one per session').toBeLessThanOrEqual(2)
      expect(ctx.usageLedger.statusSnapshot()).toMatchObject({reusedSessions:2,processedEvents:0})

      await ledger.dispose()
      const writer=await ctx.sessionPersistence.open(SessionId('recent'),'write')
      try {
        await writer.append([{type:'step/end',seq:SessionSeq(3),time:now+3,data:{turn:1,step:1}}])
        await writer.flush()
      } finally {await writer.close()}
      await writeFile(join(temporary,'log-opens.ndjson'),'')
      ledger=ctx.plugin(Ledger,{databasePath:join(temporary,'ledger.sqlite'),backfillPowerMode:'always',backfillPauseRssMiB:1048576})
      await ledger.await()
      await waitForHistory(ctx,2)
      const changed=(await probeLines(temporary)).filter(line=>line.kind==='open').map(line=>line.id)
      expect(changed).toEqual(['recent'])
      expect(ctx.usageLedger.statusSnapshot()).toMatchObject({reusedSessions:1,processedEvents:1})
      expect((await ctx.usageLedger.snapshot({all:true,timeZone:'UTC'})).models).toEqual(snapshot.models)

      await ledger.dispose()
      const fresh=await ctx.sessionPersistence.create({id:SessionId('new'),version:SESSION_FORMAT_VERSION,createdAt:now+100,isSeeded:false})
      try {await fresh.flush()} finally {await fresh.close()}
      await writeFile(join(temporary,'log-opens.ndjson'),'')
      ledger=ctx.plugin(Ledger,{databasePath:join(temporary,'ledger.sqlite'),backfillPowerMode:'always',backfillPauseRssMiB:1048576})
      await ledger.await()
      await waitForHistory(ctx,3)
      const added=(await probeLines(temporary)).filter(line=>line.kind==='open').map(line=>line.id)
      expect(added).toEqual(['new'])
      expect(ctx.usageLedger.statusSnapshot()).toMatchObject({reusedSessions:2})
    } finally {
      await ledger?.dispose()
      await provider.dispose()
      await rm(temporary,{recursive:true,force:true})
    }
  })
})
