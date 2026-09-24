/** Usage dashboard page contributed to the Plugins settings page. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { UsageDashboardInjected } from './UsageDashboard.js';
/** Install the Plugins page stylesheet and return its disposer. */
export declare function installUsagePluginCardStyles(): () => void;
/** Props composed by the Plugins page's item slot. */
type UsagePluginCardProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.usage'> & InjectFace<UsageDashboardInjected>;
/** Render the Usage one-liner or the full dashboard, as the Plugins page asks. */
export declare function UsagePluginCard({ view, t, readSnapshot, readStatus, exportCsv }: UsagePluginCardProps): string | import("react").JSX.Element;
export {};
