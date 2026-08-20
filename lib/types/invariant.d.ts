/** Package-owned provider-attempt stream invariant. @module dsh-plugin-usage-ledger/invariant */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "usage-ledger-invariant";
/** Services required to inspect complete session streams. */
export declare const inject: string[];
/** Register the request-attempt invariant companion. */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map