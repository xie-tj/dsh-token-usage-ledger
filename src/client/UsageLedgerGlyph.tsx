/** Outline bar-chart glyph for the Settings nav rail. */

/** Props of the nav glyph. */
export interface UsageLedgerGlyphProps {
  /** Edge length of the glyph box in pixels. */
  readonly size: number
}

/**
 * Render the ledger's outline bar-chart glyph. The mark is decorative: the nav
 * row's label carries the accessible name.
 * @param props - the shell's glyph box.
 * @returns the inline SVG element.
 */
export function UsageLedgerGlyph({ size }: UsageLedgerGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.15" y="9.35" width="3" height="4.5" rx="0.9" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6.65" y="6.1" width="3" height="7.75" rx="0.9" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11.15" y="2.85" width="3" height="11" rx="0.9" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
