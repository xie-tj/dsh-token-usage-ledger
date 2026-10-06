/** Bar-chart mark identifying the Usage Ledger on its own surfaces. */
/** Props of the ledger mark. */
export interface UsageLedgerMarkProps {
    /** Rendered edge length in pixels. */
    readonly size?: number;
}
/**
 * Render the ledger's bar-chart mark. The mark is decorative: the surrounding
 * text carries the accessible name.
 * @param props - the requested edge length.
 * @returns the inline SVG element.
 */
export declare function UsageLedgerMark({ size }: UsageLedgerMarkProps): import("react").JSX.Element;
