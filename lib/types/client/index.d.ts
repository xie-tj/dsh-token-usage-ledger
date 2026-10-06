/** Browser-side Usage Settings page and this bundle's Plugins page row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type UsageLocaleKey } from './locales.js';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Usage dashboard copy. */
        'settings.usage': UsageLocaleKey;
    }
}
/** Required Cordis services; the local Remote contribution is mounted during apply. */
export declare const inject: string[];
/** Register the localized Usage displays: the Settings section and the Plugins page. */
export declare function apply(ctx: ClientContext): Promise<() => Promise<void>>;
