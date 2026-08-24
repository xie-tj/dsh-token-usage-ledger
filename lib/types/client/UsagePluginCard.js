import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Read-only Usage dashboard card contributed to Plugins settings. */
import { useId, useState } from 'react';
import { UsageDashboard } from "./UsageDashboard.js";
import css from './UsagePluginCard.module.css';
/** Render the Usage dashboard as a read-only expandable plugin card. */
export function UsagePluginCard({ t, readSnapshot }) {
    const [open, setOpen] = useState(false);
    const bodyId = useId();
    return (_jsxs("li", { className: `${css.card} ${open ? css.cardOpen : ''}`, children: [_jsxs("button", { type: "button", className: css.header, "aria-expanded": open, "aria-controls": bodyId, "aria-label": `${t(open ? 'collapse' : 'expand')}: ${t('title')}`, onClick: () => { setOpen(current => !current); }, children: [_jsxs("span", { className: css.headText, children: [_jsx("span", { className: css.name, children: t('title') }), _jsx("span", { className: css.description, children: t('intro') })] }), _jsx("span", { className: `${css.chevron} ${open ? css.chevronOpen : ''}`, "aria-hidden": "true", children: "\u2304" })] }), open ? (_jsx("div", { id: bodyId, className: css.body, children: _jsx(UsageDashboard, { t: t, readSnapshot: readSnapshot }) })) : null] }));
}
