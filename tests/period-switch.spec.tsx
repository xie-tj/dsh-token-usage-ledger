// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageDashboard } from '../src/client/UsageDashboard.tsx'
import { zh } from '../src/client/locales.ts'
import type { UsageLedgerSnapshot, UsageLedgerSnapshotRequest } from '../src/types.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../src/client/UsageDashboard.module.css', () => ({default:{},install:vi.fn(()=>vi.fn())}))

function snapshot(requests: number, all = false, days = 7): UsageLedgerSnapshot {
  return {
    workspace:null,all,days,fromDay:'2026-07-10',throughDay:'2026-10-07',timeZone:'UTC',updatedAt:'2026-10-07T00:00:00.000Z',events:[],eventsTruncated:false,
    models:[{workspace:null,provider:'deepseek',model:'chat',requests,successfulRequests:requests,failedRequests:0,retryRequests:0,meteredRequests:requests,unmeteredRequests:0,inputTokens:requests*100,outputTokens:requests*10,cacheReadTokens:0,cacheWriteTokens:0}],
    daily:[{day:'2026-10-07',requests,successfulRequests:requests,failedRequests:0,retryRequests:0,meteredRequests:requests,unmeteredRequests:0,inputTokens:requests*100,outputTokens:requests*10,cacheReadTokens:0,cacheWriteTokens:0}],
  }
}

function deferred<T>() {
  let resolve!: (value:T)=>void
  let reject!: (error:Error)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
let root: Root | undefined
let view: HTMLDivElement | undefined
const dictionary: Readonly<Record<string,string>> = zh
async function mount(readSnapshot:(request:UsageLedgerSnapshotRequest)=>Promise<UsageLedgerSnapshot>) {
  view=document.createElement('div')
  document.body.append(view)
  root=createRoot(view)
  await act(async()=>{root?.render(<UsageDashboard t={key=>dictionary[key]??key} readSnapshot={readSnapshot} />)})
  return view
}
function requestsText(container:HTMLElement) {
  const label=[...container.querySelectorAll('span')].find(node=>node.textContent===zh.requests)
  return label?.parentElement?.querySelector('strong')?.textContent
}
async function choose(container:HTMLElement,label:string) {
  const select=[...container.querySelectorAll('select')].find(element=>[...element.options].some(option=>option.textContent===zh.allTime))
  if(!select)throw new Error('time-range control disappeared')
  const option=[...select.options].find(item=>item.textContent===label)
  if(!option)throw new Error('time-range option not found')
  await act(async()=>{select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}))})
}
afterEach(async()=>{await act(async()=>root?.unmount());view?.remove();root=undefined;view=undefined})

describe('Time-range switching',()=>{
  it('keeps sequential all / 7 / 30 / all totals aligned with the requested range',async()=>{
    const read=vi.fn(async(request:UsageLedgerSnapshotRequest)=>request.all?snapshot(9001,true,90):snapshot(request.days===7?7:30,false,request.days))
    const container=await mount(read)
    expect(read.mock.calls[0][0].all).toBe(true)
    expect(requestsText(container)).toBe('9001')
    await choose(container,zh.sevenDays)
    expect(read.mock.calls.at(-1)?.[0].days).toBe(7)
    expect(requestsText(container)).toBe('7')
    await choose(container,zh.thirtyDays)
    expect(read.mock.calls.at(-1)?.[0].days).toBe(30)
    expect(requestsText(container)).toBe('30')
    await choose(container,zh.allTime)
    expect(read.mock.calls.at(-1)?.[0].all).toBe(true)
    expect(requestsText(container)).toBe('9001')
  })

  it('does not display a 7-day snapshot as all-history data while all history loads',async()=>{
    const pending=deferred<UsageLedgerSnapshot>()
    let allCalls=0
    const container=await mount(async request=>request.all?(++allCalls===1?snapshot(9001,true,90):pending.promise):snapshot(7))
    await choose(container,zh.sevenDays)
    expect(requestsText(container)).toBe('7')
    await choose(container,zh.allTime)
    expect(requestsText(container)).not.toBe('7')
    expect(container.textContent).not.toContain(zh.allHistoryCharts)
    expect(container.querySelectorAll('select')).toHaveLength(3)
    await act(async()=>pending.resolve(snapshot(9001,true,90)))
    expect(requestsText(container)).toBe('9001')
  })

  it('does not label the last 7-day result as all history after an all-history request fails',async()=>{
    let allCalls=0
    const container=await mount(async request=>{if(request.all&&++allCalls>1)throw new Error('all-history request failed');return request.all?snapshot(9001,true,90):snapshot(7)})
    await choose(container,zh.sevenDays)
    expect(requestsText(container)).toBe('7')
    await choose(container,zh.allTime)
    expect(container.textContent).toContain(zh.loadFailed)
    expect(requestsText(container)).not.toBe('7')
    expect(container.textContent).not.toContain(zh.allHistoryCharts)
    expect(container.querySelectorAll('select')).toHaveLength(3)
  })

  it('keeps all-history chart captions aligned with their visible 30-day series',async()=>{
    const full=snapshot(900,true,90)
    const base=full.daily[0]
    const daily=Array.from({length:90},(_,index)=>({...base,day:new Date(Date.UTC(2026,6,10+index)).toISOString().slice(0,10),requests:10,successfulRequests:10,meteredRequests:10,inputTokens:1000,outputTokens:100}))
    const container=await mount(async()=>({...full,daily}))
    expect(requestsText(container)).toBe('900')
    const requestChart=[...container.querySelectorAll('h3')].find(node=>node.textContent===zh.requestCurve)?.parentElement
    const tokenChart=[...container.querySelectorAll('h3')].find(node=>node.textContent===zh.tokenFlow)?.parentElement
    expect(requestChart?.querySelector('span')?.textContent).toBe('300')
    expect(tokenChart?.querySelector('span')?.textContent).toBe('33,000')
  })

  it('retains the last good snapshot only when a refresh fails in the same range',async()=>{
    let calls=0
    const container=await mount(async()=>{if(++calls>1)throw new Error('refresh failed');return snapshot(9001,true,90)})
    const refresh=[...container.querySelectorAll('button')].find(button=>button.textContent===zh.refresh)
    await act(async()=>refresh?.click())
    expect(requestsText(container)).toBe('9001')
    expect(container.textContent).toContain(zh.showingLastGood)
    expect(container.textContent).toContain(zh.allHistoryCharts)
  })

  it.each(['provider','model'] as const)('does not reuse all-filter totals while the %s filter changes',async filter=>{
    const pending=deferred<UsageLedgerSnapshot>()
    const mixed=snapshot(9001,true,90)
    const second={...mixed.models[0],provider:filter==='provider'?'openai':'deepseek',model:filter==='model'?'reasoner':'chat',requests:999,successfulRequests:999,meteredRequests:999}
    const container=await mount(async request=>request[filter]===undefined?{...mixed,models:[...mixed.models,second]}:pending.promise)
    expect(requestsText(container)).toBe('10000')
    const select=container.querySelectorAll('select')[filter==='provider'?0:1]
    await act(async()=>{select.value=filter==='provider'?'openai':'reasoner';select.dispatchEvent(new Event('change',{bubbles:true}))})
    expect(requestsText(container)).not.toBe('10000')
    expect(container.querySelectorAll('select')).toHaveLength(3)
    await act(async()=>pending.resolve({...snapshot(999,true,90),models:[second]}))
    expect(requestsText(container)).toBe('999')
  })

  it('ignores a slow all-history response after the user selects 7 days',async()=>{
    const slow=deferred<UsageLedgerSnapshot>()
    let allCalls=0
    const container=await mount(async request=>request.all?(++allCalls===1?snapshot(9001,true,90):slow.promise):snapshot(7))
    await choose(container,zh.sevenDays)
    await choose(container,zh.allTime)
    await choose(container,zh.sevenDays)
    expect(requestsText(container)).toBe('7')
    await act(async()=>slow.resolve(snapshot(123456,true,90)))
    expect(requestsText(container)).toBe('7')
  })
})
