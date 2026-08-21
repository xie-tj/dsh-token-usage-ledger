import { type ReactNode } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { UsageLedgerSnapshot } from '../host/types.js';
/** Install the dashboard stylesheet and return its disposer.
 * @returns A function that removes the installed stylesheet.
 */
export declare function installUsageStyles(): () => void;
interface UsageEvent {
    readonly at: number;
    readonly model: string;
    readonly input: number;
    readonly output: number;
    readonly cached: number;
    readonly cacheHit: number;
    readonly metered: boolean;
    readonly outcome: 'started' | 'success' | 'failure' | 'aborted';
    readonly retried: boolean;
}
interface ModelRow {
    readonly model: string;
    readonly requests: number;
    readonly input: number;
    readonly output: number;
    readonly cached: number;
    readonly cacheHit: number;
    readonly metered: number;
    readonly unmetered: number;
    readonly failed: number;
    readonly retried: number;
}
interface UsageSnapshot {
    readonly updatedAt: string;
    readonly throughDay: string;
    readonly events: readonly UsageEvent[];
    readonly models: readonly ModelRow[];
    readonly daily: readonly Bucket[];
}
interface Bucket {
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
/** Dependencies supplied from the Usage plugin's apply closure. */
export interface UsageDashboardInjected {
    /** Read the current Host usage snapshot. */
    readSnapshot: () => Promise<UsageLedgerSnapshot>;
}
/** Data and translation props consumed by the Usage dashboard in any Settings slot. */
type UsageDashboardProps = PropsLocale<'settings.usage'> & UsageDashboardInjected;
/**
 * Project the strict Host snapshot into the dashboard's display vocabulary.
 * @param snapshot - validated Host snapshot.
 * @returns normalized values used by charts and model rows.
 */
export declare function projectSnapshot(snapshot: UsageLedgerSnapshot): UsageSnapshot;
/** Render the settings Usage dashboard with local filter and tooltip state. */
export declare function UsageDashboard({ readSnapshot, t }: UsageDashboardProps): ReactNode;
export {};
