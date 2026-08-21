import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative as relativePath, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'
import { CLIENT_EXTERNALS } from './platform.ts'

const CSS_VIRTUAL_PREFIX = '\0dsh-usage-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const CLIENT_BUILD_MODE = 'production'

/** Build the browser loader artifact consumed by the dsh Web module loader. */
export function clientConfig(id: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    dts: false,
    sourcemap: false,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.includes(specifier as typeof CLIENT_EXTERNALS[number]),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(CLIENT_BUILD_MODE),
      'import.meta.env.MODE': JSON.stringify(CLIENT_BUILD_MODE),
      'import.meta.env': JSON.stringify({ MODE: CLIENT_BUILD_MODE }),
    },
    plugins: [
      {
        name: 'dsh-usage-client-purity',
        resolveId(specifier: string) {
          if (!specifier.startsWith('@deepseek-ai/')) return null
          if (CLIENT_EXTERNALS.includes(specifier as typeof CLIENT_EXTERNALS[number])) return null
          throw new Error(`client bundle purity: unsupported runtime import ${specifier}`)
        },
      },
      {
        name: 'dsh-usage-css-modules',
        resolveId(specifier: string, importer: string | undefined) {
          if (!specifier.endsWith('.module.css')) return null
          const absolute = importer === undefined
            ? resolve(specifier)
            : sourceAssetPath(specifier, importer)
          const virtualPath = relativePath(resolve('.'), absolute).replaceAll('\\', '/')
          return CSS_VIRTUAL_PREFIX + virtualPath + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const virtualPath = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          const fileId = resolve(virtualPath)
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const result = transform({ filename: virtualPath, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true })
          const classMap: Record<string, string> = {}
          for (const [local, exported] of Object.entries(result.exports ?? {}).sort(([left], [right]) => left.localeCompare(right))) classMap[local] = exported.name
          const tagId = `${id}/${basename(virtualPath)}`
          return [
            `const css = ${JSON.stringify(result.code.toString())};`,
            `const tagId = ${JSON.stringify(tagId)};`,
            'const selector = \'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\';',
            'export function install() {',
            '  if (typeof document === "undefined") return () => {};',
            '  const tag = document.querySelector(selector) ?? document.createElement("style");',
            '  const users = Number(tag.dataset.pluginCssUsers ?? "0");',
            '  tag.dataset.pluginCssUsers = String(Number.isFinite(users) ? users + 1 : 1);',
            '  if (tag.parentNode === null) {',
            `    tag.dataset.plugin = ${JSON.stringify(id)};`,
            '    tag.dataset.pluginCss = tagId;',
            '    tag.textContent = css;',
            '    document.head.appendChild(tag);',
            '  }',
            '  let disposed = false;',
            '  return () => {',
            '    if (disposed) return;',
            '    disposed = true;',
            '    const remaining = Number(tag.dataset.pluginCssUsers ?? "1") - 1;',
            '    if (remaining <= 0) tag.remove();',
            '    else tag.dataset.pluginCssUsers = String(remaining);',
            '  };',
            '}',
            `export default ${JSON.stringify(classMap)};`,
          ].join('\n')
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${resolve('lib/types')}/`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolve(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
