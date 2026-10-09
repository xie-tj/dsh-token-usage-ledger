import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { usageTimeText } from "./usageTime.js";
import * as styles from './UsageDashboard.module.css';
const css = styles.default;
const titles = {
    running: 'backfillStateRunning', resuming: 'backfillStateResuming', paused: 'backfillStatePaused', failed: 'backfillStateFailed',
    complete: 'backfillStateComplete', incomplete: 'backfillStateIncomplete', waiting: 'backfillStateWaiting',
    loading: 'backfillStateLoading', unavailable: 'backfillStateUnavailable',
};
const descriptions = {
    running: 'backfillRunningHint', resuming: 'backfillResumingHint', paused: 'backfillPausedHint', failed: 'backfillFailedHint',
    complete: 'backfillCompleteHint', incomplete: 'backfillIncompleteHint', waiting: 'backfillWaitingHint',
    loading: 'backfillLoadingHint', unavailable: 'backfillUnavailableHint',
};
function interpolate(template, values) {
    return template.replace(/\{([^}]+)\}/g, (_, key) => values[key] ?? '{' + key + '}');
}
/**
 * Render worker state without deriving completion from an unknown session count.
 * @param props - latest worker status and localized labels.
 * @returns a status card; progress measures completed sessions, not tokens or time.
 */
export function UsageBackfillStatus({ status, stale, t }) {
    const knownTotal = status !== undefined && (status.totalSessions > 0 || status.historyComplete === true);
    const phase = status === undefined
        ? stale ? 'unavailable' : 'loading'
        : status.lastError !== undefined || status.state === 'failed'
            ? 'failed'
            : knownTotal && status.processedSessions >= status.totalSessions && (status.state === 'idle' || status.state === 'paused')
                ? 'complete'
                : status.state === 'paused' && status.pace?.mode === 'run'
                    ? 'resuming'
                    : status.state === 'idle'
                        ? knownTotal && status.processedSessions > 0 ? 'incomplete' : 'waiting'
                        : status.state;
    const percent = knownTotal
        ? status.totalSessions === 0 ? 100 : Math.min(100, Math.max(0, Math.round(status.processedSessions / status.totalSessions * 1000) / 10))
        : undefined;
    const number = (value) => new Intl.NumberFormat().format(value);
    const sessions = status === undefined ? '—' : number(status.processedSessions) + ' / ' + (knownTotal ? number(status.totalSessions) : '—');
    const reason = phase === 'paused' && status?.pace?.mode === 'pause' ? status.pace.reason : undefined;
    const remaining = knownTotal && status !== undefined ? Math.max(0, status.totalSessions - status.processedSessions) : 0;
    const detail = phase === 'incomplete'
        ? interpolate(t('backfillIncompleteHint'), { remaining: number(remaining) })
        : t(reason === 'battery' ? 'backfillPausedBattery'
            : reason === 'memory' ? 'backfillPausedMemory'
                : reason === 'event-loop' ? 'backfillPausedEventLoop' : descriptions[phase]);
    // A retained error stays visible in every phase: an idle or completed frame must not hide it.
    const error = status?.lastError;
    const scope = status === undefined ? undefined : status.backfillScope === 'all'
        ? t('backfillScopeAll')
        : interpolate(t('backfillScopeRecent'), { days: number(status.backfillDays) });
    return (_jsxs("section", { className: css.backfill, role: "region", "aria-label": t('backfillTitle'), "data-phase": phase, children: [_jsxs("div", { className: css.backfillHeading, children: [_jsx("h3", { children: t('backfillTitle') }), _jsxs("span", { className: css.backfillBadge, role: "status", children: [_jsx("span", { className: css.backfillSignal, "aria-hidden": "true" }), t(titles[phase])] })] }), _jsx("p", { className: css.backfillDescription, children: detail }), (status?.reusedSessions ?? 0) > 0 ? _jsx("p", { className: css.backfillDescription, children: interpolate(t('backfillReused'), { sessions: number(status?.reusedSessions ?? 0) }) }) : null, (status?.unreadableSessions ?? 0) > 0 ? _jsx("p", { className: css.backfillDescription, children: interpolate(t('backfillUnreadable'), { sessions: number(status?.unreadableSessions ?? 0) }) }) : null, error === undefined ? null : _jsx("p", { className: css.backfillError, children: error }), status === undefined && stale ? null : (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.backfillProgressHeading, children: [_jsx("span", { children: t('backfillProgress') }), _jsx("strong", { children: percent === undefined
                                    ? t(phase === 'running' || phase === 'loading' ? 'backfillDiscovering' : 'backfillProgressPending')
                                    : number(percent) + '%' })] }), _jsx("div", { className: css.backfillTrack, role: "progressbar", "aria-label": t('backfillProgress'), "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent, "aria-valuetext": knownTotal ? interpolate(t('backfillSessionProgress'), { sessions }) : undefined, "data-indeterminate": percent === undefined ? 'true' : undefined, children: _jsx("span", { className: css.backfillFill, style: { width: percent === undefined ? phase === 'running' || phase === 'loading' ? '30%' : '0%' : percent + '%' } }) }), _jsxs("dl", { className: css.backfillStats, children: [_jsxs("div", { children: [_jsx("dt", { children: t('backfillSessions') }), _jsx("dd", { children: sessions })] }), _jsxs("div", { children: [_jsx("dt", { children: t('backfillEvents') }), _jsx("dd", { children: status === undefined ? '—' : number(status.processedEvents) })] }), _jsxs("div", { children: [_jsx("dt", { children: t('backfillRemaining') }), _jsx("dd", { children: knownTotal ? number(Math.max(0, status.totalSessions - status.processedSessions)) : '—' })] }), (status?.workerRssMiB ?? 0) > 0 ? _jsxs("div", { children: [_jsx("dt", { children: t('backfillMemory') }), _jsx("dd", { children: String(number(status?.workerRssMiB ?? 0)) + ' MiB' })] }) : null] })] })), status === undefined ? null : (_jsxs("div", { className: css.backfillMeta, children: [_jsxs("span", { children: [t('backfillScope'), ": ", scope] }), _jsx("span", { children: interpolate(t('backfillStatusUpdated'), { time: usageTimeText(status.updatedAt) }) })] })), status !== undefined && stale ? _jsx("p", { className: css.backfillStale, role: "status", children: t('backfillStale') }) : null] }));
}
