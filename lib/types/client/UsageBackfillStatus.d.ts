/** Background accounting state and session-based replay progress. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { UsageLedgerStatus } from '../host/types.js';
type Props = PropsLocale<'settings.usage'> & {
    readonly status: UsageLedgerStatus | undefined;
    /** A failed poll retains the last successful progress counters. */
    readonly stale: boolean;
};
/**
 * Render worker state without deriving completion from an unknown session count.
 * @param props - latest worker status and localized labels.
 * @returns a status card; progress measures completed sessions, not tokens or time.
 */
export declare function UsageBackfillStatus({ status, stale, t }: Props): import("react").JSX.Element;
export {};
