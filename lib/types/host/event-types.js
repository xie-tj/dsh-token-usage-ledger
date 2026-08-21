/** Compatibility event vocabulary for session versions with provider-attempt records. */
/**
 * Attach the provider-attempt brand to an id produced by a session-compatible source.
 * @param value - Runtime request-attempt identifier.
 * @returns The same identifier with its compile-time domain brand.
 */
export function createUsageAttemptId(value) {
    return value;
}
