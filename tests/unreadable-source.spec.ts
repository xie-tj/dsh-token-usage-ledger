import {mkdtemp,readFile,rm} from 'node:fs/promises'
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
 while(!predicate()){if(Date.now()>until)throw new Error('unreadable-source replay did not settle');await new Promise(resolve=>setTimeout(resolve,20))}
}

async function readAttempts(probe:string):Promise<readonly string[]> {
 try {
  const lines=(await readFile(probe,'utf8')).split('\n').filter(line=>line.length>0)
  return lines.map(line=>(JSON.parse(line) as {id:string}).id)
 } catch {return []}
}

function fixtureContext(readerSpec:unknown):Context {
 const ctx=new Context()
 ctx.provide('sessions',{list:()=>[],get:()=>undefined} as never)
 ctx.provide('sessionPersistence',{list:async()=>[],backgroundReaderSpec:()=>readerSpec} as never)
 return ctx
}

describe('Unreadable stored generations',()=>{
 it('settles a refused generation once and completes the pass for everything readable',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ledger-unreadable-'))
  const databasePath=join(root,'ledger.sqlite')
  const probe=join(root,'reads.ndjson')
  const now=Date.now()-1000
  const readerSpec={protocolVersion:1,supportsSessionListing:true,workerModule:fileURLToPath(new URL('./fixtures/refusing-reader.mjs',import.meta.url)),options:{sessions:JSON.stringify([{id:'readable',createdAt:now},{id:'refused',createdAt:now}]),events:JSON.stringify([{type:'request/context',seq:0,time:now,data:{provider:'test',model:'model'}},{type:'assistant/message',seq:1,time:now+1,data:{turn:0,step:0,usage:{inputTokens:2,outputTokens:1}}}]),probe}}
  const ctx=fixtureContext(readerSpec)
  const fiber=ctx.plugin(Ledger,{databasePath,backfillPowerMode:'always',backfillPauseRssMiB:1048576})
  try {
   await fiber.await()
   await waitFor(()=>ctx.usageLedger.statusSnapshot().historyComplete===true)
   const status=ctx.usageLedger.statusSnapshot()
   // A refused generation is not a failure: the pass completes and only the readable session counts.
   expect(status).toMatchObject({state:'idle',totalSessions:2,processedSessions:1,failedSessions:0,unreadableSessions:1,historyComplete:true})
   expect(status.lastError).toBeUndefined()
   expect(status.unreadableReason).toContain('source v0 artifact remains unchanged')
   expect((await ctx.usageLedger.snapshot({all:true,timeZone:'UTC'})).models).toMatchObject([{requests:1,inputTokens:2,outputTokens:1}])
   expect(await readAttempts(probe)).toEqual(['readable','refused'])
  }finally{await fiber.dispose()}
  const second=fixtureContext(readerSpec)
  const secondFiber=second.plugin(Ledger,{databasePath,backfillPowerMode:'always',backfillPauseRssMiB:1048576})
  try {
   await secondFiber.await()
   await waitFor(()=>second.usageLedger.statusSnapshot().historyComplete===true)
   // The refusal is remembered per source revision, so a restart never decodes that log again.
   expect(second.usageLedger.statusSnapshot()).toMatchObject({state:'idle',totalSessions:0,processedSessions:0,reusedSessions:1,failedSessions:0,unreadableSessions:1,historyComplete:true})
   expect(await readAttempts(probe)).toEqual(['readable','refused'])
  }finally{await secondFiber.dispose();await rm(root,{recursive:true,force:true})}
 })
})
