import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  UsageLedgerExportRequest,
  UsageLedgerExportResult,
  UsageLedgerSnapshot,
  UsageLedgerSnapshotRequest,
  UsageLedgerStatus,
} from '../host/types.ts'
import { UsageLedgerMark } from './UsageLedgerMark.tsx'
import { UsageBackfillStatus } from './UsageBackfillStatus.tsx'
import { usageTimeText } from './usageTime.ts'
import { usageChartSeries, type UsageChartBucket, type UsageChartDay as Bucket } from './usageChart.ts'
import * as styles from './UsageDashboard.module.css'

const css = styles.default

/** Install the dashboard stylesheet and return its disposer.
 * @returns A function that removes the installed stylesheet.
 */
export function installUsageStyles(): () => void {
  return typeof styles.install === 'function' ? styles.install() : () => {}
}

type Period = 'all' | '7d' | '30d'
type ChartTarget = { readonly kind: 'requests' | 'tokens'; readonly index: number } | undefined

interface UsageEvent {
  readonly at: number
  readonly provider: string
  readonly model: string
  readonly input: number
  readonly output: number
  readonly cached: number
  readonly cacheHit: number
  readonly metered: boolean
  readonly outcome: 'started' | 'success' | 'failure' | 'aborted'
  readonly retried: boolean
}

interface ModelRow {
  readonly provider: string
  readonly model: string
  readonly requests: number
  readonly input: number
  readonly output: number
  readonly cached: number
  readonly cacheHit: number
  readonly metered: number
  readonly unmetered: number
  readonly failed: number
  readonly retried: number
}

interface UsageSnapshot {
  readonly updatedAt: string
  readonly throughDay: string
  readonly events: readonly UsageEvent[]
  readonly models: readonly ModelRow[]
  readonly daily: readonly Bucket[]
}

/** Dependencies supplied from the Usage plugin's apply closure. */
export interface UsageDashboardInjected {
  /** Read the current Host usage snapshot. */
  readSnapshot: (request: UsageLedgerSnapshotRequest) => Promise<UsageLedgerSnapshot>
  /** Read non-blocking background replay state, when supported by the Host. */
  readStatus?: () => Promise<UsageLedgerStatus>
  /** Stream the matching ledger rows into an owner-only CSV file. */
  exportCsv?: (request: UsageLedgerExportRequest) => Promise<UsageLedgerExportResult>
}

/** Data and translation props consumed by the Usage dashboard in any Settings slot. */
type UsageDashboardProps = PropsLocale<'settings.usage'> & UsageDashboardInjected

interface QueriedSnapshot {
  readonly queryKey: string
  readonly value: UsageSnapshot
}

type SnapshotState = { readonly requestKey: string } & (
  | { readonly status: 'loading'; readonly snapshot: QueriedSnapshot | undefined; readonly error: undefined }
  | { readonly status: 'ready'; readonly snapshot: QueriedSnapshot; readonly error: undefined }
  | { readonly status: 'error'; readonly snapshot: QueriedSnapshot | undefined; readonly error: string }
)

/** Identity of the filters that own a completed response, independent of its arrival time. */
function snapshotKey(period: Period, provider: string, model: string): string {
  return JSON.stringify([period, provider, model])
}

function mergeModelRows(rows: readonly ModelRow[]): readonly ModelRow[] {
  const merged = new Map<string, ModelRow>()
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`
    const current = merged.get(key)
    if (current === undefined) {
      merged.set(key, row)
      continue
    }
    merged.set(key, {
      provider: current.provider,
      model: current.model,
      requests: current.requests + row.requests,
      input: current.input + row.input,
      output: current.output + row.output,
      cached: current.cached + row.cached,
      cacheHit: current.cacheHit + row.cacheHit,
      metered: current.metered + row.metered,
      unmetered: current.unmetered + row.unmetered,
      failed: current.failed + row.failed,
      retried: current.retried + row.retried,
    })
  }
  return [...merged.values()]
}

function modelLabel(row: Pick<ModelRow, 'provider' | 'model'>, showProvider: boolean): string {
  return showProvider && row.provider !== '' ? `${row.provider} / ${row.model}` : row.model
}

/**
 * Project the strict Host snapshot into the dashboard's display vocabulary.
 * @param snapshot - validated Host snapshot.
 * @returns normalized values used by charts and model rows.
 */
export function projectSnapshot(snapshot: UsageLedgerSnapshot): UsageSnapshot {
  const events = snapshot.events.map(event => {
    const hasUsage = event.inputTokens !== undefined
      || event.outputTokens !== undefined
      || event.cacheReadTokens !== undefined
      || event.cacheWriteTokens !== undefined
    return {
      at: event.at,
      provider: event.provider,
      model: event.model,
      input: event.inputTokens ?? 0,
      output: event.outputTokens ?? 0,
      cached: (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0),
      cacheHit: event.cacheReadTokens ?? 0,
      metered: hasUsage,
      outcome: event.outcome,
      retried: event.retried,
    }
  })
  const models = mergeModelRows(snapshot.models.map(row => ({
    provider: row.provider,
    model: row.model,
    requests: row.requests,
    input: row.inputTokens,
    output: row.outputTokens,
    cached: row.cacheReadTokens + row.cacheWriteTokens,
    cacheHit: row.cacheReadTokens,
    metered: row.meteredRequests,
    unmetered: row.unmeteredRequests,
    failed: row.failedRequests,
    retried: row.retryRequests,
  })))
  const daily = snapshot.daily.map(row => ({
    date: row.day,
    requests: row.requests,
    input: row.inputTokens,
    output: row.outputTokens,
    cached: row.cacheReadTokens + row.cacheWriteTokens,
    metered: row.meteredRequests,
    unmetered: row.unmeteredRequests,
    failed: row.failedRequests,
    retried: row.retryRequests,
  }))
  return {
    updatedAt: snapshot.updatedAt,
    throughDay: snapshot.throughDay,
    events,
    models,
    daily,
  }
}

function exactCountText(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
    notation: 'standard',
    useGrouping: false,
  }).format(value)
}

function fullNumberText(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function compactNumberText(value: number): string {
  return new Intl.NumberFormat('en-US', {
    compactDisplay: 'short',
    maximumFractionDigits: 2,
    notation: 'compact',
    useGrouping: false,
  }).format(value)
}

function dateText(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value)
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => values[key] ?? `{${key}}`)
}

function curvePath(buckets: readonly Bucket[]): string {
  const max = Math.max(1, ...buckets.map(bucket => bucket.requests))
  const points = buckets.map((bucket, index) => ({
    x: buckets.length === 1 ? 50 : (index / (buckets.length - 1)) * 100,
    y: 36 - (bucket.requests / max) * 30,
  }))
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]?.x ?? 0} ${points[0]?.y ?? 36}`
  let path = `M ${points[0]?.x ?? 0} ${points[0]?.y ?? 36}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    if (previous === undefined || point === undefined) continue
    const midpoint = (previous.x + point.x) / 2
    path += ` Q ${midpoint} ${previous.y}, ${point.x} ${point.y}`
  }
  return path
}

function totalOf(row: Pick<ModelRow, 'input' | 'output' | 'cached'>): number {
  return row.input + row.output + row.cached
}

function snapshotRequest(period: Period, provider: string, model: string): UsageLedgerSnapshotRequest {
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(period === 'all' ? { all: true } : { days: period === '7d' ? 7 : 30 }),
    ...(provider === 'all' ? {} : { provider }),
    ...(model === 'all' ? {} : { model }),
  }
}

/** Render the settings Usage dashboard with local filter and tooltip state. */
export function UsageDashboard({ readSnapshot, readStatus, exportCsv, t }: UsageDashboardProps): ReactNode {
  const tooltipId = useId()
  const [state, setState] = useState<SnapshotState>({ status: 'loading', snapshot: undefined, error: undefined, requestKey: snapshotKey('all', 'all', 'all') })
  const [request, setRequest] = useState(0)
  const [provider, setProvider] = useState('all')
  const [model, setModel] = useState('all')
  const [period, setPeriod] = useState<Period>('all')
  const queryKey = snapshotKey(period, provider, model)
  const [showProvider, setShowProvider] = useState(false)
  const [target, setTarget] = useState<ChartTarget>(undefined)
  const [workerStatus, setWorkerStatus] = useState<UsageLedgerStatus | undefined>(undefined)
  const [workerStatusReadFailed, setWorkerStatusReadFailed] = useState(false)
  const [catalogModels, setCatalogModels] = useState<readonly ModelRow[]>([])
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<UsageLedgerExportResult | undefined>(undefined)

  useEffect(() => {
    let current = true
    setState(previous => ({ status: 'loading', requestKey: queryKey, snapshot: previous.snapshot, error: undefined }))
    setTarget(undefined)
    void readSnapshot(snapshotRequest(period, provider, model)).then(
      (snapshot) => {
        if (!current) return
        const projected = projectSnapshot(snapshot)
        if (provider === 'all' && model === 'all' && period === 'all') setCatalogModels(projected.models)
        setState({ status: 'ready', requestKey: queryKey, snapshot: { queryKey, value: projected }, error: undefined })
      },
      (error: unknown) => {
        if (!current) return
        setState(previous => ({
          status: 'error',
          requestKey: queryKey,
          snapshot: previous.snapshot,
          error: error instanceof Error ? error.message : '',
        }))
      },
    )
    return () => { current = false }
  }, [model, period, provider, queryKey, readSnapshot, request])

  useEffect(() => {
    if (readStatus === undefined) return
    let current = true
    const update = (): void => {
      void readStatus().then(
        status => { if (current) { setWorkerStatus(status); setWorkerStatusReadFailed(false) } },
        () => { if (current) setWorkerStatusReadFailed(true) },
      )
    }
    update()
    const timer = setInterval(update, 2_000)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [readStatus])

  // A retained response is usable for same-query refreshes, never a different range or filter.
  const snapshot = state.snapshot?.queryKey === queryKey ? state.snapshot.value : undefined
  const requestStatus = state.requestKey === queryKey ? state.status : 'loading'
  const models = useMemo(
    () => snapshot === undefined ? [] : [...snapshot.models].sort((left, right) => totalOf(right) - totalOf(left)),
    [snapshot],
  )
  const catalog = catalogModels.length > 0 ? catalogModels : models
  const providers = useMemo(
    () => [...new Set(catalog.map(row => row.provider))].sort(),
    [catalog],
  )
  const modelOptions = useMemo(
    () => [...new Set(catalog
      .filter(row => provider === 'all' || row.provider === provider)
      .map(row => row.model))].sort(),
    [catalog, provider],
  )
  const series = useMemo(() => usageChartSeries(snapshot?.daily ?? []), [snapshot])
  const buckets = series.buckets
  const visibleModels = useMemo(
    () => [...(showProvider ? models : mergeModelRows(models))].sort((left, right) => totalOf(right) - totalOf(left)),
    [models, showProvider],
  )
  const totals = useMemo(() => models.reduce((total, row) => ({
    requests: total.requests + row.requests,
    input: total.input + row.input,
    output: total.output + row.output,
    cached: total.cached + row.cached,
    cacheHit: total.cacheHit + row.cacheHit,
    unmetered: total.unmetered + row.unmetered,
    failed: total.failed + row.failed,
    retried: total.retried + row.retried,
  }), { requests: 0, input: 0, output: 0, cached: 0, cacheHit: 0, unmetered: 0, failed: 0, retried: 0 }), [models])
  const chartTotals = useMemo(() => buckets.reduce((total, bucket) => ({
    requests: total.requests + bucket.requests,
    tokens: total.tokens + bucket.input + bucket.output + bucket.cached,
  }), { requests: 0, tokens: 0 }), [buckets])
  const curve = useMemo(() => curvePath(buckets), [buckets])
  const activeBucket = target === undefined ? undefined : buckets[target.index]
  const maxRequests = Math.max(1, ...buckets.map(bucket => bucket.requests))
  const maxTokens = Math.max(1, ...buckets.map(bucket => bucket.input + bucket.output + bucket.cached))
  const tokenText = (value: number): string => fullNumberText(value)
  const bucketDate = (bucket: UsageChartBucket): string => bucket.date === bucket.endDate
    ? dateText(bucket.date)
    : interpolate(t('chartDateRange'), { from: dateText(bucket.date), to: dateText(bucket.endDate) })
  const grainLabel = series.grain === 'day' ? t('chartGrainDay')
    : series.grain === 'week' ? t('chartGrainWeek')
      : series.grain === 'month' ? t('chartGrainMonth')
        : series.yearsPerBucket === 1 ? t('chartGrainYear')
          : interpolate(t('chartGrainYears'), { years: exactCountText(series.yearsPerBucket) })
  const chartAxis = series.fromDay === undefined || series.throughDay === undefined ? null : (
    <div className={css.chartAxis}>
      <time dateTime={series.fromDay}>{series.fromDay}</time>
      <span title={grainLabel}>{grainLabel}</span>
      <time dateTime={series.throughDay}>{series.throughDay}</time>
    </div>
  )

  const refresh = (): void => { setRequest(current => current + 1) }
  const exportLedger = (): void => {
    if (exportCsv === undefined || exporting) return
    setExporting(true)
    void exportCsv(snapshotRequest(period, provider, model)).then(
      result => { setExportResult(result); setExporting(false) },
      () => { setExporting(false) },
    )
  }
  const showTarget = (next: Exclude<ChartTarget, undefined>): void => { setTarget(next) }
  const toggleTarget = (next: Exclude<ChartTarget, undefined>): void => {
    setTarget(current => current?.kind === next.kind && current.index === next.index ? undefined : next)
  }

  const heading = (
    <header className={css.header}>
      <div className={css.identity}>
        <span className={css.mark}><UsageLedgerMark size={22} /></span>
        <div>
          <p className={css.eyebrow}>API / LEDGER</p>
          <h2>{t('title')}</h2>
        </div>
      </div>
      <div className={css.headerActions} role="group" aria-label={t('ledgerActions')}>
        {exportCsv === undefined ? null : (
          <button type="button" className={css.refresh} disabled={exporting || snapshot === undefined} onClick={exportLedger}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
              <path d="M8 2v8m-3-3 3 3 3-3M3 10v3h10v-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {exporting ? t('exporting') : t('export')}
          </button>
        )}
        <button type="button" className={css.refresh} disabled={requestStatus === 'loading'} onClick={refresh}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M13 5a5.3 5.3 0 1 0 .2 5.4M13 2v3.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {requestStatus === 'loading' ? t('refreshing') : t('refresh')}
        </button>
      </div>
      <p className={css.intro}>{t('intro')}</p>
    </header>
  )
  const backfill = readStatus === undefined ? null : (
    <UsageBackfillStatus status={workerStatus} stale={workerStatusReadFailed} t={t} />
  )

  const filters = (
      <div className={css.filters} role="group" aria-label={t('filterTitle')}>
        <label>
          <span>{t('provider')}</span>
          <select value={provider} onChange={(event) => { setProvider(event.currentTarget.value); setModel('all') }}>
            <option value="all">{t('allProviders')}</option>
            {providers.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>{t('model')}</span>
          <select value={model} onChange={(event) => { setModel(event.currentTarget.value) }}>
            <option value="all">{t('allModels')}</option>
            {modelOptions.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>{t('period')}</span>
          <select value={period} onChange={(event) => { setPeriod(event.currentTarget.value as Period) }}>
            <option value="all">{t('allTime')}</option>
            <option value="7d">{t('sevenDays')}</option>
            <option value="30d">{t('thirtyDays')}</option>
          </select>
        </label>
      </div>
  )
  const periodLabel = t(period === 'all' ? 'allTime' : period === '7d' ? 'sevenDays' : 'thirtyDays')

  if (snapshot === undefined) {
    return (
      <div className={css.section} aria-busy={requestStatus === 'loading'}>
        {heading}
        {backfill}
        {filters}
        {requestStatus === 'loading' ? <p className={css.status} role="status">{interpolate(t('loadingPeriod'), { period: periodLabel })}</p> : null}
        {requestStatus === 'error' ? (
          <div className={css.failure} role="alert">
            <p>{t('loadFailed')}</p>
            <button type="button" onClick={refresh}>{t('retry')}</button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <section className={css.section} aria-busy={requestStatus === 'loading'}>
      {heading}
      {backfill}

      {requestStatus === 'error' ? (
        <p className={css.stale} role="status">{t('showingLastGood')}</p>
      ) : null}

      <p className={css.updated}>{interpolate(t('updated'), { time: usageTimeText(snapshot.updatedAt) })}</p>
      {exportResult === undefined ? null : (
        <p className={css.updated}>{interpolate(t('exportSaved'), { path: exportResult.path, rows: exactCountText(exportResult.rows) })}</p>
      )}

      {filters}
      {period === 'all' ? <p className={css.historyNote}>{t('allHistoryCharts')}</p> : null}

      {totals.requests === 0 ? <p className={css.empty}>{t('noData')}</p> : (
        <>
          <div className={css.metrics}>
            <div className={css.metricRowPrimary}>
              <Metric label={t('requests')} value={exactCountText(totals.requests)} />
              <Metric label={t('totalTokens')} value={tokenText(totals.input + totals.output + totals.cached)} />
            </div>
            <div className={css.metricRow}>
              <Metric label={t('inputTokens')} value={tokenText(totals.input)} />
              <Metric label={t('outputTokens')} value={tokenText(totals.output)} />
              <Metric label={t('cachedTokens')} value={tokenText(totals.cacheHit)} />
            </div>
            <div className={css.metricRow}>
              <Metric label={t('unmeteredRequests')} value={exactCountText(totals.unmetered)} />
              <Metric label={t('failedRequests')} value={exactCountText(totals.failed)} />
              <Metric label={t('retryRequests')} value={exactCountText(totals.retried)} />
            </div>
          </div>

          <div className={css.charts}>
            <article className={css.chartCard}>
              <div className={css.chartHeading}><h3>{t('requestCurve')}</h3><span>{exactCountText(chartTotals.requests)}</span></div>
              <div className={css.curveChart}>
                <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
                  <path className={css.gridLine} d="M 0 36 H 100" />
                  <path className={css.curve} d={curve} />
                  {buckets.map((bucket, index) => {
                    const x = buckets.length === 1 ? 50 : (index / (buckets.length - 1)) * 100
                    const y = 36 - (bucket.requests / maxRequests) * 30
                    return <circle key={bucket.date} className={css.curvePoint} cx={x} cy={y} r="0.75" />
                  })}
                </svg>
                <div
                  className={css.hitTargets}
                  style={{ '--usage-buckets': buckets.length } as CSSProperties}
                >
                  {buckets.map((bucket, index) => {
                    const next = { kind: 'requests' as const, index }
                    return (
                      <button
                        key={bucket.date}
                        type="button"
                        aria-describedby={target?.kind === 'requests' && target.index === index ? tooltipId : undefined}
                        aria-label={interpolate(t('requestsOn'), { date: bucketDate(bucket), requests: exactCountText(bucket.requests), failed: exactCountText(bucket.failed), retried: exactCountText(bucket.retried) })}
                        onFocus={() => { showTarget(next) }}
                        onPointerEnter={() => { showTarget(next) }}
                        onPointerLeave={() => { setTarget(undefined) }}
                        onClick={() => { toggleTarget(next) }}
                      />
                    )
                  })}
                </div>
              </div>
              {chartAxis}
            </article>

            <article className={css.chartCard}>
              <div className={css.chartHeading}><h3>{t('tokenFlow')}</h3><span>{tokenText(chartTotals.tokens)}</span></div>
              <div className={css.barChart}>
                {buckets.map((bucket, index) => {
                  const next = { kind: 'tokens' as const, index }
                  const barStyle = {
                    '--input-height': `${(bucket.input / maxTokens) * 100}%`,
                    '--output-height': `${(bucket.output / maxTokens) * 100}%`,
                    '--cached-height': `${(bucket.cached / maxTokens) * 100}%`,
                  } as CSSProperties
                  return (
                    <button
                      key={bucket.date}
                      type="button"
                      className={css.tokenBar}
                      style={barStyle}
                      aria-describedby={target?.kind === 'tokens' && target.index === index ? tooltipId : undefined}
                      aria-label={interpolate(t('tokensOn'), {
                        date: bucketDate(bucket),
                        input: tokenText(bucket.input),
                        output: tokenText(bucket.output),
                        cached: tokenText(bucket.cached),
                        total: tokenText(totalOf(bucket)),
                      })}
                      onFocus={() => { showTarget(next) }}
                      onPointerEnter={() => { showTarget(next) }}
                      onPointerLeave={() => { setTarget(undefined) }}
                      onClick={() => { toggleTarget(next) }}
                    >
                      <span className={css.inputBar} />
                      <span className={css.outputBar} />
                      <span className={css.cachedBar} />
                    </button>
                  )
                })}
              </div>
              {chartAxis}
            </article>
          </div>

          <div
            className={`${css.tooltip} ${activeBucket === undefined ? css.tooltipHidden : ''}`}
            id={tooltipId}
            role="tooltip"
            aria-hidden={activeBucket === undefined}
          >
            {activeBucket === undefined ? null : (
              <>
                <strong>{bucketDate(activeBucket)}</strong>
                {target?.kind === 'requests'
                  ? <span>{interpolate(t('requestsOn'), { date: '', requests: exactCountText(activeBucket.requests), failed: exactCountText(activeBucket.failed), retried: exactCountText(activeBucket.retried) }).replace(/^：|^: /, '')}</span>
                  : <span>{interpolate(t('tokensOn'), { date: '', input: tokenText(activeBucket.input), output: tokenText(activeBucket.output), cached: tokenText(activeBucket.cached), total: tokenText(totalOf(activeBucket)) }).replace(/^：|^: /, '')}</span>}
              </>
            )}
          </div>

          <article className={css.tableCard}>
            <div className={css.chartHeading}>
              <h3>{t('modelBreakdown')}</h3>
              <div className={css.tableHeadingActions}>
                <label className={css.providerToggle}>
                  <input type="checkbox" checked={showProvider} onChange={(event) => { setShowProvider(event.currentTarget.checked) }} />
                  <span>{t('showProvider')}</span>
                </label>
                <span>{visibleModels.length}</span>
              </div>
            </div>
            <div className={css.tableScroll}>
              <table>
                <thead><tr><th>{t('tableModel')}</th><th>{t('tableTotal')}</th><th>{t('tableInput')}</th><th>{t('tableOutput')}</th><th>{t('tableCacheHit')}</th><th>{t('tableRequests')}</th><th>{t('tableFailed')}</th><th>{t('tableRetries')}</th></tr></thead>
                <tbody>{visibleModels.map(row => (
                  <tr key={`${row.provider}\u0000${row.model}`}><th scope="row">{modelLabel(row, showProvider)}</th><td>{compactNumberText(totalOf(row))}</td><td>{compactNumberText(row.input)}</td><td>{compactNumberText(row.output)}</td><td>{compactNumberText(row.cacheHit)}</td><td>{compactNumberText(row.requests)}</td><td>{compactNumberText(row.failed)}</td><td>{compactNumberText(row.retried)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </article>
        </>
      )}
    </section>
  )
}

function Metric(
  { label, value, className }:
  { readonly label: string; readonly value: string; readonly className?: string | undefined },
): ReactNode {
  const metricClass = className === undefined ? css.metric : `${css.metric} ${className}`
  return <div className={metricClass}><span>{label}</span><strong>{value}</strong></div>
}
