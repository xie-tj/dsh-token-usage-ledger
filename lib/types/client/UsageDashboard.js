import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useId, useMemo, useState } from 'react';
import * as styles from './UsageDashboard.module.css';
const css = styles.default;
/** Install the dashboard stylesheet and return its disposer.
 * @returns A function that removes the installed stylesheet.
 */
export function installUsageStyles() {
    return typeof styles.install === 'function' ? styles.install() : () => { };
}
function shiftDay(day, offset) {
    const date = new Date(`${day}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
}
function localDay(time) {
    if (!Number.isFinite(time) || time <= 0)
        return undefined;
    const parts = new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(time));
    const year = parts.find(part => part.type === 'year')?.value;
    const month = parts.find(part => part.type === 'month')?.value;
    const day = parts.find(part => part.type === 'day')?.value;
    return year === undefined || month === undefined || day === undefined ? undefined : `${year}-${month}-${day}`;
}
function mergeModelRows(rows) {
    const merged = new Map();
    for (const row of rows) {
        const current = merged.get(row.model);
        if (current === undefined) {
            merged.set(row.model, row);
            continue;
        }
        merged.set(row.model, {
            model: current.model,
            requests: current.requests + row.requests,
            input: current.input + row.input,
            output: current.output + row.output,
            cached: current.cached + row.cached,
            cacheHit: current.cacheHit + row.cacheHit,
            metered: current.metered + row.metered,
            unmetered: current.unmetered + row.unmetered,
            failed: current.failed + row.failed,
            retried: current.retried + row.retried,
        });
    }
    return [...merged.values()];
}
function aggregateModels(events) {
    const rows = new Map();
    for (const event of events) {
        const current = rows.get(event.model) ?? {
            model: event.model,
            requests: 0,
            input: 0,
            output: 0,
            cached: 0,
            cacheHit: 0,
            metered: 0,
            unmetered: 0,
            failed: 0,
            retried: 0,
        };
        rows.set(event.model, {
            model: current.model,
            requests: current.requests + 1,
            input: current.input + event.input,
            output: current.output + event.output,
            cached: current.cached + event.cached,
            cacheHit: current.cacheHit + event.cacheHit,
            metered: current.metered + (event.metered ? 1 : 0),
            unmetered: current.unmetered + (event.metered ? 0 : 1),
            failed: current.failed + (event.outcome === 'failure' || event.outcome === 'aborted' ? 1 : 0),
            retried: current.retried + (event.retried ? 1 : 0),
        });
    }
    return [...rows.values()];
}
/**
 * Project the strict Host snapshot into the dashboard's display vocabulary.
 * @param snapshot - validated Host snapshot.
 * @returns normalized values used by charts and model rows.
 */
export function projectSnapshot(snapshot) {
    const events = snapshot.events.map(event => {
        const hasUsage = event.inputTokens !== undefined
            || event.outputTokens !== undefined
            || event.cacheReadTokens !== undefined
            || event.cacheWriteTokens !== undefined;
        return {
            at: event.at,
            model: `${event.provider} / ${event.model}`,
            input: event.inputTokens ?? 0,
            output: event.outputTokens ?? 0,
            cached: (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0),
            cacheHit: event.cacheReadTokens ?? 0,
            metered: hasUsage,
            outcome: event.outcome,
            retried: event.retried,
        };
    });
    const models = mergeModelRows(snapshot.models.map(row => ({
        model: `${row.provider} / ${row.model}`,
        requests: row.requests,
        input: row.inputTokens,
        output: row.outputTokens,
        cached: row.cacheReadTokens + row.cacheWriteTokens,
        cacheHit: row.cacheReadTokens,
        metered: row.meteredRequests,
        unmetered: row.unmeteredRequests,
        failed: row.failedRequests,
        retried: row.retryRequests,
    })));
    const daily = snapshot.daily.map(row => ({
        date: row.day,
        requests: row.requests,
        input: row.inputTokens,
        output: row.outputTokens,
        cached: row.cacheReadTokens + row.cacheWriteTokens,
        metered: row.meteredRequests,
        unmetered: row.unmeteredRequests,
        failed: row.failedRequests,
        retried: row.retryRequests,
    }));
    return {
        updatedAt: snapshot.updatedAt,
        throughDay: snapshot.throughDay,
        events,
        models,
        daily,
    };
}
function exactCountText(value) {
    return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 0,
        notation: 'standard',
        useGrouping: false,
    }).format(value);
}
function fullNumberText(value) {
    return new Intl.NumberFormat().format(value);
}
function compactNumberText(value) {
    return new Intl.NumberFormat('en-US', {
        compactDisplay: 'short',
        maximumFractionDigits: 2,
        notation: 'compact',
        useGrouping: false,
    }).format(value);
}
function dateText(value) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}
function interpolate(template, values) {
    return template.replace(/\{([^}]+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}
function selectedEvents(events, model, period, throughDay) {
    const byModel = model === 'all' ? events : events.filter(event => event.model === model);
    if (byModel.length === 0)
        return byModel;
    const endDay = throughDay ?? [...byModel]
        .map(event => localDay(event.at))
        .filter((day) => day !== undefined)
        .sort()
        .at(-1);
    if (endDay === undefined)
        return byModel;
    const startDay = shiftDay(endDay, -(period === '7d' ? 6 : 29));
    return byModel.filter((event) => {
        const day = localDay(event.at);
        return day !== undefined && day >= startDay && day <= endDay;
    });
}
function bucketsOf(events, period, daily, throughDay, preferDaily) {
    const eventDays = events.map(event => localDay(event.at)).filter((day) => day !== undefined);
    const dailyDays = daily
        .filter(row => row.requests > 0 || row.input > 0 || row.output > 0 || row.cached > 0 || row.failed > 0)
        .map(row => row.date);
    const endDay = throughDay ?? [...(preferDaily ? dailyDays : eventDays)].sort().at(-1) ?? localDay(Date.now()) ?? '1970-01-01';
    const startDay = shiftDay(endDay, -(period === '7d' ? 6 : 29));
    const days = [];
    for (let day = startDay; day <= endDay; day = shiftDay(day, 1))
        days.push(day);
    const buckets = days.map(date => ({ date, requests: 0, input: 0, output: 0, cached: 0, metered: 0, unmetered: 0, failed: 0, retried: 0 }));
    const indexByDay = new Map(days.map((day, index) => [day, index]));
    if (preferDaily && daily.length > 0) {
        for (const row of daily) {
            const index = indexByDay.get(row.date);
            if (index === undefined)
                continue;
            buckets[index] = { ...row };
        }
        return buckets;
    }
    for (const event of events) {
        const day = localDay(event.at);
        const index = day === undefined ? undefined : indexByDay.get(day);
        const bucket = index === undefined ? undefined : buckets[index];
        if (index === undefined || bucket === undefined)
            continue;
        buckets[index] = {
            date: bucket.date,
            requests: bucket.requests + 1,
            input: bucket.input + event.input,
            output: bucket.output + event.output,
            cached: bucket.cached + event.cached,
            metered: bucket.metered + (event.metered ? 1 : 0),
            unmetered: bucket.unmetered + (event.metered ? 0 : 1),
            failed: bucket.failed + (event.outcome === 'failure' || event.outcome === 'aborted' ? 1 : 0),
            retried: bucket.retried + (event.retried ? 1 : 0),
        };
    }
    return buckets;
}
function curvePath(buckets) {
    const max = Math.max(1, ...buckets.map(bucket => bucket.requests));
    const points = buckets.map((bucket, index) => ({
        x: buckets.length === 1 ? 50 : (index / (buckets.length - 1)) * 100,
        y: 36 - (bucket.requests / max) * 30,
    }));
    if (points.length === 0)
        return '';
    if (points.length === 1)
        return `M ${points[0]?.x ?? 0} ${points[0]?.y ?? 36}`;
    let path = `M ${points[0]?.x ?? 0} ${points[0]?.y ?? 36}`;
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const point = points[index];
        if (previous === undefined || point === undefined)
            continue;
        const midpoint = (previous.x + point.x) / 2;
        path += ` Q ${midpoint} ${previous.y}, ${point.x} ${point.y}`;
    }
    return path;
}
function totalOf(row) {
    return row.input + row.output + row.cached;
}
/** Render the settings Usage dashboard with local filter and tooltip state. */
export function UsageDashboard({ readSnapshot, t }) {
    const tooltipId = useId();
    const [state, setState] = useState({ status: 'loading', snapshot: undefined, error: undefined });
    const [request, setRequest] = useState(0);
    const [model, setModel] = useState('all');
    const [period, setPeriod] = useState('30d');
    const [target, setTarget] = useState(undefined);
    useEffect(() => {
        let current = true;
        setState(previous => ({ status: 'loading', snapshot: previous.snapshot, error: undefined }));
        void readSnapshot().then((snapshot) => { if (current)
            setState({ status: 'ready', snapshot: projectSnapshot(snapshot), error: undefined }); }, (error) => {
            if (!current)
                return;
            setState(previous => ({
                status: 'error',
                snapshot: previous.snapshot,
                error: error instanceof Error ? error.message : '',
            }));
        });
        return () => { current = false; };
    }, [readSnapshot, request]);
    const snapshot = state.snapshot;
    const models = useMemo(() => snapshot === undefined ? [] : [...snapshot.models].sort((left, right) => totalOf(right) - totalOf(left)), [snapshot]);
    const events = useMemo(() => snapshot === undefined ? [] : selectedEvents(snapshot.events, model, period, snapshot.throughDay), [model, period, snapshot]);
    const buckets = useMemo(() => snapshot === undefined ? [] : bucketsOf(events, period, snapshot.daily, snapshot.throughDay, model === 'all'), [events, model, period, snapshot]);
    const visibleModels = useMemo(() => [...aggregateModels(events)].sort((left, right) => totalOf(right) - totalOf(left)), [events]);
    const totals = useMemo(() => events.reduce((total, event) => ({
        requests: total.requests + 1,
        input: total.input + event.input,
        output: total.output + event.output,
        cached: total.cached + event.cached,
        unmetered: total.unmetered + (event.metered ? 0 : 1),
        failed: total.failed + (event.outcome === 'failure' || event.outcome === 'aborted' ? 1 : 0),
        retried: total.retried + (event.retried ? 1 : 0),
    }), { requests: 0, input: 0, output: 0, cached: 0, unmetered: 0, failed: 0, retried: 0 }), [events]);
    const curve = useMemo(() => curvePath(buckets), [buckets]);
    const activeBucket = target === undefined ? undefined : buckets[target.index];
    const maxTokens = Math.max(1, ...buckets.map(bucket => bucket.input + bucket.output + bucket.cached));
    const tokenText = (value) => fullNumberText(value);
    const refresh = () => { setRequest(current => current + 1); };
    const showTarget = (next) => { setTarget(next); };
    const toggleTarget = (next) => {
        setTarget(current => current?.kind === next.kind && current.index === next.index ? undefined : next);
    };
    if (snapshot === undefined) {
        return (_jsxs("div", { className: css.section, "aria-busy": state.status === 'loading', children: [state.status === 'loading' ? _jsx("p", { className: css.status, children: t('loading') }) : null, state.status === 'error' ? (_jsxs("div", { className: css.failure, role: "alert", children: [_jsx("p", { children: t('loadFailed') }), _jsx("button", { type: "button", onClick: refresh, children: t('retry') })] })) : null] }));
    }
    return (_jsxs("section", { className: css.section, "aria-busy": state.status === 'loading', children: [_jsxs("header", { className: css.header, children: [_jsxs("div", { children: [_jsx("p", { className: css.eyebrow, children: "API / LEDGER" }), _jsx("h2", { children: t('title') }), _jsx("p", { className: css.intro, children: t('intro') })] }), _jsx("button", { type: "button", className: css.refresh, disabled: state.status === 'loading', onClick: refresh, children: state.status === 'loading' ? t('refreshing') : t('refresh') })] }), state.status === 'error' ? (_jsx("p", { className: css.stale, role: "status", children: t('showingLastGood') })) : null, _jsx("p", { className: css.updated, children: interpolate(t('updated'), { time: snapshot.updatedAt }) }), _jsxs("div", { className: css.filters, children: [_jsxs("label", { children: [_jsx("span", { children: t('model') }), _jsxs("select", { value: model, onChange: (event) => { setModel(event.currentTarget.value); }, children: [_jsx("option", { value: "all", children: t('allModels') }), models.map(row => _jsx("option", { value: row.model, children: row.model }, row.model))] })] }), _jsxs("label", { children: [_jsx("span", { children: t('period') }), _jsxs("select", { value: period, onChange: (event) => { setPeriod(event.currentTarget.value); }, children: [_jsx("option", { value: "7d", children: t('sevenDays') }), _jsx("option", { value: "30d", children: t('thirtyDays') })] })] })] }), events.length === 0 ? _jsx("p", { className: css.empty, children: t('noData') }) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.metrics, children: [_jsx(Metric, { className: css.metricTotal, label: t('totalTokens'), value: tokenText(totals.input + totals.output + totals.cached) }), _jsx(Metric, { label: t('requests'), value: exactCountText(totals.requests) }), _jsx(Metric, { label: t('inputTokens'), value: tokenText(totals.input) }), _jsx(Metric, { label: t('outputTokens'), value: tokenText(totals.output) }), _jsx(Metric, { label: t('unmeteredRequests'), value: exactCountText(totals.unmetered) }), _jsx(Metric, { label: t('failedRequests'), value: exactCountText(totals.failed) }), _jsx(Metric, { label: t('retryRequests'), value: exactCountText(totals.retried) })] }), _jsxs("div", { className: css.charts, children: [_jsxs("article", { className: css.chartCard, children: [_jsxs("div", { className: css.chartHeading, children: [_jsx("h3", { children: t('requestCurve') }), _jsx("span", { children: exactCountText(totals.requests) })] }), _jsxs("div", { className: css.curveChart, children: [_jsxs("svg", { viewBox: "0 0 100 40", preserveAspectRatio: "none", "aria-hidden": "true", children: [_jsx("path", { className: css.gridLine, d: "M 0 36 H 100" }), _jsx("path", { className: css.curve, d: curve }), buckets.map((bucket, index) => {
                                                        const max = Math.max(1, ...buckets.map(candidate => candidate.requests));
                                                        const x = buckets.length === 1 ? 50 : (index / (buckets.length - 1)) * 100;
                                                        const y = 36 - (bucket.requests / max) * 30;
                                                        return _jsx("circle", { className: css.curvePoint, cx: x, cy: y, r: "0.75" }, bucket.date);
                                                    })] }), _jsx("div", { className: css.hitTargets, style: { '--usage-buckets': buckets.length }, children: buckets.map((bucket, index) => {
                                                    const next = { kind: 'requests', index };
                                                    return (_jsx("button", { type: "button", "aria-describedby": target?.kind === 'requests' && target.index === index ? tooltipId : undefined, "aria-label": interpolate(t('requestsOn'), { date: dateText(bucket.date), requests: exactCountText(bucket.requests), failed: exactCountText(bucket.failed), retried: exactCountText(bucket.retried) }), onFocus: () => { showTarget(next); }, onPointerEnter: () => { showTarget(next); }, onPointerLeave: () => { setTarget(undefined); }, onClick: () => { toggleTarget(next); } }, bucket.date));
                                                }) })] })] }), _jsxs("article", { className: css.chartCard, children: [_jsxs("div", { className: css.chartHeading, children: [_jsx("h3", { children: t('tokenFlow') }), _jsx("span", { children: tokenText(totals.input + totals.output + totals.cached) })] }), _jsx("div", { className: css.barChart, children: buckets.map((bucket, index) => {
                                            const next = { kind: 'tokens', index };
                                            const barStyle = {
                                                '--input-height': `${(bucket.input / maxTokens) * 100}%`,
                                                '--output-height': `${(bucket.output / maxTokens) * 100}%`,
                                                '--cached-height': `${(bucket.cached / maxTokens) * 100}%`,
                                            };
                                            return (_jsxs("button", { type: "button", className: css.tokenBar, style: barStyle, "aria-describedby": target?.kind === 'tokens' && target.index === index ? tooltipId : undefined, "aria-label": interpolate(t('tokensOn'), {
                                                    date: dateText(bucket.date),
                                                    input: tokenText(bucket.input),
                                                    output: tokenText(bucket.output),
                                                    cached: tokenText(bucket.cached),
                                                }), onFocus: () => { showTarget(next); }, onPointerEnter: () => { showTarget(next); }, onPointerLeave: () => { setTarget(undefined); }, onClick: () => { toggleTarget(next); }, children: [_jsx("span", { className: css.inputBar }), _jsx("span", { className: css.outputBar }), _jsx("span", { className: css.cachedBar })] }, bucket.date));
                                        }) })] })] }), _jsx("div", { className: `${css.tooltip} ${activeBucket === undefined ? css.tooltipHidden : ''}`, id: tooltipId, role: "tooltip", "aria-hidden": activeBucket === undefined, children: activeBucket === undefined ? null : (_jsxs(_Fragment, { children: [_jsx("strong", { children: dateText(activeBucket.date) }), target?.kind === 'requests'
                                    ? _jsx("span", { children: interpolate(t('requestsOn'), { date: '', requests: exactCountText(activeBucket.requests), failed: exactCountText(activeBucket.failed), retried: exactCountText(activeBucket.retried) }).replace(/^：|^: /, '') })
                                    : _jsx("span", { children: interpolate(t('tokensOn'), { date: '', input: tokenText(activeBucket.input), output: tokenText(activeBucket.output), cached: tokenText(activeBucket.cached) }).replace(/^：|^: /, '') })] })) }), _jsxs("article", { className: css.tableCard, children: [_jsxs("div", { className: css.chartHeading, children: [_jsx("h3", { children: t('modelBreakdown') }), _jsx("span", { children: visibleModels.length })] }), _jsx("div", { className: css.tableScroll, children: _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: t('tableModel') }), _jsx("th", { children: t('tableInput') }), _jsx("th", { children: t('tableOutput') }), _jsx("th", { children: t('tableCacheHit') }), _jsx("th", { children: t('tableTotal') }), _jsx("th", { children: t('tableRequests') }), _jsx("th", { children: t('tableFailed') }), _jsx("th", { children: t('tableRetries') })] }) }), _jsx("tbody", { children: visibleModels.filter(row => model === 'all' || row.model === model).map(row => (_jsxs("tr", { children: [_jsx("th", { scope: "row", children: row.model }), _jsx("td", { children: compactNumberText(row.input) }), _jsx("td", { children: compactNumberText(row.output) }), _jsx("td", { children: compactNumberText(row.cacheHit) }), _jsx("td", { children: compactNumberText(totalOf(row)) }), _jsx("td", { children: compactNumberText(row.requests) }), _jsx("td", { children: compactNumberText(row.failed) }), _jsx("td", { children: compactNumberText(row.retried) })] }, row.model))) })] }) })] })] }))] }));
}
function Metric({ label, value, className }) {
    const metricClass = className === undefined ? css.metric : `${css.metric} ${className}`;
    return _jsxs("div", { className: metricClass, children: [_jsx("span", { children: label }), _jsx("strong", { children: value })] });
}
