/** Browser-side Usage Settings page. */
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
/** Register the localized Usage section once its settings slot is declared. */
export declare function apply(ctx: ClientContext): Promise<() => Promise<void>>;
