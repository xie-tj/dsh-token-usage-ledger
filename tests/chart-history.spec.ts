import { describe, expect, it } from 'vitest'
import { usageChartSeries, type UsageChartDay } from '../src/client/usageChart.ts'

const counters = ['requests','input','output','cached','metered','unmetered','failed','retried'] as const
function row(date: string, value = 1): UsageChartDay {
  return {date,requests:value,input:value*11,output:value*3,cached:value*7,metered:value,unmetered:0,failed:value*2,retried:value*4}
}
function days(start: string, count: number) {
  const from=Date.parse(start+'T00:00:00Z')
  return Array.from({length:count},(_,index)=>row(new Date(from+index*86400000).toISOString().slice(0,10),index%7+1))
}
function assertPreserved(input: readonly UsageChartDay[]) {
  const before=input.map(value=>({...value}))
  const series=usageChartSeries(input)
  expect(input).toEqual(before)
  expect(series.buckets.length).toBeLessThanOrEqual(60)
  for(const counter of counters)expect(series.buckets.reduce((sum,bucket)=>sum+bucket[counter],0)).toBe(input.reduce((sum,bucket)=>sum+bucket[counter],0))
  return series
}

describe('Complete historical chart series',()=>{
  it.each([7,30,52])('keeps all %i daily buckets without truncation', count=>{
    const input=days('2026-08-17',count)
    const series=assertPreserved(input)
    expect(series.grain).toBe('day')
    expect(series.buckets).toEqual(input.map(value=>({...value,endDate:value.date})))
  })

  it('includes old and new data in Monday-based weeks and clips partial edge weeks',()=>{
    const input=days('2026-07-10',90)
    const series=assertPreserved(input)
    expect(series.grain).toBe('week')
    expect(series.fromDay).toBe('2026-07-10')
    expect(series.throughDay).toBe('2026-10-07')
    expect(series.buckets[0]).toMatchObject({date:'2026-07-10',endDate:'2026-07-12'})
    expect(series.buckets.at(-1)).toMatchObject({date:'2026-10-05',endDate:'2026-10-07'})
  })

  it('aggregates multiple years by calendar month without losing the earliest month',()=>{
    const input=days('2024-01-13',800)
    const series=assertPreserved(input)
    expect(series.grain).toBe('month')
    expect(series.buckets[0]).toMatchObject({date:'2024-01-13',endDate:'2024-01-31'})
    expect(series.buckets.at(-1)?.endDate).toBe(input.at(-1)?.date)
  })

  it('uses years for long histories while preserving every counter',()=>{
    const input=days('2017-01-04',3500)
    const series=assertPreserved(input)
    expect(series.grain).toBe('year')
    expect(series.yearsPerBucket).toBe(1)
    expect(series.buckets[0].date).toBe('2017-01-04')
    expect(series.buckets.at(-1)?.endDate).toBe(input.at(-1)?.date)
  })

  it('bounds century-long rendering by combining years, not by dropping old days',()=>{
    const input=days('1900-01-02',46000)
    const series=assertPreserved(input)
    expect(series.grain).toBe('year')
    expect(series.yearsPerBucket).toBeGreaterThan(1)
    expect(series.fromDay).toBe(input[0].date)
    expect(series.buckets.at(-1)?.endDate).toBe(input.at(-1)?.date)
  })

  it('keeps empty calendar intervals between sparse records',()=>{
    const series=assertPreserved([row('2026-10-01',3),row('2026-08-01',5)])
    expect(series.grain).toBe('week')
    expect(series.buckets[0].date).toBe('2026-08-01')
    expect(series.buckets.some(bucket=>bucket.requests===0)).toBe(true)
    expect(series.buckets.at(-1)?.endDate).toBe('2026-10-01')
  })

  it('does not invent a date range for empty data',()=>{
    expect(usageChartSeries([])).toEqual({buckets:[],grain:'day',yearsPerBucket:1,fromDay:undefined,throughDay:undefined})
  })
})
