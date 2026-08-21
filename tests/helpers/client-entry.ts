import { createRequire } from 'node:module'
import type { Plugin } from '@deepseek-ai/cordis'

interface ClientModuleRegistration {
  readonly id: string
  readonly factory: (require: NodeJS.Require) => Plugin
}

/** Load the published browser wrapper through its public package export and ModuleLoader protocol. */
export async function loadPublishedClient(): Promise<{ registration: ClientModuleRegistration; plugin: Plugin }> {
  let registration: ClientModuleRegistration | undefined
  const globalObject = globalThis as Record<string, unknown>
  const previousWindow = globalObject.window
  Object.defineProperty(globalObject, 'window', {
    configurable: true,
    value: {
      __ModuleLoader__: {
        load(value: ClientModuleRegistration) {
          registration = value
        },
      },
    },
    writable: true,
  })
  try {
    await import('dsh-plugin-usage-ledger/client')
  } finally {
    if (previousWindow === undefined) delete globalObject.window
    else Object.defineProperty(globalObject, 'window', { configurable: true, value: previousWindow, writable: true })
  }
  if (registration === undefined) throw new Error('published client did not register with ModuleLoader')
  return {
    registration,
    plugin: registration.factory(createRequire(import.meta.url)),
  }
}
