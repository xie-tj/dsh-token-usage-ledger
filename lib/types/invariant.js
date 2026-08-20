/** Package-owned provider-attempt stream invariant. @module dsh-plugin-usage-ledger/invariant */
const PACKAGE_NAME = 'dsh-plugin-usage-ledger';
/** Cordis companion plugin name. */
export const name = 'usage-ledger-invariant';
/** Services required to inspect complete session streams. */
export const inject = ['invariants'];
/** Validate identity and route fields for one durable request-attempt pair. */
function applyAttempt(open, event, fail) {
    if (event.type !== 'llm/request-attempt')
        return;
    const id = event.data.attemptId;
    if (event.data.phase === 'start') {
        if (open.has(id))
            fail(`request attempt '${id}' starts twice`);
        open.set(id, {
            turn: event.data.turn,
            step: event.data.step,
            provider: event.data.provider,
            model: event.data.model,
        });
        return;
    }
    const start = open.get(id);
    if (start === undefined) {
        fail(`request attempt '${id}' ends without a matching start`);
        return;
    }
    if (start.turn !== event.data.turn || start.step !== event.data.step
        || start.provider !== event.data.provider || start.model !== event.data.model) {
        fail(`request attempt '${id}' ends with fields different from its start`);
    }
    open.delete(id);
}
/** Install independent per-session attempt identity checks. Open attempts remain valid crash evidence. */
const install = Object.assign((ctx, fail) => {
    const states = new WeakMap();
    const seed = (session) => {
        const open = new Map();
        for (const event of session.events)
            applyAttempt(open, event, fail);
        states.set(session, open);
        return open;
    };
    const stateFor = (session) => states.get(session) ?? seed(session);
    for (const session of ctx.sessions.list())
        seed(session);
    ctx.on('session/created', (session) => { seed(session); }, { global: true });
    ctx.on('session/event', (session, event) => { applyAttempt(stateFor(session), event, fail); }, { global: true });
}, { inject: ['sessions'] });
/** Register the request-attempt invariant companion. */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map