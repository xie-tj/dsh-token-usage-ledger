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
export const USAGE_NAV_ROW_ATTRIBUTE = 'data-dsh-usage-glyph';
/** Attribute the plugin's own nav glyph element carries. */
export const USAGE_NAV_MARK_ATTRIBUTE = 'data-usage-ledger-mark';
/** Narrowest scope that contains the settings nav rows. */
const ROW_SCOPE = '[role="dialog"]';
/**
 * Tag every settings nav row that shows this plugin's label.
 * @param readLabel - current nav label in the active locale.
 * @returns disposer removing the observation and every tag.
 */
export function installUsageNavGlyph(readLabel) {
    if (typeof document === 'undefined' || document.body === null)
        return () => { };
    const own = (row) => row.querySelector('svg[' + USAGE_NAV_MARK_ATTRIBUTE + ']') !== null;
    const scan = () => {
        const label = readLabel();
        if (label.length === 0)
            return;
        for (const row of document.querySelectorAll(ROW_SCOPE + ' button')) {
            if (row.textContent?.trim() === label) {
                if (!row.hasAttribute(USAGE_NAV_ROW_ATTRIBUTE) && !own(row))
                    row.setAttribute(USAGE_NAV_ROW_ATTRIBUTE, '');
            }
            else if (row.hasAttribute(USAGE_NAV_ROW_ATTRIBUTE)) {
                row.removeAttribute(USAGE_NAV_ROW_ATTRIBUTE);
            }
        }
    };
    const relevant = (node) => node instanceof Element
        && (node.matches(ROW_SCOPE)
            || node.querySelector(ROW_SCOPE) !== null
            || node.closest('[' + USAGE_NAV_ROW_ATTRIBUTE + ']') !== null);
    // Attribute writes are not observed, so reparsing our own tag cannot loop.
    const observer = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (relevant(node)) {
                    scan();
                    return;
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
    return () => {
        observer.disconnect();
        for (const row of document.querySelectorAll('[' + USAGE_NAV_ROW_ATTRIBUTE + ']')) {
            row.removeAttribute(USAGE_NAV_ROW_ATTRIBUTE);
        }
    };
}
