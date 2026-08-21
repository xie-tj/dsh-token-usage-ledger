import { defineConfig, type UserConfig } from 'tsdown'
import { clientConfig } from './build/client-bundle.ts'

const PACKAGE_NAME = 'dsh-plugin-usage-ledger'

const hostConfig: UserConfig = {
  name: PACKAGE_NAME,
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default defineConfig(({ env }) => {
  if (env?.DSH_BUILD_FACE === 'host') return hostConfig
  if (env?.DSH_BUILD_FACE === 'client') return clientConfig(PACKAGE_NAME)
  if (env?.DSH_BUILD_FACE !== undefined) {
    throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(env.DSH_BUILD_FACE)}`)
  }
  return [hostConfig, clientConfig(PACKAGE_NAME)]
})
