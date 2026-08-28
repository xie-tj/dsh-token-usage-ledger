import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageLedgerSnapshot } from '../host/types.ts'
import * as styles from './UsageDashboard.module.css'

const css = styles.default

/** Install the dashboard stylesheet and return its disposer.
 * @returns A function that removes the installed stylesheet.
 */
export function installUsageStyles(): () => void {
  return typeof styles.install === 'function' ? styles.install() : () => {}
}

type Period = '7d' | '30d'
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

interface Bucket {
  readonly date: string
  readonly requests: number
  readonly input: number
  readonly output: number
  readonly cached: number
  readonly metered: number
  readonly unmetered: number
  readonly failed: number
  readonly retried: number
}

/** Dependencies supplied from the Usage plugin's apply closure. */
export interface UsageDashboardInjected {
  /** Read the current Host usage snapshot. */
  readSnapshot: () => Promise<UsageLedgerSnapshot>
}

/** Data and translation props consumed by the Usage dashboard in any Settings slot. */
type UsageDashboardProps = PropsLocale<'settings.usage'> & UsageDashboardInjected

type SnapshotState =
  | { readonly status: 'loading'; readonly snapshot: UsageSnapshot | undefined; readonly error: undefined }
  | { readonly status: 'ready'; readonly snapshot: UsageSnapshot; readonly error: undefined }
  | { readonly status: 'error'; readonly snapshot: UsageSnapshot | undefined; readonly error: string }

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function localDay(time: number): string | undefined {
  if (!Number.isFinite(time) || time <= 0) return undefined
  const parts = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(time))
  const year = parts.find(part => part.type === 'year')?.value
  const month = parts.find(part => part.type === 'month')?.value
  const day = parts.find(part => part.type === 'day')?.value
  return year === undefined || month === undefined || day === undefined ? undefined : `${year}-${month}-${day}`
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

function aggregateModels(events: readonly UsageEvent[], showProvider: boolean): readonly ModelRow[] {
  const rows = new Map<string, ModelRow>()
  for (const event of events) {
    const key = showProvider ? `${event.provider}\u0000${event.model}` : event.model
    const current = rows.get(key) ?? {
      provider: showProvider ? event.provider : '',
      model: event.model,
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      cacheHit: 0,
      metered: 0,
      unmetered: 0,
      failed: 0,
      retried: 0,
    }
    rows.set(key, {
      provider: current.provider,
      model: current.model,
      requests: current.requests + 1,
      input: current.input + event.input,
      output: current.output + event.output,
      cached: current.cached + event.cached,
      cacheHit: current.cacheHit + event.cacheHit,
      metered: current.metered + (event.metered ? 1 : 0),
      unmetered: current.unmetered + (event.metered ? 0 : 1),
      failed: current.failed + (event.outcome === 'failure' || event.outcome === 'aborted' ? 1 : 0),
      retried: current.retried + (event.retried ? 1 : 0),
    })
  }
  return [...rows.values()]
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
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => values[key] ?? `{${key}}`)
}

function selectedEvents(
  events: readonly UsageEvent[],
  provider: string,
  model: string,
  period: Period,
  throughDay: string | undefined,
): readonly UsageEvent[] {
  const byProvider = provider === 'all' ? events : events.filter(event => event.provider === provider)
  const byModel = model === 'all' ? byProvider : byProvider.filter(event => event.model === model)
  if (byModel.length === 0) return byModel
  const endDay = throughDay ?? [...byModel]
    .map(event => localDay(event.at))
    .filter((day): day is string => day !== undefined)
    .sort()
    .at(-1)
  if (endDay === undefined) return byModel
  const startDay = shiftDay(endDay, -(period === '7d' ? 6 : 29))
  return byModel.filter((event) => {
    const day = localDay(event.at)
    return day !== undefined && day >= startDay && day <= endDay
  })
}

function bucketsOf(
  events: readonly UsageEvent[],
  period: Period,
  daily: readonly Bucket[],
  throughDay: string | undefined,
  preferDaily: boolean,
): readonly Bucket[] {
  const eventDays = events.map(event => localDay(event.at)).filter((day): day is string => day !== undefined)
  const dailyDays = daily
    .filter(row => row.requests > 0 || row.input > 0 || row.output > 0 || row.cached > 0 || row.failed > 0)
    .map(row => row.date)
  const endDay = throughDay ?? [...(preferDaily ? dailyDays : eventDays)].sort().at(-1) ?? localDay(Date.now()) ?? '1970-01-01'
  const startDay = shiftDay(endDay, -(period === '7d' ? 6 : 29))
  const days: string[] = []
  for (let day = startDay; day <= endDay; day = shiftDay(day, 1)) days.push(day)
  const buckets = days.map(date => ({ date, requests: 0, input: 0, output: 0, cached: 0, metered: 0, unmetered: 0, failed: 0, retried: 0 }))
  const indexByDay = new Map(days.map((day, index) => [day, index] as const))
  if (preferDaily && daily.length > 0) {
    for (const row of daily) {
      const index = indexByDay.get(row.date)
      if (index === undefined) continue
      buckets[index] = { ...row }
    }
    return buckets
  }
  for (const event of events) {
    const day = localDay(event.at)
    const index = day === undefined ? undefined : indexByDay.get(day)
    const bucket = index === undefined ? undefined : buckets[index]
    if (index === undefined || bucket === undefined) continue
    buckets[index] = {
      date: bucket.date,
      requests: bucket.requests + 1,
      input: bucket.input + event.input,
      output: bucket.output + event.output,
      cached: bucket.cached + event.cached,
      metered: bucket.metered + (event.metered ? 1 : 0),
      unmetered: bucket.unmetered + (event.metered ? 0 : 1),
      failed: bucket.failed + (event.outcome === 'failure' || event.outcome === 'aborted' ? 1 : 0),
      retried: bucket.retried + (event.retried ? 1 : 0),
    }
  }
  return buckets
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

/** Render the settings Usage dashboard with local filter and tooltip state. */
export function UsageDashboard({ readSnapshot, t }: UsageDashboardProps): ReactNode {
  const tooltipId = useId()
  const [state, setState] = useState<SnapshotState>({ status: 'loading', snapshot: undefined, error: undefined })
  const [request, setRequest] = useState(0)
  const [provider, setProvider] = useState('all')
  const [model, setModel] = useState('all')
  const [period, setPeriod] = useState<Period>('30d')
  const [showProvider, setShowProvider] = useState(false)
  const [target, setTarget] = useState<ChartTarget>(undefined)

  useEffect(() => {
    let current = true
    setState(previous => ({ status: 'loading', snapshot: previous.snapshot, error: undefined }))
    void readSnapshot().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot: projectSnapshot(snapshot), error: undefined }) },
      (error: unknown) => {
        if (!current) return
        setState(previous => ({
          status: 'error',
          snapshot: previous.snapshot,
          error: error instanceof Error ? error.message : '',
        }))
      },
    )
    return () => { current = false }
  }, [readSnapshot, request])

  const snapshot = state.snapshot
  const models = useMemo(
    () => snapshot === undefined ? [] : [...snapshot.models].sort((left, right) => totalOf(right) - totalOf(left)),
    [snapshot],
  )
  const providers = useMemo(
    () => [...new Set(models.map(row => row.provider))].sort(),
    [models],
  )
  const modelOptions = useMemo(
    () => [...new Set(models
      .filter(row => provider === 'all' || row.provider === provider)
      .map(row => row.model))].sort(),
    [models, provider],
  )
  const events = useMemo(
    () => snapshot === undefined ? [] : selectedEvents(snapshot.events, provider, model, period, snapshot.throughDay),
    [model, period, provider, snapshot],
  )
  const buckets = useMemo(
    () => snapshot === undefined ? [] : bucketsOf(events, period, snapshot.daily, snapshot.throughDay, provider === 'all' && model === 'all'),
    [events, model, period, provider, snapshot],
  )
  const visibleModels = useMemo(
    () => [...aggregateModels(events, showProvider)].sort((left, right) => totalOf(right) - totalOf(left)),
    [events, showProvider],
  )
  const totals = useMemo(() => events.reduce((total, event) => ({
    requests: total.requests + 1,
    input: total.input + event.input,
    output: total.output + event.output,
    cached: total.cached + event.cached,
    cacheHit: total.cacheHit + event.cacheHit,
    unmetered: total.unmetered + (event.metered ? 0 : 1),
    failed: total.failed + (event.outcome === 'failure' || event.outcome === 'aborted' ? 1 : 0),
    retried: total.retried + (event.retried ? 1 : 0),
  }), { requests: 0, input: 0, output: 0, cached: 0, cacheHit: 0, unmetered: 0, failed: 0, retried: 0 }), [events])
  const curve = useMemo(() => curvePath(buckets), [buckets])
  const activeBucket = target === undefined ? undefined : buckets[target.index]
  const maxTokens = Math.max(1, ...buckets.map(bucket => bucket.input + bucket.output + bucket.cached))
  const tokenText = (value: number): string => fullNumberText(value)

  const refresh = (): void => { setRequest(current => current + 1) }
  const showTarget = (next: Exclude<ChartTarget, undefined>): void => { setTarget(next) }
  const toggleTarget = (next: Exclude<ChartTarget, undefined>): void => {
    setTarget(current => current?.kind === next.kind && current.index === next.index ? undefined : next)
  }

  if (snapshot === undefined) {
    return (
      <div className={css.section} aria-busy={state.status === 'loading'}>
        {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
        {state.status === 'error' ? (
          <div className={css.failure} role="alert">
            <p>{t('loadFailed')}</p>
            <button type="button" onClick={refresh}>{t('retry')}</button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <section className={css.section} aria-busy={state.status === 'loading'}>
      <header className={css.header}>
        <div>
          <p className={css.eyebrow}>API / LEDGER</p>
          <h2>{t('title')}</h2>
          <p className={css.intro}>{t('intro')}</p>
        </div>
        <button type="button" className={css.refresh} disabled={state.status === 'loading'} onClick={refresh}>
          {state.status === 'loading' ? t('refreshing') : t('refresh')}
        </button>
      </header>

      {state.status === 'error' ? (
        <p className={css.stale} role="status">{t('showingLastGood')}</p>
      ) : null}
      <p className={css.updated}>{interpolate(t('updated'), { time: snapshot.updatedAt })}</p>

      <div className={css.filters}>
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
            <option value="7d">{t('sevenDays')}</option>
            <option value="30d">{t('thirtyDays')}</option>
          </select>
        </label>
      </div>

      {events.length === 0 ? <p className={css.empty}>{t('noData')}</p> : (
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
              <div className={css.chartHeading}><h3>{t('requestCurve')}</h3><span>{exactCountText(totals.requests)}</span></div>
              <div className={css.curveChart}>
                <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
                  <path className={css.gridLine} d="M 0 36 H 100" />
                  <path className={css.curve} d={curve} />
                  {buckets.map((bucket, index) => {
                    const max = Math.max(1, ...buckets.map(candidate => candidate.requests))
                    const x = buckets.length === 1 ? 50 : (index / (buckets.length - 1)) * 100
                    const y = 36 - (bucket.requests / max) * 30
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
                        aria-label={interpolate(t('requestsOn'), { date: dateText(bucket.date), requests: exactCountText(bucket.requests), failed: exactCountText(bucket.failed), retried: exactCountText(bucket.retried) })}
                        onFocus={() => { showTarget(next) }}
                        onPointerEnter={() => { showTarget(next) }}
                        onPointerLeave={() => { setTarget(undefined) }}
                        onClick={() => { toggleTarget(next) }}
                      />
                    )
                  })}
                </div>
              </div>
            </article>

            <article className={css.chartCard}>
              <div className={css.chartHeading}><h3>{t('tokenFlow')}</h3><span>{tokenText(totals.input + totals.output + totals.cached)}</span></div>
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
                        date: dateText(bucket.date),
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
                <strong>{dateText(activeBucket.date)}</strong>
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
