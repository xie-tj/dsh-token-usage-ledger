import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import UsageLedgerService from '../src/host/index.ts'

function table() {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => values.get(key),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value) }),
    delete: vi.fn(async (key: string) => { values.delete(key) }),
    entries: () => values.entries(),
  }
}

describe('UsageLedgerService lifecycle', () => {
  it('opens its domain, serves an empty snapshot, and closes the domain on disposal', async () => {
    const ctx = new Context()
    const sessions = { list: () => [], get: () => undefined }
    const persistence = { list: vi.fn(async () => []) }
    const settings = { register: vi.fn(() => () => {}) }
    const sessionTable = table()
    const callTable = table()
    const close = vi.fn(async () => {})
    const open = vi.fn(async () => ({
      table: (name: string) => name === 'sessions' ? sessionTable : callTable,
      close,
    }))
    ctx.provide('storageDomain', { open } as never)
    ctx.provide('sessions', sessions as never)
    ctx.provide('sessionPersistence', persistence as never)
    ctx.provide('settings', settings as never)

    const fiber = ctx.plugin(UsageLedgerService)
    await fiber.await()
    const snapshot = await ctx.usageLedger.snapshot({ days: 1, timeZone: 'UTC' })

    expect(open).toHaveBeenCalledOnce()
    expect(persistence.list).toHaveBeenCalledOnce()
    expect(snapshot).toMatchObject({ days: 1, timeZone: 'UTC', models: [], events: [] })
    expect(snapshot.daily).toHaveLength(1)
    await fiber.dispose()
    expect(close).toHaveBeenCalledOnce()
  })
})
