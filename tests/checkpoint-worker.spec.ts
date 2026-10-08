import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe,expect,it } from 'vitest'
import type {} from '../lib/types/host/index.js'
// @ts-expect-error packed Host entry has declarations in its types export
import Ledger from '../lib/index.js'

async function waitFor(predicate:()=>boolean) {
  const deadline=Date.now()+5000
  while(!predicate()){if(Date.now()>deadline)throw new Error('checkpoint worker did not settle');await new Promise(resolve=>setTimeout(resolve,20))}
}
async function scenario(options:{drift:boolean;interrupt:boolean}) {
  const root=await mkdtemp(join(tmpdir(),'usage-checkpoint-worker-'))
  const probe=join(root,'reads.ndjson')
  const ctx=new Context()
  const id=SessionId('checkpoint-session')
  const now=Date.now()
  let fingerprint='before'
  let drift=options.drift,interrupt=options.interrupt
  const events=[{type:'request/context',seq:0,time:now,data:{provider:'test',model:'model'}},{type:'assistant/message',seq:1,time:now+1,data:{turn:0,step:0,usage:{inputTokens:2,outputTokens:1}}}]
  ctx.provide('sessions',{list:()=>[],get:()=>undefined} as never)
  ctx.provide('sessionPersistence',{list:async()=>[{header:{id,createdAt:now,version:0,isSeeded:false}}],backgroundReaderSpec:()=>({protocolVersion:1,workerModule:fileURLToPath(new URL('./fixtures/checkpoint-reader.mjs',import.meta.url)),options:{probe,drift,interrupt,fingerprint,events:JSON.stringify(events)}})} as never)
  let fiber:ReturnType<typeof ctx.plugin>|undefined
  const start=async()=>{fiber=ctx.plugin(Ledger,{databasePath:join(root,'ledger.sqlite'),backfillPowerMode:'always',backfillPauseRssMiB:1048576});await fiber.await()}
  try {
    await start()
    if(interrupt)await waitFor(()=>ctx.usageLedger.statusSnapshot().lastError?.includes('interrupted')===true)
    else await waitFor(()=>ctx.usageLedger.statusSnapshot().state==='idle'&&ctx.usageLedger.statusSnapshot().processedSessions===1)
    await fiber?.dispose()
    await writeFile(probe,'')
    if(drift)fingerprint='after'
    drift=false;interrupt=false
    await start()
    await waitFor(()=>ctx.usageLedger.statusSnapshot().state==='idle'&&ctx.usageLedger.statusSnapshot().historyComplete===true)
    const reads=(await readFile(probe,'utf8')).trim()
    const snapshot=await ctx.usageLedger.snapshot({all:true,timeZone:'UTC'})
    expect(snapshot.models).toMatchObject([{requests:1,inputTokens:2,outputTokens:1}])
    return reads
  } finally {await fiber?.dispose();await rm(root,{recursive:true,force:true})}
}

describe('Completed-source checkpoint ownership',()=>{
  it('reuses only a stable source that reached EOF',async()=>{expect(await scenario({drift:false,interrupt:false})).toBe('')})
  it('reopens a source that changed during its completed replay',async()=>{expect(await scenario({drift:true,interrupt:false})).not.toBe('')})
  it('does not mark a partial failed replay as complete',async()=>{expect(await scenario({drift:false,interrupt:true})).not.toBe('')})
})
