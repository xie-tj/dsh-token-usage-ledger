import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(root, '.tmp-pack-'))
try {
  const { stdout } = await run('pnpm', ['pack', '--pack-destination', temporary, '--json'], { cwd: root })
  const metadata = JSON.parse(stdout)
  const archive = metadata.filename
  if (typeof archive !== 'string') throw new Error('pnpm pack did not report an archive')
  const { stdout: listing } = await run('tar', ['-tzf', archive], { cwd: root })
  const entries = new Set(listing.trim().split('\n').filter(Boolean))
  const required = [
    'package/README.md',
    'package/cordis.patch.yml',
    'package/lib/index.js',
    'package/lib/client.js',
    'package/lib/typert.host.js',
    'package/lib/typert.remote-client.js',
    'package/lib/types/index.d.ts',
    'package/lib/types/client/index.d.ts',
  ]
  for (const entry of required) if (!entries.has(entry)) throw new Error(`packed artifact is missing ${entry}`)
  for (const entry of entries) {
    if (entry.endsWith('.js.map')) throw new Error(`packed artifact contains a JavaScript source map: ${entry}`)
    if (entry.endsWith('.tsbuildinfo')) throw new Error(`packed artifact contains a TypeScript build cache: ${entry}`)
  }

  const extracted = join(temporary, 'extract')
  await mkdir(extracted)
  await run('tar', ['-xzf', archive, '-C', extracted])
  for (const entry of entries) {
    if (!entry.endsWith('.d.ts')) continue
    const declaration = await readFile(join(extracted, entry), 'utf8')
    if (declaration.includes('sourceMappingURL=')) throw new Error(`packed declaration contains a source-map reference: ${entry}`)
    for (const match of declaration.matchAll(/(?:from|import)\s+['"](\.[^'"]+\.js)['"]/g)) {
      const specifier = match[1]
      const target = join(dirname(entry), `${specifier.slice(0, -3)}.d.ts`)
      if (!entries.has(target)) throw new Error(`packed declaration points to a missing file: ${entry} -> ${specifier}`)
    }
  }
  const packedPackage = JSON.parse(await readFile(join(extracted, 'package', 'package.json'), 'utf8'))
  for (const [subpath, target] of Object.entries(packedPackage.exports)) {
    if (subpath === './package.json') continue
    const defaultTarget = typeof target === 'object' && target !== null ? target.default : target
    if (typeof defaultTarget !== 'string') throw new Error(`export ${subpath} has no runtime target`)
    if (!entries.has(`package/${defaultTarget.replace(/^\.\//, '')}`)) {
      throw new Error(`export ${subpath} points to an unpublished file: ${defaultTarget}`)
    }
  }
  console.log(`pack check passed: ${archive}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
