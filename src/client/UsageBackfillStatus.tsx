/** Background accounting state and session-based replay progress. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageLedgerStatus } from '../host/types.ts'
import type { UsageLocaleKey } from './locales.ts'
import { usageTimeText } from './usageTime.ts'
import * as styles from './UsageDashboard.module.css'

const css = styles.default
type Phase = 'running' | 'resuming' | 'paused' | 'failed' | 'complete' | 'incomplete' | 'waiting' | 'loading' | 'unavailable'
type Props = PropsLocale<'settings.usage'> & {
  readonly status: UsageLedgerStatus | undefined
  /** A failed poll retains the last successful progress counters. */
  readonly stale: boolean
}
const titles: Record<Phase, UsageLocaleKey> = {
  running: 'backfillStateRunning', resuming: 'backfillStateResuming', paused: 'backfillStatePaused', failed: 'backfillStateFailed',
  complete: 'backfillStateComplete', incomplete: 'backfillStateIncomplete', waiting: 'backfillStateWaiting',
  loading: 'backfillStateLoading', unavailable: 'backfillStateUnavailable',
}
const descriptions: Record<Phase, UsageLocaleKey> = {
  running: 'backfillRunningHint', resuming: 'backfillResumingHint', paused: 'backfillPausedHint', failed: 'backfillFailedHint',
  complete: 'backfillCompleteHint', incomplete: 'backfillIncompleteHint', waiting: 'backfillWaitingHint',
  loading: 'backfillLoadingHint', unavailable: 'backfillUnavailableHint',
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => values[key] ?? '{' + key + '}')
}

/**
 * Render worker state without deriving completion from an unknown session count.
 * @param props - latest worker status and localized labels.
 * @returns a status card; progress measures completed sessions, not tokens or time.
 */
export function UsageBackfillStatus({ status, stale, t }: Props) {
  const knownTotal = status !== undefined && status.totalSessions > 0
  const phase: Phase = status === undefined
    ? stale ? 'unavailable' : 'loading'
    : status.lastError !== undefined || status.state === 'failed'
      ? 'failed'
      : knownTotal && status.processedSessions >= status.totalSessions && (status.state === 'idle' || status.state === 'paused')
        ? 'complete'
        : status.state === 'paused' && status.pace?.mode === 'run'
          ? 'resuming'
          : status.state === 'idle'
            ? knownTotal && status.processedSessions > 0 ? 'incomplete' : 'waiting'
            : status.state
  const percent = knownTotal
    ? Math.min(100, Math.max(0, Math.round(status.processedSessions / status.totalSessions * 1000) / 10))
    : undefined
  const number = (value: number) => new Intl.NumberFormat().format(value)
  const sessions = status === undefined ? '—' : number(status.processedSessions) + ' / ' + (knownTotal ? number(status.totalSessions) : '—')
  const reason = phase === 'paused' && status?.pace?.mode === 'pause' ? status.pace.reason : undefined
  const remaining = knownTotal && status !== undefined ? Math.max(0, status.totalSessions - status.processedSessions) : 0
  const detail = phase === 'incomplete'
    ? interpolate(t('backfillIncompleteHint'), { remaining: number(remaining) })
    : t(reason === 'battery' ? 'backfillPausedBattery'
      : reason === 'memory' ? 'backfillPausedMemory'
        : reason === 'event-loop' ? 'backfillPausedEventLoop' : descriptions[phase])
  // A retained error stays visible in every phase: an idle or completed frame must not hide it.
  const error = status?.lastError
  const scope = status === undefined ? undefined : status.backfillScope === 'all'
    ? t('backfillScopeAll')
    : interpolate(t('backfillScopeRecent'), { days: number(status.backfillDays) })

  return (
    <section className={css.backfill} role="region" aria-label={t('backfillTitle')} data-phase={phase}>
      <div className={css.backfillHeading}>
        <h3>{t('backfillTitle')}</h3>
        <span className={css.backfillBadge} role="status">
          <span className={css.backfillSignal} aria-hidden="true" />
          {t(titles[phase])}
        </span>
      </div>
      <p className={css.backfillDescription}>{detail}</p>
      {(status?.reusedSessions ?? 0) > 0 ? <p className={css.backfillDescription}>{interpolate(t('backfillReused'), {sessions: number(status?.reusedSessions ?? 0)})}</p> : null}
      {error === undefined ? null : <p className={css.backfillError}>{error}</p>}
      {status === undefined && stale ? null : (
        <>
          <div className={css.backfillProgressHeading}>
            <span>{t('backfillProgress')}</span>
            <strong>{percent === undefined
              ? t(phase === 'running' || phase === 'loading' ? 'backfillDiscovering' : 'backfillProgressPending')
              : number(percent) + '%'}</strong>
          </div>
          <div className={css.backfillTrack} role="progressbar" aria-label={t('backfillProgress')}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
            aria-valuetext={knownTotal ? interpolate(t('backfillSessionProgress'), { sessions }) : undefined}
            data-indeterminate={percent === undefined ? 'true' : undefined}>
            <span className={css.backfillFill} style={{ width: percent === undefined ? phase === 'running' || phase === 'loading' ? '30%' : '0%' : percent + '%' }} />
          </div>
          <dl className={css.backfillStats}>
            <div><dt>{t('backfillSessions')}</dt><dd>{sessions}</dd></div>
            <div><dt>{t('backfillEvents')}</dt><dd>{status === undefined ? '—' : number(status.processedEvents)}</dd></div>
            <div><dt>{t('backfillRemaining')}</dt><dd>{knownTotal ? number(Math.max(0, status.totalSessions - status.processedSessions)) : '—'}</dd></div>
          </dl>
        </>
      )}
      {status === undefined ? null : (
        <div className={css.backfillMeta}>
          <span>{t('backfillScope')}: {scope}</span>
          <span>{interpolate(t('backfillStatusUpdated'), { time: usageTimeText(status.updatedAt) })}</span>
        </div>
      )}
      {status !== undefined && stale ? <p className={css.backfillStale} role="status">{t('backfillStale')}</p> : null}
    </section>
  )
}
