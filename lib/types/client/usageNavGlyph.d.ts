/**
 * Paints this plugin's glyph on its own Settings nav row.
 *
 * The shipped shell draws every section glyph from a fixed section-id map, so a
 * registrant cannot name its own mark. This module tags the row whose label is
 * this plugin's own nav label and the stylesheet paints the bar-chart glyph
 * over the shell's fallback. A shell that renders the plugin's glyph itself
 * (the settings.section.glyph seat) marks that element, and the row is left
 * untouched.
 */
/** Row attribute that turns on the glyph rules in the dashboard stylesheet. */
export declare const USAGE_NAV_ROW_ATTRIBUTE = "data-dsh-usage-glyph";
/** Attribute the plugin's own nav glyph element carries. */
export declare const USAGE_NAV_MARK_ATTRIBUTE = "data-usage-ledger-mark";
/**
 * Tag every settings nav row that shows this plugin's label.
 * @param readLabel - current nav label in the active locale.
 * @returns disposer removing the observation and every tag.
 */
export declare function installUsageNavGlyph(readLabel: () => string): () => void;
