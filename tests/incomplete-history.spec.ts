import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {describe,expect,it} from 'vitest'
import type {} from '../lib/types/host/index.js'
// @ts-expect-error built Host entry
import Ledger from '../lib/index.js'

async function waitFor(predicate:()=>boolean) {
 const until=Date.now()+5000
 while(!predicate()){if(Date.now()>until)throw new Error('partial replay did not settle');await new Promise(resolve=>setTimeout(resolve,20))}
}

describe('Incomplete historical replay',()=>{
 it('retains failed state after the iterator finishes with unreadable sessions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ledger-incomplete-'))
  const ctx=new Context()
  const now=Date.now()-1000
  ctx.provide('sessions',{list:()=>[],get:()=>undefined} as never)
  ctx.provide('sessionPersistence',{list:async()=>[],backgroundReaderSpec:()=>({protocolVersion:1,supportsSessionListing:true,workerModule:fileURLToPath(new URL('./fixtures/partially-failing-reader.mjs',import.meta.url)),options:{sessions:JSON.stringify([{id:'readable',createdAt:now},{id:'unreadable',createdAt:now}]),events:JSON.stringify([{type:'request/context',seq:0,time:now,data:{provider:'test',model:'model'}},{type:'assistant/message',seq:1,time:now+1,data:{turn:0,step:0,usage:{inputTokens:2,outputTokens:1}}}])}})} as never)
  const fiber=ctx.plugin(Ledger,{databasePath:join(root,'ledger.sqlite'),backfillPowerMode:'always',backfillPauseRssMiB:1048576})
  try {
   await fiber.await()
   await waitFor(()=>ctx.usageLedger.statusSnapshot().lastError!==undefined&&ctx.usageLedger.statusSnapshot().processedSessions===1)
   const status=ctx.usageLedger.statusSnapshot()
   expect(status).toMatchObject({state:'failed',totalSessions:2,processedSessions:1})
   expect(status.lastError).toContain('stored log cannot be read')
   expect((await ctx.usageLedger.snapshot({all:true,timeZone:'UTC'})).models).toMatchObject([{requests:1,inputTokens:2,outputTokens:1}])
  }finally{await fiber.dispose();await rm(root,{recursive:true,force:true})}
 })
})
