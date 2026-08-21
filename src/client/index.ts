/** Browser-side Usage Settings page. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings slot declarations into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale Context merge into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the generated Remote Context merge into this compilation unit.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { TYPERT_REMOTE } from './generated-typert-remote.ts'
import type { UsageLedgerSnapshot } from '../host/types.ts'
import { installUsageStyles, UsageDashboard } from './UsageDashboard.tsx'
import type { UsageDashboardInjected } from './UsageDashboard.tsx'
import { en, zh, type UsageLocaleKey } from './locales.ts'

/** The generated Remote result envelope used by the usage ledger. */
type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Dictionary namespace owned by this package. */
const NS = 'settings.usage'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Usage dashboard copy. */
    'settings.usage': UsageLocaleKey
  }
}

/** Required Cordis services; the local Remote contribution is mounted during apply. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Decode the generated Remote result envelope while accepting a direct snapshot
 * during local host-package assembly.
 * @param response - Remote method result.
 * @returns the usage snapshot payload.
 */
function unpackSnapshot(response: RemoteResult<UsageLedgerSnapshot> | UsageLedgerSnapshot): UsageLedgerSnapshot {
  if (typeof response !== 'object' || response === null || !('ok' in response)) return response
  const result = response as RemoteResult<UsageLedgerSnapshot>
  if (result.ok) return result.value
  throw new Error(`usageLedgerPlugin.snapshot failed: ${result.error.code}: ${result.error.message}`)
}

/** Register the localized Usage section once its settings slot is declared. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // Stock dsh builds that already mount this namespace are reused; older builds
  // receive the generated contribution from this package.
  const ownsRemote = ctx.remote.usageLedgerPlugin === undefined
  const disposeRemote = ownsRemote ? await ctx.remote.$mount(TYPERT_REMOTE) : undefined
  try {
    ctx.effect(() => installUsageStyles(), 'dsh-usage-ledger: stylesheet')
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-usage-ledger: dictionaries')

    const ledger = ctx.remote.usageLedgerPlugin
    const injected = (): UsageDashboardInjected => ({
      readSnapshot: async (): Promise<UsageLedgerSnapshot> => {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
        return unpackSnapshot(await ledger.snapshot({ days: 366, timeZone }))
      },
    })
    const t = ctx.locale.bind(NS)

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'usage',
      order: 20,
      label: () => t('nav'),
      locale: NS,
      inject: injected,
    }, UsageDashboard))

    return async () => {
      if (disposeRemote !== undefined) await disposeRemote()
    }
  } catch (error) {
    if (disposeRemote !== undefined) await disposeRemote()
    throw error
  }
}
