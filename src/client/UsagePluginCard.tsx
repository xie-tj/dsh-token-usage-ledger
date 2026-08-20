/** Read-only Usage dashboard card contributed to Plugins settings. */

import { useId, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { UsageDashboard } from './UsageDashboard.tsx'
import type { UsageDashboardInjected } from './UsageDashboard.tsx'
import css from './UsagePluginCard.module.css'

/** Props composed by the keyed plugin-card slot. */
type UsagePluginCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.usage'>
  & InjectFace<UsageDashboardInjected>

/** Render the Usage dashboard as a read-only expandable plugin card. */
export function UsagePluginCard({ t, readSnapshot }: UsagePluginCardProps) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return (
    <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('title')}</span>
          <span className={css.description}>{t('intro')}</span>
        </span>
        <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`} aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div id={bodyId} className={css.body}>
          <UsageDashboard t={t} readSnapshot={readSnapshot} />
        </div>
      ) : null}
    </li>
  )
}
