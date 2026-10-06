/** Local display time for snapshot and background status metadata. */
/**
 * Format a Host timestamp in the browser's locale and timezone.
 * @param value - Host timestamp, preserved verbatim if it cannot be parsed.
 * @returns a readable date and time including seconds.
 */
export function usageTimeText(value) {
    const time = Date.parse(value);
    if (!Number.isFinite(time))
        return value;
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(time);
}
