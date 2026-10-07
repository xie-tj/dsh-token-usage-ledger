/** Workload pacing changes affect pending replay, not completed history or reader failures. */
import type { UsageLedgerStatus } from './types.ts'

/**
 * Resolve replay state after a governor decision.
 * @param status - last worker observation, including completion and failure information.
 * @param mode - whether historical work is currently permitted.
 * @returns next state; completed work stays idle and errors are never cleared by pacing.
 */
export function replayStateAfterPace(status: UsageLedgerStatus, mode: 'run' | 'pause'): UsageLedgerStatus['state'] {
  if(status.lastError!==undefined || status.state==='failed')return status.state
  const complete=status.totalSessions>0 && status.processedSessions>=status.totalSessions
  if(complete && (status.state==='idle' || status.state==='paused'))return 'idle'
  if(mode==='pause')return complete?status.state:'paused'
  return status.state==='paused'?'running':status.state
}
