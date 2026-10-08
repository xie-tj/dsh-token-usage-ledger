// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageDashboard } from '../src/client/UsageDashboard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { UsageLedgerSnapshot, UsageLedgerStatus } from '../src/host/types.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../src/client/UsageDashboard.module.css', () => ({ default: {}, install: vi.fn(() => vi.fn()) }))

const snapshot: UsageLedgerSnapshot = { workspace: null, days: 1, all: true, fromDay: '2026-10-06', throughDay: '2026-10-06', timeZone: 'UTC', updatedAt: '2026-10-06T15:00:00Z', events: [], eventsTruncated: false, models: [], daily: [] }
const progress: UsageLedgerStatus = { state: 'running', totalSessions: 4, processedSessions: 1, processedEvents: 12345, backfillDays: 30, backfillScope: 'all', updatedAt: '2026-10-06T15:00:00Z', pace: {mode:'run',delayMs:150,workShare:0.25} }
let root: Root | undefined
let container: HTMLDivElement | undefined

async function mount(status: UsageLedgerStatus | (() => Promise<UsageLedgerStatus>), options: {loading?: boolean; english?: boolean} = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const dictionary: Readonly<Record<string, string>> = options.english ? en : zh
  const readStatus = typeof status === 'function' ? status : async () => status
  await act(async () => {
    root?.render(<UsageDashboard t={key => dictionary[key] ?? key} readSnapshot={options.loading ? () => new Promise(() => {}) : async () => snapshot} readStatus={readStatus} />)
  })
  return container
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.useRealTimers()
})

describe('Background accounting presentation', () => {
  it('separates the running state, session progress, events, and remaining work', async () => {
    const view = await mount(progress)
    const panel = view.querySelector('[role="region"][aria-label="后台统计"]')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('统计中')
    expect(panel?.textContent).toContain('1 / 4')
    expect(panel?.textContent).toContain('12,345')
    const meter = panel?.querySelector('[role="progressbar"]')
    expect(meter?.getAttribute('aria-label')).toBe('会话扫描进度')
    expect(meter?.getAttribute('aria-valuenow')).toBe('25')
    expect(panel?.textContent).toContain('25%')
    expect(panel?.textContent).toContain('待处理会话')
  })

  it.each(['event-loop','memory','battery'] as const)('keeps progress visible when paused for %s', async reason => {
    const view = await mount({...progress,state:'paused',pace:{mode:'pause',delayMs:15000,workShare:0.1,reason}})
    const panel = view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('已暂停')
    expect(panel?.textContent).toContain(reason === 'event-loop' ? '主线程繁忙' : reason === 'memory' ? '内存压力' : '电池供电')
    expect(panel?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25')
    expect(panel?.textContent).toContain('1 / 4')
  })

  it('does not claim an unexplained pause after the governor has permitted replay to resume', async () => {
    const view=await mount({...progress,state:'paused',pace:{mode:'run',delayMs:450,workShare:0.1}})
    const panel=view.querySelector('[role="region"]')
    expect(panel?.textContent).not.toContain('历史回填已暂停，已有统计仍可查看')
    expect(panel?.textContent).toContain('恢复统计中')
  })

  it('does not label completed history as paused when resource pacing changes later', async () => {
    const view=await mount({...progress,state:'paused',processedSessions:4,pace:{mode:'pause',delayMs:15000,workShare:0.1,reason:'memory'}})
    const panel=view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('历史统计已完成')
    expect(panel?.textContent).not.toContain('已有统计仍可查看')
  })

  it('does not conceal a paused reader error just because pacing permits work or progress is complete', async () => {
    const view=await mount({...progress,state:'paused',processedSessions:4,lastError:'reader unavailable',pace:{mode:'run',delayMs:0,workShare:0.25}})
    expect(view.querySelector('[role="region"]')?.textContent).toContain('reader unavailable')
    expect(view.querySelector('[role="region"]')?.textContent).not.toContain('恢复统计中')
  })

  it('does not call partially scanned history unstarted when the worker reports idle', async () => {
    const view=await mount({...progress,state:'idle',totalSessions:3127,processedSessions:1977,processedEvents:715421,reusedSessions:1})
    const panel=view.querySelector('[role="region"]')
    expect(panel?.textContent).not.toContain('尚未开始历史扫描')
    expect(panel?.textContent).toContain('历史扫描未完成')
  })

  it('shows a retained reader error instead of an unstarted state after a partial scan', async () => {
    const view=await mount({...progress,state:'idle',totalSessions:3127,processedSessions:1977,processedEvents:715421,lastError:'session example: stored log cannot be read'})
    const panel=view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('stored log cannot be read')
    expect(panel?.textContent).not.toContain('尚未开始历史扫描')
  })

  it('uses indeterminate progress until the worker has discovered the session count', async () => {
    const view = await mount({...progress,totalSessions:0,processedSessions:0,processedEvents:0})
    const panel = view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('正在扫描会话')
    expect(panel?.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false)
    expect(panel?.textContent).not.toContain('100%')
  })

  it('distinguishes an idle empty ledger from completed historical replay', async () => {
    const view = await mount({...progress,state:'idle',totalSessions:0,processedSessions:0})
    expect(view.querySelector('[role="region"]')?.textContent).toContain('等待统计')
    expect(view.querySelector('[role="region"]')?.textContent).not.toContain('历史统计已完成')
  })

  it('shows completion at 100 percent without overflowing the progress range', async () => {
    const view = await mount({...progress,state:'idle',processedSessions:5})
    const panel = view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('历史统计已完成')
    expect(panel?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
  })

  it('shows a recoverable error and keeps the last progress counters', async () => {
    const view = await mount({...progress,state:'failed',lastError:'SQLite temporarily unavailable'})
    const panel = view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('统计异常')
    expect(panel?.textContent).toContain('SQLite temporarily unavailable')
    expect(panel?.textContent).toContain('1 / 4')
  })

  it('renders the status panel even while the snapshot is still loading', async () => {
    const view = await mount(progress,{loading:true})
    expect(view.querySelector('h2')?.textContent).toBe('用量账本')
    expect(view.querySelector('[role="region"]')?.textContent).toContain('统计中')
    expect(view.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25')
  })

  it('updates from paused to running on the existing status poll', async () => {
    vi.useFakeTimers()
    let current: UsageLedgerStatus = {...progress,state:'paused',pace:{mode:'pause',delayMs:15000,workShare:0.1,reason:'event-loop'}}
    const view = await mount(async () => current)
    expect(view.querySelector('[role="region"]')?.textContent).toContain('已暂停')
    current = {...progress,processedSessions:2}
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(view.querySelector('[role="region"]')?.textContent).toContain('统计中')
    expect(view.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
  })

  it('keeps the last successful progress visible when a later status poll fails', async () => {
    vi.useFakeTimers()
    let fail = false
    const view = await mount(async () => { if(fail)throw new Error('offline');return progress })
    fail = true
    await act(async () => {await vi.advanceTimersByTimeAsync(2000)})
    const panel=view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('暂时无法刷新进度')
    expect(panel?.textContent).toContain('1 / 4')
  })

  it('explains restored results without treating the current-run event count as a lost ledger', async () => {
    const view=await mount({...progress,state:'idle',processedSessions:4,processedEvents:0,reusedSessions:4})
    const panel=view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('已从持久化检查点跳过 4 个未变会话')
    expect(panel?.textContent).toContain('本轮处理事件')
  })

  it('shows a persisted all-reused history as complete with zero queued sessions', async () => {
    const view=await mount({...progress,state:'idle',historyComplete:true,discoveredSessions:200,totalSessions:0,processedSessions:0,processedEvents:0,reusedSessions:200})
    const panel=view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('历史统计已完成')
    expect(panel?.textContent).toContain('0 / 0')
    expect(panel?.textContent).toContain('跳过 200 个未变会话')
    expect(panel?.textContent).not.toContain('尚未开始')
    expect(panel?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
  })

  it('shows an unavailable state instead of making up progress', async () => {
    const view = await mount(async () => {throw new Error('offline')})
    const panel=view.querySelector('[role="region"]')
    expect(panel?.textContent).toContain('状态暂不可用')
    expect(panel?.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('uses the English dictionary for every status and progress label', async () => {
    const view = await mount(progress,{english:true})
    const panel=view.querySelector('[role="region"][aria-label="Background accounting"]')
    expect(panel?.textContent).toContain('Running')
    expect(panel?.textContent).toContain('Sessions scanned this run')
    expect(panel?.textContent).toContain('Events processed this run')
    expect(panel?.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('Session scan progress')
  })
})
