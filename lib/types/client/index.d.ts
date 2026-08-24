/** Browser-side Usage Settings page and Plugins configuration card. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type UsageLocaleKey } from './locales.js';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Usage dashboard copy. */
        'settings.usage': UsageLocaleKey;
    }
}
/** Required Cordis services; the local Remote contribution is mounted during apply. */
export declare const inject: string[];
/** Register the localized Usage displays while their Host namespace is available. */
export declare function apply(ctx: ClientContext): Promise<() => Promise<void>>;
