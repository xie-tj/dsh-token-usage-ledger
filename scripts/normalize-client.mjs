import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../lib/client.js', import.meta.url)
const source = await readFile(path, 'utf8')
await writeFile(path, source.replace(/[ \t]+$/gm, ''))
