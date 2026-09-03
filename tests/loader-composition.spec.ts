import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { load as parseYaml } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as usageLedgerPlugin from 'dsh-plugin-usage-ledger'

function table() {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value) },
    delete: async (key: string) => { values.delete(key) },
    entries: () => values.entries(),
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Usage Ledger Loader composition', () => {
  it('loads the shipped patch and package, backfills usage, and unloads cleanly', async () => {
    const sessionId = SessionId('usage-ledger-loader-history')
    const eventTime = Date.UTC(2026, 1, 6, 12)
    const historical = Session.create(sessionId, [
      {
        type: 'request/context',
        seq: 0,
        time: eventTime,
        data: { provider: 'deepseek', model: 'deepseek-chat' },
      },
      {
        type: 'assistant/chunk',
        seq: 1,
        time: eventTime + 1,
        data: {
          turn: 0,
          step: 0,
          chunk: { type: 'usage', usage: { inputTokens: 17, outputTokens: 9 } },
        },
      },
    ] as never, {
      version: 0,
      id: sessionId,
      createdAt: eventTime,
      cwd: '/loader-composition',
      isSeeded: false,
    })
    const sessionTable = table()
    const callTable = table()
    const close = vi.fn(async () => {})
    const supportPlugin = {
      name: 'usage-ledger-test-support',
      apply(ctx: Context) {
        ctx.provide('storageDomain', {
          open: async () => ({
            table: (name: string) => name === 'sessions' ? sessionTable : callTable,
            close,
          }),
        } as never)
        ctx.provide('sessions', { list: () => [], get: () => undefined } as never)
        ctx.provide('sessionPersistence', {
          list: async () => [{ header: historical.header, revision: 'history' }],
          open: async () => ({
            id: historical.id,
            header: historical.header,
            inheritedEventCount: 0,
            read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) => historical.snapshotEvents().slice(offset, offset + length),
            close: async () => {},
          }),
        } as never)
      },
    }

    root = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, "- id: support\n  name: test:usage-ledger-support\n")
    const patch = parseYaml(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as PatchOptions[]

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test:usage-ledger-support', supportPlugin],
      ['dsh-plugin-usage-ledger', usageLedgerPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href, patches: patch },
    })
    await context.loader.await()

    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(context.get('usageLedger')).toBeDefined()
    const snapshot = await context.usageLedger.snapshot({ workspace: '/loader-composition', days: 366, timeZone: 'UTC' })
    expect(snapshot.events).toMatchObject([{
      provider: 'deepseek',
      model: 'deepseek-chat',
      inputTokens: 17,
      outputTokens: 9,
    }])

    const usageEntry = [...context.loader.entries()].find(entry => entry.options.id === 'usage-ledger-plugin')
    expect(usageEntry).toBeDefined()
    await usageEntry?.update({ disabled: true })
    await context.loader.await()
    expect(context.get('usageLedger')).toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })
})
