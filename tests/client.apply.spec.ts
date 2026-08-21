import { beforeEach, describe, expect, it, vi } from 'vitest'

const cssDisposer = vi.hoisted(() => vi.fn())
const cssInstall = vi.hoisted(() => vi.fn(() => cssDisposer))
vi.mock('../src/client/UsageDashboard.module.css', () => ({
  default: {},
  install: cssInstall,
}))

import { apply, inject } from '../src/client/index.ts'
import { UsageDashboard } from '../src/client/UsageDashboard.tsx'

interface Entry {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

function bench() {
  const entries: Entry[] = []
  let injected: (() => () => void) | undefined
  let removeInjected: (() => void) | undefined
  const effectDisposers: Array<() => void> = []
  const dictionaries = new Map<string, Record<string, string>>()
  const remoteNamespace = {
    snapshot: vi.fn(async () => ({
      workspace: null,
      days: 30,
      fromDay: '2026-01-01',
      throughDay: '2026-01-30',
      timeZone: 'UTC',
      updatedAt: '2026-01-30T00:00:00.000Z',
      events: [],
      models: [],
      daily: [],
    })),
  }
  const remote = {
    usageLedgerPlugin: remoteNamespace,
    $mount: vi.fn(async () => vi.fn(async () => {})),
  }
  const locale = {
    register: vi.fn((namespace: string, values: { zh: Record<string, string> }) => {
      dictionaries.set(namespace, values.zh)
      return () => { dictionaries.delete(namespace) }
    }),
    bind: vi.fn((namespace: string) => (key: string) => dictionaries.get(namespace)?.[key] ?? key),
  }
  const slots = {
    inject: vi.fn((_name: string, callback: () => () => void) => {
      injected = callback
      removeInjected = () => {
        injected = undefined
      }
      return removeInjected
    }),
    register: vi.fn((options: Record<string, unknown>, component: unknown) => {
      const entry: Entry = { options, component }
      entries.push(entry)
      return () => {
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
    }),
  }
  const ctx = {
    remote,
    locale,
    slots,
    effect(effect: () => (() => void) | undefined) {
      const disposer = effect()
      if (disposer !== undefined) effectDisposers.push(disposer)
    },
  }
  return {
    ctx,
    entries,
    remote,
    locale,
    declare: () => injected?.(),
    async dispose(applyDisposer: () => Promise<void>) {
      await applyDisposer()
      removeInjected?.()
      for (const disposer of effectDisposers.splice(0)) disposer()
    },
  }
}

describe('Usage client apply', () => {
  beforeEach(() => {
    cssInstall.mockClear()
    cssDisposer.mockClear()
  })

  it('declares services and registers the Usage section after a late slot declaration', async () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
    const b = bench()
    const applyDisposer = await apply(b.ctx as never)
    expect(cssInstall).toHaveBeenCalledOnce()
    expect(b.entries).toHaveLength(0)

    const removeEntry = b.declare()
    expect(removeEntry).toBeTypeOf('function')
    expect(b.entries).toHaveLength(1)
    expect(b.entries[0]).toMatchObject({
      component: UsageDashboard,
      options: { id: 'usage', order: 20, locale: 'settings.usage' },
    })
    expect(b.locale.bind('settings.usage')('nav')).toBe('用量')

    removeEntry?.()
    expect(b.entries).toHaveLength(0)
    await b.dispose(applyDisposer)
    expect(cssDisposer).toHaveBeenCalledOnce()
  })

  it('removes dictionaries and slot injection on HMR disposal', async () => {
    const b = bench()
    const applyDisposer = await apply(b.ctx as never)
    const removeEntry = b.declare()
    expect(b.entries).toHaveLength(1)
    await b.dispose(applyDisposer)
    expect(cssDisposer).toHaveBeenCalledOnce()
    removeEntry?.()
    expect(b.entries).toHaveLength(0)
    expect(b.locale.bind('settings.usage')('nav')).toBe('nav')
  })

  it('does not mount a duplicate Remote namespace when Host already provides it', async () => {
    const b = bench()
    const applyDisposer = await apply(b.ctx as never)
    expect(b.remote.$mount).not.toHaveBeenCalled()
    await b.dispose(applyDisposer)
  })
})
