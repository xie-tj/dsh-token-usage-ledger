import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = join(root, '.tmp', 'typert-workspace')
const packageRoot = join(workspace, 'packages', 'dsh-plugin-usage-ledger')
const protocolRoot = join(workspace, 'packages', 'typert-protocol')
const packageName = 'dsh-plugin-usage-ledger'
const protocolName = '@deepseek-ai/dsh-typert-protocol'

await rm(workspace, { recursive: true, force: true })
await mkdir(join(packageRoot, 'src'), { recursive: true })
await mkdir(join(protocolRoot, 'src'), { recursive: true })
await writeFile(join(protocolRoot, 'src', 'index.ts'), `import { Service, type Context } from '@deepseek-ai/cordis'\n\nexport interface TypertLookup<Host = unknown, Wire = unknown> {}\nexport interface TypertLookupMap {}\nexport interface TypertGatewayBindingOptions { readonly namespace?: string }\nexport interface TypertGatewayBinding<Owned extends object = object> {\n  readonly service: Owned\n  readonly serviceKey: string\n  readonly namespace: string\n}\nexport abstract class TypertRemoteService<Owned = never> extends Service<Owned> {\n  readonly typertRemote!: TypertGatewayBinding<this>\n  protected constructor(_ctx: Context, _serviceKey: string, _options?: TypertGatewayBindingOptions) { super(_ctx, _serviceKey) }\n}\ntype RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(\n  method: (this: This, ...args: Args) => Result,\n  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,\n) => void\nexport function Remote(exportName: string): RemoteMethodDecorator\nexport function Remote<This extends object, Args extends unknown[], Result>(\n  method: (this: This, ...args: Args) => Result,\n  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,\n): void\nexport function Remote(...args: unknown[]): void | RemoteMethodDecorator {\n  if (typeof args[0] === 'string') return () => {}\n}\n`)
await writeFile(join(protocolRoot, 'package.json'), JSON.stringify({
  name: protocolName,
  type: 'module',
  exports: { '.': './src/index.ts' },
}, null, 2) + '\n')
await writeFile(join(protocolRoot, 'tsconfig.json'), JSON.stringify({
  extends: '../../tsconfig.base.json',
  compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
  include: ['src'],
}, null, 2) + '\n')

await writeFile(join(packageRoot, 'package.json'), await readFile(join(root, 'package.json'), 'utf8'))
await writeFile(join(packageRoot, 'tsconfig.json'), await readFile(join(root, 'tsconfig.json'), 'utf8'))
await writeFile(join(packageRoot, 'tsconfig.base.json'), await readFile(join(root, 'tsconfig.base.json'), 'utf8'))
await cp(join(root, 'src'), join(packageRoot, 'src'), { recursive: true })
const packageTsconfig = JSON.parse(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8'))
packageTsconfig.compilerOptions = {
  ...packageTsconfig.compilerOptions,
  baseUrl: '.',
  paths: {
    '@deepseek-ai/dsh-typert-protocol': ['../typert-protocol/src/index.ts'],
  },
}
await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify(packageTsconfig, null, 2) + '\n')
await writeFile(join(workspace, 'tsconfig.base.json'), await readFile(join(root, 'tsconfig.base.json'), 'utf8'))
await writeFile(join(workspace, 'tsconfig.host.json'), JSON.stringify({
  extends: './tsconfig.base.json',
  compilerOptions: {
    baseUrl: '.',
    paths: {
      '@deepseek-ai/dsh-typert-protocol': ['packages/typert-protocol/src/index.ts'],
    },
  },
  files: [],
  references: [
    { path: './packages/typert-protocol/tsconfig.json' },
    { path: './packages/dsh-plugin-usage-ledger/tsconfig.json' },
  ],
}, null, 2) + '\n')

const generator = new WorkspaceTypertGenerator(workspace)
const artifacts = generator.generate([protocolName, packageName], ['host'])
const artifact = artifacts.find(candidate => candidate.package === packageName && candidate.face === 'host')
if (artifact === undefined) throw new Error(`Typert generator emitted no Host artifact for ${packageName}`)

const normalizeSourceLocation = (content) => content.replaceAll('packages/dsh-plugin-usage-ledger/', '')
const removeSourceMapComments = (content) => content.replace(/^\/\/# sourceMappingURL=.*$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\n+$/g, '\n')
await writeFile(join(root, 'lib', 'typert.host.js'), normalizeSourceLocation(artifact.js))
await writeFile(join(root, 'lib', 'typert.host.d.ts'), removeSourceMapComments(artifact.dts))
if (artifact.remote === undefined) throw new Error(`Typert generator emitted no Remote artifact for ${packageName}`)
const remoteClientSource = normalizeSourceLocation(artifact.remote.js)
const remoteClientDts = removeSourceMapComments(artifact.remote.dts)
await writeFile(join(root, 'lib', 'typert.remote-client.js'), remoteClientSource)
await writeFile(join(root, 'lib', 'typert.remote-client.d.ts'), remoteClientDts)
const sourceRemoteTypes = remoteClientDts
  .replaceAll("from 'dsh-plugin-usage-ledger/types'", "from '../host/types.ts'")
  .replace(/export declare const TYPERT_REMOTE: TypertRemoteContribution\nexport default TYPERT_REMOTE\n?/, '')
const sourceRemote = remoteClientSource.replace(
  'export const TYPERT_REMOTE = {',
  'export const TYPERT_REMOTE: TypertRemoteContribution = {',
)
await writeFile(join(root, 'src', 'client', 'generated-typert-remote.ts'), `${sourceRemoteTypes.trimEnd()}\n\n${sourceRemote}`)
