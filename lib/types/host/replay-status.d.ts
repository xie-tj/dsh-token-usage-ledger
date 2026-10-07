/** Workload pacing changes affect pending replay, not completed history or reader failures. */
import type { UsageLedgerStatus } from './types.js';
/**
 * Resolve replay state after a governor decision.
 * @param status - last worker observation, including completion and failure information.
 * @param mode - whether historical work is currently permitted.
 * @returns next state; completed work stays idle and errors are never cleared by pacing.
 */
export declare function replayStateAfterPace(status: UsageLedgerStatus, mode: 'run' | 'pause'): UsageLedgerStatus['state'];
