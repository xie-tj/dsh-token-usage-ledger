import { beforeEach, describe, expect, it, vi } from 'vitest'

const cssDisposer = vi.hoisted(() => vi.fn())
const cssInstall = vi.hoisted(() => vi.fn(() => cssDisposer))
vi.mock('../src/client/UsageDashboard.module.css', () => ({
  default: {},
  install: cssInstall,
}))

import { apply, inject } from '../src/client/index.ts'
import { UsageDashboard } from '../src/client/UsageDashboard.tsx'
import { UsagePluginCard } from '../src/client/UsagePluginCard.tsx'

interface Entry {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

interface Injection {
  readonly callback: () => () => void
  disposeEntry?: () => void
}

function bench(options: { served?: boolean; remote?: boolean; ensure?: Promise<void> } = {}) {
  const entries: Entry[] = []
  const declarations = new Set<string>()
  const injections = new Map<string, Set<Injection>>()
  const effectDisposers: Array<() => void> = []
  const dictionaries = new Map<string, Record<string, string>>()
  const describeListeners = new Set<() => void>()
  let served = options.served ?? false
  let failedRegistration: string | undefined
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
  const remote: {
    usageLedgerPlugin?: typeof remoteNamespace
    $mount: ReturnType<typeof vi.fn>
  } = {
    usageLedgerPlugin: options.remote === false ? undefined : remoteNamespace,
    $mount: vi.fn(async () => {
      remote.usageLedgerPlugin = remoteNamespace
      return vi.fn(async () => {
        remote.usageLedgerPlugin = undefined
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
  const settingsScope = {
    describe: vi.fn(() => ({
      getSnapshot: () => ({
        view: { namespaces: served ? [{ ns: 'usage-ledger' }] : [] },
      }),
      subscribe: (listener: () => void) => {
        describeListeners.add(listener)
        return () => { describeListeners.delete(listener) }
      },
      ensure: vi.fn(() => options.ensure ?? Promise.resolve()),
    })),
  }
  const logger = { warn: vi.fn() }
  const ctx = {
    remote,
    locale,
    slots,
    settingsScope,
    logger,
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
    setServed(value: boolean) {
      served = value
      for (const listener of describeListeners) listener()
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
  })

  it('follows Host namespace availability without duplicate display contributions', async () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'settingsScope'])
    const b = bench()
    b.declare('settings.section')
    b.declare('settings.plugin.item')
    const applyDisposer = await apply(b.ctx as never)
    expect(cssInstall).toHaveBeenCalledOnce()
    expect(b.entries).toHaveLength(0)

    b.setServed(true)
    expect(entryNames(b.entries)).toEqual(['settings.plugin.item', 'settings.section'])
    expect(b.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        component: UsageDashboard,
        options: expect.objectContaining({ id: 'usage', order: 20, locale: 'settings.usage' }),
      }),
      expect.objectContaining({
        component: UsagePluginCard,
        options: expect.objectContaining({ key: 'usage-ledger', locale: 'settings.usage' }),
      }),
    ]))
    expect(b.locale.bind('settings.usage')('nav')).toBe('用量')

    b.setServed(true)
    expect(b.entries).toHaveLength(2)
    b.setServed(false)
    expect(b.entries).toHaveLength(0)
    b.setServed(true)
    expect(b.entries).toHaveLength(2)

    await b.dispose(applyDisposer)
    expect(b.entries).toHaveLength(0)
    expect(cssDisposer).toHaveBeenCalledOnce()
    expect(b.locale.bind('settings.usage')('nav')).toBe('nav')
  })

  it('supports settings slots declared after Host availability', async () => {
    const b = bench({ served: true })
    const applyDisposer = await apply(b.ctx as never)
    expect(b.entries).toHaveLength(0)

    const collapseSection = b.declare('settings.section')
    expect(entryNames(b.entries)).toEqual(['settings.section'])
    const collapsePluginItem = b.declare('settings.plugin.item')
    expect(entryNames(b.entries)).toEqual(['settings.plugin.item', 'settings.section'])

    collapseSection()
    expect(entryNames(b.entries)).toEqual(['settings.plugin.item'])
    b.declare('settings.section')
    expect(entryNames(b.entries)).toEqual(['settings.plugin.item', 'settings.section'])
    collapsePluginItem()
    await b.dispose(applyDisposer)
    expect(b.entries).toHaveLength(0)
  })

  it('rolls back a partial display registration', async () => {
    const b = bench()
    b.declare('settings.section')
    b.declare('settings.plugin.item')
    b.failRegistration('settings.plugin.item')
    const applyDisposer = await apply(b.ctx as never)

    expect(() => { b.setServed(true) }).toThrow('failed settings.plugin.item')
    expect(b.entries).toHaveLength(0)
    await b.dispose(applyDisposer)
  })

  it('contains a rejected Host availability read', async () => {
    const failure = new Error('describe failed')
    const b = bench({ ensure: Promise.reject(failure) })
    const applyDisposer = await apply(b.ctx as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(b.logger.warn).toHaveBeenCalledWith('dsh-usage-ledger: Host namespace reconciliation failed')
    expect(b.logger.warn).toHaveBeenCalledWith(failure)
    await b.dispose(applyDisposer)
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
    expect(b.remote.usageLedgerPlugin).toBeDefined()
    await b.dispose(applyDisposer)
    expect(b.remote.usageLedgerPlugin).toBeUndefined()
  })
})
