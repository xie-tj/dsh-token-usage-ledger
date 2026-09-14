/** Durable record types and validation schemas for the private SQLite ledger. */
import { z } from 'zod';
import { createUsageAttemptId } from "./event-types.js";
const nonNegativeInteger = z.number().int().nonnegative();
const tokenUsageSchema = z.object({
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    cacheReadTokens: nonNegativeInteger,
    cacheWriteTokens: nonNegativeInteger,
});
const attemptIdSchema = z.string().transform(createUsageAttemptId);
/** Zod schema for the lifecycle cursor and active-attempt lookup table. */
export const usageLedgerSessionRowSchema = z.object({
    createdAt: nonNegativeInteger,
    workspace: z.string().optional(),
    observedSeq: z.number().int().min(-1),
    activeAttempts: z.record(z.string(), attemptIdSchema),
    route: z.object({ provider: z.string(), model: z.string() }).optional(),
});
/** Zod schema for one persisted provider attempt. */
export const usageLedgerCallRowSchema = z.object({
    sessionId: z.string(),
    createdAt: nonNegativeInteger,
    workspace: z.string().optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    attemptId: attemptIdSchema,
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
