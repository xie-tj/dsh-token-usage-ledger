/** Outline bar-chart glyph for the Settings nav rail. */
/** Props of the nav glyph. */
export interface UsageLedgerGlyphProps {
    /** Edge length of the glyph box in pixels. */
    readonly size: number;
}
/**
 * Render the ledger's outline bar-chart glyph. The mark is decorative: the nav
 * row's label carries the accessible name.
 * @param props - the shell's glyph box.
 * @returns the inline SVG element.
 */
export declare function UsageLedgerGlyph({ size }: UsageLedgerGlyphProps): import("react").JSX.Element;
