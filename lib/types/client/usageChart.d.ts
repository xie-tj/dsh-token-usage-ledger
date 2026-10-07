/** Calendar aggregation for charts covering every day in the requested range. */
/** Disjoint daily usage counters returned by the Host. */
export interface UsageChartDay {
    readonly date: string;
    readonly requests: number;
    readonly input: number;
    readonly output: number;
    readonly cached: number;
    readonly metered: number;
    readonly unmetered: number;
    readonly failed: number;
    readonly retried: number;
}
/** One visible interval, including partial weeks, months, or years at either edge. */
export interface UsageChartBucket extends UsageChartDay {
    readonly endDate: string;
}
/** Calendar units used to keep long histories legible without discarding days. */
export type UsageChartGrain = 'day' | 'week' | 'month' | 'year';
/** Full coverage and the grain represented by each plotted interval. */
export interface UsageChartSeries {
    readonly buckets: readonly UsageChartBucket[];
    readonly grain: UsageChartGrain;
    readonly yearsPerBucket: number;
    readonly fromDay: string | undefined;
    readonly throughDay: string | undefined;
}
/**
 * Aggregate the complete daily series into at most 60 calendar intervals.
 * @param daily - all daily counters in the selected range; the input is never mutated.
 * @returns chronological buckets covering the first through last day, preserving every counter.
 * Short ranges stay daily; longer ones use Monday-based weeks, months, or years.
 * Empty intervals are retained, and boundary intervals are clipped to actual range dates.
 */
export declare function usageChartSeries(daily: readonly UsageChartDay[]): UsageChartSeries;
