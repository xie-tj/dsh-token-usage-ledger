// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { UsageDashboard } from '../src/client/UsageDashboard.tsx'
import { UsagePluginCard } from '../src/client/UsagePluginCard.tsx'
import type { UsageLedgerSnapshot } from '../src/types.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/client/UsageDashboard.module.css', () => ({
  default: {},
  install: vi.fn(() => vi.fn()),
}))
vi.mock('../src/client/UsagePluginCard.module.css', () => ({ default: {} }))

const snapshot: UsageLedgerSnapshot = {
  workspace: null,
  days: 1,
  fromDay: '2026-01-01',
  throughDay: '2026-01-01',
  timeZone: 'UTC',
  updatedAt: '2026-01-01T12:00:00.000Z',
  events: [{
    at: Date.UTC(2026, 0, 1, 12),
    workspace: null,
    provider: 'deepseek',
    model: 'chat',
    outcome: 'success',
    retried: false,
    inputTokens: 7,
    outputTokens: 11,
    cacheReadTokens: 13,
    cacheWriteTokens: 17,
  }],
  models: [{
    workspace: null,
    provider: 'deepseek',
    model: 'chat',
    inputTokens: 7,
    outputTokens: 11,
    cacheReadTokens: 13,
    cacheWriteTokens: 17,
    requests: 1,
    successfulRequests: 1,
    failedRequests: 0,
    retryRequests: 0,
    meteredRequests: 1,
    unmeteredRequests: 0,
  }],
  daily: [{
    day: '2026-01-01',
    inputTokens: 7,
    outputTokens: 11,
    cacheReadTokens: 13,
    cacheWriteTokens: 17,
    requests: 1,
    successfulRequests: 1,
    failedRequests: 0,
    retryRequests: 0,
    meteredRequests: 1,
    unmeteredRequests: 0,
  }],
}

const manyRequests = 10_001
const highVolumeSnapshot: UsageLedgerSnapshot = {
  ...snapshot,
  events: Array.from({ length: manyRequests }, (_, index) => ({
    ...snapshot.events[0],
    at: snapshot.events[0].at + index,
  })),
  models: snapshot.models.map(row => ({ ...row, requests: manyRequests, successfulRequests: manyRequests })),
  daily: snapshot.daily.map(row => ({ ...row, requests: manyRequests, successfulRequests: manyRequests })),
}

describe('Usage dashboard GUI', () => {
  it('renders model data and refreshes through the visible controls', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const readSnapshot = vi.fn(async () => highVolumeSnapshot)
    const translate = (key: string) => key

    try {
      await act(async () => {
        root.render(<UsageDashboard readSnapshot={readSnapshot} t={translate as never} />)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(readSnapshot).toHaveBeenCalledOnce()
      expect(container.textContent).toContain('chat')
      expect(container.textContent).not.toContain('deepseek / chat')
      expect(container.textContent).toContain('modelBreakdown')
      expect(container.textContent).toContain('tableCacheHit')
      expect(container.textContent).toContain('13')
      expect([...container.querySelectorAll('thead th')].map(header => header.textContent)).toEqual([
        'tableModel', 'tableTotal', 'tableInput', 'tableOutput', 'tableCacheHit', 'tableRequests', 'tableFailed', 'tableRetries',
      ])
      expect(container.textContent).toContain(String(manyRequests))
      expect(container.textContent).toContain('10K')
      expect(container.textContent).not.toContain('1万')
      expect(container.textContent).not.toContain('allTime')
      const selects = [...container.querySelectorAll('select')]
      expect(selects).toHaveLength(3)
      expect([...selects[0].querySelectorAll('option')].map(option => option.textContent)).toEqual(['allProviders', 'deepseek'])
      expect([...selects[1].querySelectorAll('option')].map(option => option.textContent)).toEqual(['allModels', 'chat'])
      expect(container.textContent).toContain('showProvider')
      const showProvider = container.querySelector('input[type="checkbox"]')
      expect(showProvider).not.toBeNull()
      expect((showProvider as HTMLInputElement).checked).toBe(false)
      await act(async () => { (showProvider as HTMLInputElement).click(); await Promise.resolve() })
      expect(container.textContent).toContain('deepseek / chat')

      const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === 'refresh')
      expect(refresh).toBeDefined()
      await act(async () => {
        refresh?.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(readSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  }, 30_000)

  it('shows the selected day total in the token bar label and tooltip', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const readSnapshot = vi.fn(async () => snapshot)
    const translate = (key: string) => key === 'tokensOn' ? 'tokensOn：输入 {input}，输出 {output}，缓存 {cached}，总计 {total}' : key

    try {
      await act(async () => {
        root.render(<UsageDashboard readSnapshot={readSnapshot} t={translate as never} />)
        await Promise.resolve()
        await Promise.resolve()
      })
      const tokenBar = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.includes('输入 7'))
      expect(tokenBar).toBeDefined()
      expect(tokenBar?.getAttribute('aria-label')).toContain('总计 48')

      await act(async () => { tokenBar?.focus() })
      expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('总计 48')
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })

  it('loads the dashboard only after its Plugins card expands', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const readSnapshot = vi.fn(async () => snapshot)
    const translate = (key: string) => key

    try {
      await act(async () => {
        root.render(
          <UsagePluginCard
            readSnapshot={readSnapshot}
            t={translate as never}
            useSessions={vi.fn() as never}
            useWorkspaces={vi.fn() as never}
          />,
        )
      })
      const toggle = container.querySelector('button')
      expect(toggle?.getAttribute('aria-expanded')).toBe('false')
      expect(container.textContent).toContain('title')
      expect(container.textContent).toContain('intro')
      expect(readSnapshot).not.toHaveBeenCalled()

      await act(async () => {
        toggle?.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(toggle?.getAttribute('aria-expanded')).toBe('true')
      expect(readSnapshot).toHaveBeenCalledOnce()
      expect(container.textContent).toContain('chat')
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })
})
