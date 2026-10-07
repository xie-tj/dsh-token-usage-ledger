import {describe,expect,it} from 'vitest'
import {replayStateAfterPace} from '../src/host/replay-status.ts'
import type {UsageLedgerStatus} from '../src/host/types.ts'
const status:UsageLedgerStatus={state:'running',totalSessions:4,processedSessions:1,processedEvents:12,backfillDays:30,backfillScope:'all',updatedAt:'2026-10-07T00:00:00Z'}
describe('Replay state after workload pacing',()=>{
 it('pauses pending history and clears that pause as soon as pacing resumes',()=>{
  const paused={...status,state:replayStateAfterPace(status,'pause')}
  expect(paused.state).toBe('paused')
  expect(replayStateAfterPace(paused,'run')).toBe('running')
 })
 it('keeps completed history idle when the workload governor pauses',()=>{
  expect(replayStateAfterPace({...status,state:'idle',processedSessions:4},'pause')).toBe('idle')
  expect(replayStateAfterPace({...status,state:'paused',processedSessions:4},'run')).toBe('idle')
 })
 it('does not erase unsupported-reader or failed states when pacing resumes',()=>{
  expect(replayStateAfterPace({...status,state:'paused',lastError:'reader unavailable'},'run')).toBe('paused')
  expect(replayStateAfterPace({...status,state:'failed',lastError:'storage error'},'run')).toBe('failed')
 })
})
