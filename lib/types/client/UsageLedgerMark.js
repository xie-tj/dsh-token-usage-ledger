import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Render the ledger's bar-chart mark. The mark is decorative: the surrounding
 * text carries the accessible name.
 * @param props - the requested edge length.
 * @returns the inline SVG element.
 */
export function UsageLedgerMark({ size = 20 }) {
    return (_jsxs("svg", { width: size, height: size, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true", focusable: "false", children: [_jsx("rect", { x: "2", y: "11.5", width: "4", height: "6.5", rx: "1.2", fill: "currentColor", opacity: "0.5" }), _jsx("rect", { x: "8", y: "7", width: "4", height: "11", rx: "1.2", fill: "currentColor", opacity: "0.78" }), _jsx("rect", { x: "14", y: "2", width: "4", height: "16", rx: "1.2", fill: "currentColor" })] }));
}
