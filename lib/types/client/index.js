import { TYPERT_REMOTE } from "./generated-typert-remote.js";
import { installUsageStyles, UsageDashboard } from "./UsageDashboard.js";
import { en, zh } from "./locales.js";
/** Dictionary namespace owned by this package. */
const NS = 'settings.usage';
/** Required Cordis services; the local Remote contribution is mounted during apply. */
export const inject = ['slots', 'locale', 'remote'];
/**
 * Decode the generated Remote result envelope while accepting a direct snapshot
 * during local host-package assembly.
 * @param response - Remote method result.
 * @returns the usage snapshot payload.
 */
function unpackSnapshot(response) {
    if (typeof response !== 'object' || response === null || !('ok' in response))
        return response;
    const result = response;
    if (result.ok)
        return result.value;
    throw new Error(`usageLedgerPlugin.snapshot failed: ${result.error.code}: ${result.error.message}`);
}
/** Register the localized Usage section once its settings slot is declared. */
export async function apply(ctx) {
    // Stock dsh builds that already mount this namespace are reused; older builds
    // receive the generated contribution from this package.
    const ownsRemote = ctx.remote.usageLedgerPlugin === undefined;
    const disposeRemote = ownsRemote ? await ctx.remote.$mount(TYPERT_REMOTE) : undefined;
    try {
        ctx.effect(() => installUsageStyles(), 'dsh-usage-ledger: stylesheet');
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-usage-ledger: dictionaries');
        const ledger = ctx.remote.usageLedgerPlugin;
        const injected = () => ({
            readSnapshot: async () => {
                const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                return unpackSnapshot(await ledger.snapshot({ days: 30, timeZone }));
            },
        });
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'usage',
            order: 20,
            label: () => t('nav'),
            locale: NS,
            inject: injected,
        }, UsageDashboard));
        return async () => {
            if (disposeRemote !== undefined)
                await disposeRemote();
        };
    }
    catch (error) {
        if (disposeRemote !== undefined)
            await disposeRemote();
        throw error;
    }
}
