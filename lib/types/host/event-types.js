/**
 * Provider-attempt event types consumed by the usage ledger.
 *
 * The ledger reads only the durable fields it stores and does not augment
 * `SessionEventMap`, so it accepts the core record when that record is present.
 * @module dsh-plugin-usage-ledger/event-types
 */
/**
 * Brand a legacy synthetic attempt id used when a historical log lacks attempt records.
 * @param value - Stable synthetic request-attempt identifier.
 * @returns The same identifier with its attempt-id brand.
 */
export function createUsageAttemptId(value) {
    return value;
}
