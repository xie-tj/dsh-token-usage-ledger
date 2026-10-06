import { beforeEach, describe, expect, it, vi } from 'vitest'

const cssDisposer = vi.hoisted(() => vi.fn())
const cssInstall = vi.hoisted(() => vi.fn(() => cssDisposer))
const cardCssDisposer = vi.hoisted(() => vi.fn())
const cardCssInstall = vi.hoisted(() => vi.fn(() => cardCssDisposer))
vi.mock('../src/client/UsageDashboard.module.css', () => ({
  default: {},
  install: cssInstall,
}))
vi.mock('../src/client/UsagePluginCard.module.css', () => ({
  default: {},
  install: cardCssInstall,
}))

import { apply, inject } from '../src/client/index.ts'
import { UsageDashboard } from '../src/client/UsageDashboard.tsx'
import { UsagePluginCard } from '../src/client/UsagePluginCard.tsx'
import { UsageLedgerGlyph } from '../src/client/UsageLedgerGlyph.tsx'

interface Entry {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

interface Injection {
  readonly callback: () => () => void
  disposeEntry?: () => void
}

function bench(options: { remote?: boolean } = {}) {
  const entries: Entry[] = []
  const declarations = new Set<string>()
  const injections = new Map<string, Set<Injection>>()
  const effectDisposers: Array<() => void> = []
  const dictionaries = new Map<string, Record<string, string>>()
  let failedRegistration: string | undefined
  const remoteNamespace = {
    snapshot: vi.fn(async () => ({
      workspace: null,
      days: 30,
      all: false,
      fromDay: '2026-01-01',
      throughDay: '2026-01-30',
      timeZone: 'UTC',
      updatedAt: '2026-01-30T00:00:00.000Z',
      events: [],
      eventsTruncated: false,
      models: [],
      daily: [],
    })),
  }
  let remoteValue: typeof remoteNamespace | undefined = options.remote === false ? undefined : remoteNamespace
  const remote = {
    get usageLedgerPlugin(): never {
      throw new Error('optional Remote namespace was read through the injected property proxy')
    },
    $mount: vi.fn(async () => {
      remoteValue = remoteNamespace
      return vi.fn(async () => {
        remoteValue = undefined
      })
    }),
  }
  const locale = {
    register: vi.fn((namespace: string, values: { zh: Record<string, string> }) => {
      dictionaries.set(namespace, values.zh)
      return () => { dictionaries.delete(namespace) }
    }),
    bind: vi.fn((namespace: string) => (key: string) => dictionaries.get(namespace)?.[key] ?? key),
  }
  const activate = (injection: Injection): void => {
    if (injection.disposeEntry !== undefined) return
    injection.disposeEntry = injection.callback()
  }
  const slots = {
    inject: vi.fn((name: string, callback: () => () => void) => {
      const injection: Injection = { callback }
      const group = injections.get(name) ?? new Set<Injection>()
      injections.set(name, group)
      group.add(injection)
      try {
        if (declarations.has(name)) activate(injection)
      } catch (error) {
        group.delete(injection)
        throw error
      }
      return () => {
        injection.disposeEntry?.()
        injection.disposeEntry = undefined
        group.delete(injection)
      }
    }),
    register: vi.fn((options: Record<string, unknown>, component: unknown) => {
      if (options.name === failedRegistration) throw new Error(`failed ${String(options.name)}`)
      const entry: Entry = { options, component }
      entries.push(entry)
      return () => {
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
    }),
  }
  const logger = { warn: vi.fn() }
  const ctx = {
    remote,
    locale,
    slots,
    logger,
    get(name: string) {
      return name === 'remote.usageLedgerPlugin' ? remoteValue : undefined
    },
    effect(effect: () => (() => void) | undefined) {
      const disposer = effect()
      if (disposer !== undefined) effectDisposers.push(disposer)
    },
  }
  return {
    ctx,
    entries,
    remote,
    getRemote: () => remoteValue,
    locale,
    logger,
    declare(name: string) {
      declarations.add(name)
      for (const injection of injections.get(name) ?? []) activate(injection)
      return () => {
        declarations.delete(name)
        for (const injection of injections.get(name) ?? []) {
          injection.disposeEntry?.()
          injection.disposeEntry = undefined
        }
      }
    },
    failRegistration(name: string) {
      failedRegistration = name
    },
    async dispose(applyDisposer: () => Promise<void>) {
      await applyDisposer()
      for (const disposer of effectDisposers.splice(0).reverse()) disposer()
    },
  }
}

function entryNames(entries: readonly Entry[]): unknown[] {
  return entries.map(entry => entry.options.name).sort()
}

describe('Usage client apply', () => {
  beforeEach(() => {
    cssInstall.mockClear()
    cssDisposer.mockClear()
    cardCssInstall.mockClear()
    cardCssDisposer.mockClear()
  })

  it('registers the Settings section and its own bundle row once their slots are declared', async () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
    const b = bench()
    const applyDisposer = await apply(b.ctx as never)
    expect(cssInstall).toHaveBeenCalledOnce()
    expect(cardCssInstall).toHaveBeenCalledOnce()
    expect(b.entries).toHaveLength(0)

    b.declare('settings.section')
    b.declare('plugins.row.config')
    expect(entryNames(b.entries)).toEqual(['plugins.row.config', 'settings.section'])
    expect(b.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        component: UsageDashboard,
        options: expect.objectContaining({ id: 'usage', order: 20, locale: 'settings.usage' }),
      }),
      expect.objectContaining({
        component: UsagePluginCard,
        options: expect.objectContaining({
          key: 'dsh-plugin-usage-ledger#usage-ledger-plugin',
          locale: 'settings.usage',
        }),
      }),
    ]))
    // The Official group belongs to the official settings pages.
    expect(b.entries.some(entry => entry.options.name === 'plugins.item')).toBe(false)
    // The nav glyph seat is optional: a shell without it never declares the key.
    expect(entryNames(b.entries)).not.toContain('settings.section.glyph')
    b.declare('settings.section.glyph')
    expect(b.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        component: UsageLedgerGlyph,
        options: expect.objectContaining({ name: 'settings.section.glyph', key: 'usage' }),
      }),
    ]))
    expect(b.locale.bind('settings.usage')('nav')).toBe('用量')

    await b.dispose(applyDisposer)
    expect(b.entries).toHaveLength(0)
    expect(cssDisposer).toHaveBeenCalledOnce()
    expect(cardCssDisposer).toHaveBeenCalledOnce()
    expect(b.locale.bind('settings.usage')('nav')).toBe('nav')
  })

  it('supports slots declared after apply and collapses each contribution independently', async () => {
    const b = bench()
    const applyDisposer = await apply(b.ctx as never)
    expect(b.entries).toHaveLength(0)

    const collapseSection = b.declare('settings.section')
    expect(entryNames(b.entries)).toEqual(['settings.section'])
    const collapsePluginItem = b.declare('plugins.row.config')
    expect(entryNames(b.entries)).toEqual(['plugins.row.config', 'settings.section'])

    collapseSection()
    expect(entryNames(b.entries)).toEqual(['plugins.row.config'])
    b.declare('settings.section')
    expect(entryNames(b.entries)).toEqual(['plugins.row.config', 'settings.section'])
    collapsePluginItem()
    await b.dispose(applyDisposer)
    expect(b.entries).toHaveLength(0)
  })

  it('rolls back a partial display registration', async () => {
    const b = bench()
    b.declare('settings.section')
    b.declare('plugins.row.config')
    b.failRegistration('plugins.row.config')

    await expect(apply(b.ctx as never)).rejects.toThrow('failed plugins.row.config')
    expect(b.entries).toHaveLength(0)
  })

  it('does not mount a duplicate Remote namespace when Host already provides it', async () => {
    const b = bench()
    const applyDisposer = await apply(b.ctx as never)
    expect(b.remote.$mount).not.toHaveBeenCalled()
    await b.dispose(applyDisposer)
  })

  it('mounts and retires its generated Remote namespace when needed', async () => {
    const b = bench({ remote: false })
    const applyDisposer = await apply(b.ctx as never)
    expect(b.remote.$mount).toHaveBeenCalledOnce()
    expect(b.getRemote()).toBeDefined()
    await b.dispose(applyDisposer)
    expect(b.getRemote()).toBeUndefined()
  })
})
