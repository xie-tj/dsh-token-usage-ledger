import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import remote from '../lib/typert.remote-client.js'

const root = fileURLToPath(new URL('../', import.meta.url))

type ProfileRow = {
  readonly id: string
  readonly name: string
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
}
type PatchOperation = ProfileRow | { readonly insert: readonly ProfileRow[] }

function applyPatch(rows: readonly ProfileRow[], operations: readonly PatchOperation[]): readonly ProfileRow[] {
  const result = rows.map(row => ({ ...row }))
  for (const operation of operations) {
    if ('insert' in operation) {
      result.push(...operation.insert.map(row => ({ ...row })))
      continue
    }
    const index = result.findIndex(row => row.id === operation.id && row.name === operation.name)
    if (index >= 0) result[index] = { ...result[index], ...operation }
  }
  return result
}

describe('published Host artifacts', () => {
  it('contains the generated Remote contract for the public snapshot method', () => {
    expect(remote.package).toBe('dsh-plugin-usage-ledger')
    expect(remote.descriptors).toHaveLength(1)
    expect(remote.descriptors[0]).toMatchObject({
      service: 'usageLedger',
      namespace: 'usageLedgerPlugin',
      method: 'snapshot',
      sourceLocation: { file: 'src/host/index.ts' },
    })
  })

  it('does not publish JavaScript source maps', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      files: readonly string[]
    }
    expect(packageJson.files.some(file => file.endsWith('.js.map'))).toBe(false)
    const { readdir } = await import('node:fs/promises')
    const libEntries = await readdir(root + 'lib', { recursive: true })
    expect(libEntries.some(entry => entry.endsWith('.js.map'))).toBe(false)
  })

  it('does not leave stale declaration source-map references', async () => {
    const remoteTypes = await readFile(new URL('../lib/typert.remote-client.d.ts', import.meta.url), 'utf8')
    expect(remoteTypes).not.toContain('sourceMappingURL=')
  })

  it('keeps Client output independent of the checkout path and ambient mode', async () => {
    const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    expect(client).not.toContain(root)
    expect(client).not.toContain('process.env.NODE_ENV')
    expect(client).toContain('dsh-usage-css:src/client/UsageDashboard.module.css.mjs')
  })
})

describe('bundle composition', () => {
  it('inserts one external replacement without targeting removed alpha.5 rows', async () => {
    const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const patch = parseYaml(patchText) as readonly PatchOperation[]
    const storageConfig = {
      backend: 'sqlite',
      routes: { usage_ledger: 'sqlite', sessions: 'sqlite' },
      scope: 'profile',
    }
    const profile: readonly ProfileRow[] = [
      { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: storageConfig },
    ]
    const composed = applyPatch(profile, patch)
    expect(composed.find(row => row.id === 'storage-domain')?.config).toEqual(storageConfig)
    expect(patch.some(operation => !('insert' in operation))).toBe(false)
    expect(composed.filter(row => row.name === 'dsh-plugin-usage-ledger')).toHaveLength(1)
    expect(applyPatch(profile.slice(0, 1), patch).filter(row => row.name === 'dsh-plugin-usage-ledger')).toHaveLength(1)
    expect(patchText).not.toContain('storage-domain:')
  })
})
