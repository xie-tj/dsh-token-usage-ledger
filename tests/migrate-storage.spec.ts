import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/migrate-json-to-sqlite.mjs', import.meta.url))
const descriptor = {
  name: 'usage_ledger',
  version: 2,
  tables: ['sessions', 'calls'],
  hasGlobal: false,
}

describe('usage ledger storage migration', () => {
  it('copies arbitrary legacy keys into SQLite without changing the JSON source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-migration-'))
    const source = join(root, 'usage_ledger.json')
    const target = join(root, 'usage-ledger-v2.sqlite')
    const document = {
      unit: { name: 'usage_ledger', version: 2 },
      global: null,
      tables: {
        sessions: { 'session-1': { observedSeq: 4 } },
        calls: { '["session-1",123,"stream:1:1"]': { outcome: 'success' } },
      },
    }
    const sourceText = `${JSON.stringify(document, null, 2)}\n`
    await writeFile(source, sourceText, 'utf8')

    await run(process.execPath, [script, '--source', source, '--target', target])

    expect(await readFile(source, 'utf8')).toBe(sourceText)
    const backend = new SqliteStorageBackend({ path: target, journalMode: 'delete' })
    try {
      const unit = await backend.kv.open(descriptor)
      expect(await unit.loadAll()).toEqual({
        tables: document.tables,
        global: null,
      })
      await unit.close()
    } finally {
      await backend.close()
    }
  })

  it('does not overwrite an existing destination unless merge is explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-migration-'))
    const source = join(root, 'usage_ledger.json')
    const target = join(root, 'usage-ledger-v2.sqlite')
    await writeFile(source, JSON.stringify({
      unit: { name: 'usage_ledger', version: 2 },
      tables: { sessions: {}, calls: {} },
    }), 'utf8')
    const backend = new SqliteStorageBackend({ path: target, journalMode: 'delete' })
    await backend.close()

    await expect(run(process.execPath, [script, '--source', source, '--target', target])).rejects.toThrow(
      /target already exists/,
    )
  })
})
