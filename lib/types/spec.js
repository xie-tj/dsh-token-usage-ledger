/** Persistent `usage_ledger` domain declaration and stored-record schemas. */
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
const nonNegativeInteger = z.number().int().nonnegative();
const tokenUsageSchema = z.object({
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    cacheReadTokens: nonNegativeInteger,
    cacheWriteTokens: nonNegativeInteger,
});
/** Zod schema for the lifecycle cursor and attempt lookup tables. */
export const usageLedgerSessionRowSchema = z.object({
    createdAt: nonNegativeInteger,
    workspace: z.string().optional(),
    observedSeq: z.number().int().min(-1),
    activeAttempts: z.record(z.string(), z.string()),
    successfulAttempts: z.record(z.string(), z.string()),
});
/** Zod schema for one persisted provider attempt. */
export const usageLedgerCallRowSchema = z.object({
    sessionId: z.string(),
    createdAt: nonNegativeInteger,
    workspace: z.string().optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    attemptId: z.string(),
    startedAt: nonNegativeInteger,
    turn: nonNegativeInteger,
    step: nonNegativeInteger,
    provider: z.string(),
    model: z.string(),
    outcome: z.enum(['success', 'failure', 'aborted']).optional(),
    retryScheduled: z.boolean().optional(),
    provisionalUsage: tokenUsageSchema.optional(),
    finalUsage: tokenUsageSchema.optional(),
});
/** Versioned persistent storage layout for the usage-ledger service. */
export const usageLedgerDomainSpec = defineDomain({
    name: 'usage_ledger',
    version: 2,
    tables: {
        sessions: domainTable(usageLedgerSessionRowSchema),
        calls: domainTable(usageLedgerCallRowSchema),
    },
});
//# sourceMappingURL=spec.js.map