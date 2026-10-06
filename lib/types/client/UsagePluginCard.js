import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { UsageDashboard } from "./UsageDashboard.js";
import { UsageLedgerMark } from "./UsageLedgerMark.js";
import * as styles from './UsagePluginCard.module.css';
const css = styles.default;
/** Install the Plugins page stylesheet and return its disposer. */
export function installUsagePluginCardStyles() {
    return typeof styles.install === 'function' ? styles.install() : () => { };
}
/** Render the Usage one-liner or the full dashboard, as the Plugins page asks. */
export function UsagePluginCard({ view, t, readSnapshot, readStatus, exportCsv }) {
    if (view === 'summary') {
        return (_jsxs("span", { className: css.summary, children: [_jsx(UsageLedgerMark, { size: 14 }), t('intro')] }));
    }
    return (_jsx("div", { className: css.body, children: _jsx(UsageDashboard, { t: t, readSnapshot: readSnapshot, readStatus: readStatus, exportCsv: exportCsv }) }));
}
