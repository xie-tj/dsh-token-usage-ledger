/** Calendar aggregation for charts covering every day in the requested range. */

/** Disjoint daily usage counters returned by the Host. */
export interface UsageChartDay {
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

/** One visible interval, including partial weeks, months, or years at either edge. */
export interface UsageChartBucket extends UsageChartDay {
  readonly endDate: string
}

/** Calendar units used to keep long histories legible without discarding days. */
export type UsageChartGrain = 'day' | 'week' | 'month' | 'year'

/** Full coverage and the grain represented by each plotted interval. */
export interface UsageChartSeries {
  readonly buckets: readonly UsageChartBucket[]
  readonly grain: UsageChartGrain
  readonly yearsPerBucket: number
  readonly fromDay: string | undefined
  readonly throughDay: string | undefined
}

// A presentation density shared by the two charts, not a retention limit.
const MAX_COLUMNS = 60
const DAY_MS = 86_400_000
const COUNTERS = ['requests', 'input', 'output', 'cached', 'metered', 'unmetered', 'failed', 'retried'] as const

function dayNumber(date: string): number {
  return Date.parse(date + 'T00:00:00Z') / DAY_MS
}

function dayText(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function monthNumber(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1
}

function monthStart(month: number): number {
  const date = new Date(0)
  date.setUTCFullYear(Math.floor(month / 12), month % 12, 1)
  return date.getTime() / DAY_MS
}

/**
 * Aggregate the complete daily series into at most 60 calendar intervals.
 * @param daily - all daily counters in the selected range; the input is never mutated.
 * @returns chronological buckets covering the first through last day, preserving every counter.
 * Short ranges stay daily; longer ones use Monday-based weeks, months, or years.
 * Empty intervals are retained, and boundary intervals are clipped to actual range dates.
 */
export function usageChartSeries(daily: readonly UsageChartDay[]): UsageChartSeries {
  const ordered = [...daily].sort((left, right) => left.date.localeCompare(right.date))
  const first = ordered[0]
  const last = ordered.at(-1)
  if (first === undefined || last === undefined) return { buckets: [], grain: 'day', yearsPerBucket: 1, fromDay: undefined, throughDay: undefined }
  const from = dayNumber(first.date)
  const through = dayNumber(last.date)
  let grain: UsageChartGrain
  let yearsPerBucket = 1
  if (through - from + 1 <= MAX_COLUMNS) grain = 'day'
  else if (Math.floor((through + 3) / 7) - Math.floor((from + 3) / 7) + 1 <= MAX_COLUMNS) grain = 'week'
  else if (monthNumber(last.date) - monthNumber(first.date) + 1 <= MAX_COLUMNS) grain = 'month'
  else {
    grain = 'year'
    const firstYear = Number(first.date.slice(0, 4))
    const lastYear = Number(last.date.slice(0, 4))
    yearsPerBucket = Math.max(1, Math.ceil((lastYear - firstYear + 1) / MAX_COLUMNS))
    while (Math.floor(lastYear / yearsPerBucket) - Math.floor(firstYear / yearsPerBucket) + 1 > MAX_COLUMNS) yearsPerBucket += 1
  }
  const indexOf = (date: string): number => {
    if (grain === 'day') return dayNumber(date)
    if (grain === 'week') return Math.floor((dayNumber(date) + 3) / 7)
    if (grain === 'month') return monthNumber(date)
    return Math.floor(Number(date.slice(0, 4)) / yearsPerBucket)
  }
  const startOf = (index: number): number => {
    if (grain === 'day') return index
    if (grain === 'week') return index * 7 - 3
    if (grain === 'month') return monthStart(index)
    return monthStart(index * yearsPerBucket * 12)
  }
  const firstIndex = indexOf(first.date)
  const lastIndex = indexOf(last.date)
  const buckets: UsageChartBucket[] = []
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    buckets.push({
      date: dayText(Math.max(from, startOf(index))),
      endDate: dayText(Math.min(through, startOf(index + 1) - 1)),
      requests: 0, input: 0, output: 0, cached: 0, metered: 0, unmetered: 0, failed: 0, retried: 0,
    })
  }
  for (const row of ordered) {
    const index = indexOf(row.date) - firstIndex
    const current = buckets[index]
    if (current === undefined) throw new Error('Daily usage falls outside its chart interval')
    const bucket = { ...current }
    for (const counter of COUNTERS) bucket[counter] += row[counter]
    buckets[index] = bucket
  }
  return { buckets, grain, yearsPerBucket, fromDay: first.date, throughDay: last.date }
}
