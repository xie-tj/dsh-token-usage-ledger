import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../lib/', import.meta.url))

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(path)
      continue
    }
    if (!entry.name.endsWith('.d.ts')) continue
    const source = await readFile(path, 'utf8')
    const normalized = source
      .replace(/(['"])(\.\.?\/[^'"\n]+?)\.tsx?\1/g, '$1$2.js$1')
      .replace(/^\/\/#[^\n]*sourceMappingURL=.*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n+$/g, '\n')
    if (normalized !== source) await writeFile(path, normalized)
  }
}

await visit(root)
