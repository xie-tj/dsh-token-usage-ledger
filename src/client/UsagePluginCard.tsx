/** Usage dashboard page contributed to the Plugins settings page. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { UsageDashboard } from './UsageDashboard.tsx'
import type { UsageDashboardInjected } from './UsageDashboard.tsx'
import * as styles from './UsagePluginCard.module.css'

const css = styles.default

/** Install the Plugins page stylesheet and return its disposer. */
export function installUsagePluginCardStyles(): () => void {
  return typeof styles.install === 'function' ? styles.install() : () => {}
}

/** Props composed by the Plugins page's item slot. */
type UsagePluginCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.usage'>
  & InjectFace<UsageDashboardInjected>

/** Render the Usage one-liner or the full dashboard, as the Plugins page asks. */
export function UsagePluginCard({ view, t, readSnapshot, readStatus, exportCsv }: UsagePluginCardProps) {
  if (view === 'summary') return t('intro')
  return (
    <div className={css.body}>
      <UsageDashboard t={t} readSnapshot={readSnapshot} readStatus={readStatus} exportCsv={exportCsv} />
    </div>
  )
}
