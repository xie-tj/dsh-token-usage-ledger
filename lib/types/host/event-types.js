/** Compatibility event vocabulary for session versions with provider-attempt records. */
/**
 * Attach the provider-attempt brand to an identifier derived by this plugin.
 * @param value - Stable identifier from an official session event.
 * @returns The same identifier with its compile-time domain brand.
 */
export function createUsageAttemptId(value) {
    return value;
}
