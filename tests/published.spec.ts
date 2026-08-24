import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { loadPublishedClient } from './helpers/client-entry.ts'

const require = createRequire(import.meta.url)

interface PackFile {
  readonly path: string
}

interface PackResult {
  readonly files: readonly PackFile[]
}

describe('published package', () => {
  it('loads every JavaScript export through its published package entry', async () => {
    const host = await import('dsh-plugin-usage-ledger')
    const invariant = await import('dsh-plugin-usage-ledger/invariant')
    const typert = await import('dsh-plugin-usage-ledger/typert')
    const remote = await import('dsh-plugin-usage-ledger/remote')
    const types = await import('dsh-plugin-usage-ledger/types')
    const packageJson = require('dsh-plugin-usage-ledger/package.json') as { name: string }
    const client = await loadPublishedClient()

    expect(host.default).toBe(host.UsageLedgerService)
    expect(invariant.name).toBe('usage-ledger-invariant')
    expect(typert.TYPERT).toBeDefined()
    expect(remote.default).toBe(remote.TYPERT_REMOTE)
    expect(Object.keys(types)).toEqual([])
    expect(packageJson.name).toBe('dsh-plugin-usage-ledger')
    expect(client.registration.id).toBe('dsh-plugin-usage-ledger')
    expect(client.plugin).toMatchObject({ inject: ['slots', 'locale', 'remote', 'settingsScope'] })
    expect(client.plugin).toHaveProperty('apply')
  })

  it('packs only the runtime, declarations, composition patch, and package documentation', () => {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    })
    const [result] = JSON.parse(output) as PackResult[]

    expect(result.files.map(file => file.path).sort()).toEqual([
      'assets/usage-demo.mp4',
      'LICENSE',
      'README.md',
      'cordis.patch.yml',
      'lib/client.js',
      'lib/index.js',
      'lib/invariant.js',
      'lib/typert.host.d.ts',
      'lib/typert.host.js',
      'lib/typert.remote-client.d.ts',
      'lib/typert.remote-client.js',
      'lib/types/client/UsageDashboard.d.ts',
      'lib/types/client/UsageDashboard.js',
      'lib/types/client/UsagePluginCard.d.ts',
      'lib/types/client/UsagePluginCard.js',
      'lib/types/client/generated-typert-remote.d.ts',
      'lib/types/client/generated-typert-remote.js',
      'lib/types/client/index.d.ts',
      'lib/types/client/index.js',
      'lib/types/client/locales.d.ts',
      'lib/types/client/locales.js',
      'lib/types/host/event-types.d.ts',
      'lib/types/host/event-types.js',
      'lib/types/host/index.d.ts',
      'lib/types/host/index.js',
      'lib/types/host/invariant.d.ts',
      'lib/types/host/invariant.js',
      'lib/types/host/spec.d.ts',
      'lib/types/host/spec.js',
      'lib/types/host/types.d.ts',
      'lib/types/host/types.js',
      'lib/types/index.d.ts',
      'lib/types/index.js',
      'lib/types/invariant.d.ts',
      'lib/types/invariant.js',
      'lib/types/types.d.ts',
      'lib/types/types.js',
      'package.json',
    ].sort())
  }, 30_000)
})
