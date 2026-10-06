/** Browser-side Usage Settings page and this bundle's Plugins page row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the Plugins page's SlotMap merge (the 'plugins.row.config' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale Context merge into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the generated Remote Context merge into this compilation unit.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { TYPERT_REMOTE } from './generated-typert-remote.ts'
import type {
  UsageLedgerExportRequest,
  UsageLedgerExportResult,
  UsageLedgerSnapshot,
  UsageLedgerSnapshotRequest,
  UsageLedgerStatus,
} from '../host/types.ts'
import { installUsageStyles, UsageDashboard } from './UsageDashboard.tsx'
import type { UsageDashboardInjected } from './UsageDashboard.tsx'
import { installUsagePluginCardStyles, UsagePluginCard } from './UsagePluginCard.tsx'
import { en, zh, type UsageLocaleKey } from './locales.ts'

/** Dictionary namespace owned by this package. */
const NS = 'settings.usage'

/**
 * Key of this package's own row in the Plugins page: `<package name>#<row id>`,
 * with the row id the bundle patch declares. The Official group belongs to the
 * official settings pages, so this bundle's page renders on its own row instead.
 */
const PLUGIN_ROW_KEY = 'dsh-plugin-usage-ledger#usage-ledger-plugin'

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

function unpackStatus(response: RemoteResult<UsageLedgerStatus> | UsageLedgerStatus): UsageLedgerStatus {
  if (typeof response !== 'object' || response === null || !('ok' in response)) return response
  const result = response as RemoteResult<UsageLedgerStatus>
  if (result.ok) return result.value
  throw new Error(`usageLedgerPlugin.status failed: ${result.error.code}: ${result.error.message}`)
}

function unpackExport(response: RemoteResult<UsageLedgerExportResult> | UsageLedgerExportResult): UsageLedgerExportResult {
  if (typeof response !== 'object' || response === null || !('ok' in response)) return response
  const result = response as RemoteResult<UsageLedgerExportResult>
  if (result.ok) return result.value
  throw new Error('usageLedgerPlugin.exportCsv failed: ' + result.error.code + ': ' + result.error.message)
}

/** Register the localized Usage displays: the Settings section and the Plugins page. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // Stock dsh builds that already mount this namespace are reused; older builds
  // receive the generated contribution from this package.
  const ownsRemote = ctx.get('remote.usageLedgerPlugin') === undefined
  const disposeRemote = ownsRemote ? await ctx.remote.$mount(TYPERT_REMOTE) : undefined
  try {
    ctx.effect(() => {
      const disposeDashboardStyles = installUsageStyles()
      try {
        const disposeCardStyles = installUsagePluginCardStyles()
        return () => {
          disposeCardStyles()
          disposeDashboardStyles()
        }
      } catch (error) {
        disposeDashboardStyles()
        throw error
      }
    }, 'dsh-usage-ledger: stylesheets')
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-usage-ledger: dictionaries')

    const ledger = ctx.get('remote.usageLedgerPlugin')
    if (ledger === undefined) throw new Error('dsh-usage-ledger: generated Remote namespace did not mount')
    const injected = (): UsageDashboardInjected => ({
      readSnapshot: async (request: UsageLedgerSnapshotRequest): Promise<UsageLedgerSnapshot> => unpackSnapshot(await ledger.snapshot(request)),
      readStatus: typeof ledger.status === 'function'
        ? async (): Promise<UsageLedgerStatus> => unpackStatus(await ledger.status())
        : undefined,
      exportCsv: typeof ledger.exportCsv === 'function'
        ? async (request: UsageLedgerExportRequest): Promise<UsageLedgerExportResult> => unpackExport(await ledger.exportCsv(request))
        : undefined,
    })
    const t = ctx.locale.bind(NS)

    ctx.effect(() => {
      const disposers: Array<() => void> = []
      try {
        disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'usage',
          order: 20,
          label: () => t('nav'),
          locale: NS,
          inject: injected,
        }, UsageDashboard)))
        disposers.push(ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: PLUGIN_ROW_KEY,
          locale: NS,
          inject: injected,
        }, UsagePluginCard)))
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      }
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    }, 'dsh-usage-ledger: pages')

    return async () => {
      if (disposeRemote !== undefined) await disposeRemote()
    }
  } catch (error) {
    if (disposeRemote !== undefined) await disposeRemote()
    throw error
  }
}
