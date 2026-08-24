import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { UsageDashboardInjected } from './UsageDashboard.js';
/** Install the Plugins card stylesheet and return its disposer. */
export declare function installUsagePluginCardStyles(): () => void;
/** Props composed by the keyed plugin-card slot. */
type UsagePluginCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<'settings.usage'> & InjectFace<UsageDashboardInjected>;
/** Render the Usage dashboard as a read-only expandable plugin card. */
export declare function UsagePluginCard({ t, readSnapshot }: UsagePluginCardProps): import("react").JSX.Element;
export {};
