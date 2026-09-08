import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'

const DOMAIN = Object.freeze({
  name: 'usage_ledger',
  version: 2,
  tables: ['sessions', 'calls'],
  hasGlobal: false,
})

const options = parseArgs(process.argv.slice(2))
const sourcePath = resolve(required(options, '--source'))
const targetPath = resolve(required(options, '--target'))

if (sourcePath === targetPath) {
  throw new Error('source and target must be different files')
}
if (!options.merge) await assertMissing(targetPath)

const sourceText = await readFile(sourcePath, 'utf8')
const source = parseSource(sourceText)
const backend = new SqliteStorageBackend({ path: targetPath, journalMode: 'wal' })
let copied = 0

try {
  const unit = await backend.kv.open(DOMAIN)
  try {
    for (const table of DOMAIN.tables) {
      const records = source.tables[table]
      for (const [key, value] of Object.entries(records)) {
        await unit.putRecord(table, key, value)
        copied += 1
        if (copied % 1000 === 0) process.stderr.write(`migrated ${copied} records\n`)
      }
    }
  } finally {
    await unit.close()
  }
} finally {
  await backend.close()
}

process.stderr.write(`migrated ${copied} records from ${sourcePath} to ${targetPath}\n`)

async function assertMissing(path) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`target already exists: ${path}; pass --merge to upsert into it`)
}

function parseArgs(args) {
  const result = { merge: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--merge') {
      result.merge = true
      continue
    }
    if (argument === '--source' || argument === '--target') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a path`)
      result[argument] = value
      index += 1
      continue
    }
    throw new Error(`unknown option: ${argument}`)
  }
  return result
}

function required(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function parseSource(text) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error('source is not valid JSON', { cause: error })
  }
  const root = record(document, 'source')
  const unit = record(root.unit, 'source.unit')
  if (unit.name !== DOMAIN.name || unit.version !== DOMAIN.version) {
    throw new Error(
      `source unit must be ${DOMAIN.name} version ${DOMAIN.version}, got ${String(unit.name)} version ${String(unit.version)}`,
    )
  }
  const tables = record(root.tables, 'source.tables')
  return {
    tables: Object.fromEntries(DOMAIN.tables.map(table => [table, record(tables[table] ?? {}, `source.tables.${table}`)])),
  }
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value
}
