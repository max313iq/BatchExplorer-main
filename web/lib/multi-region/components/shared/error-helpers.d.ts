export interface ActionableError {
    message: string;
    suggestion: string;
}
export interface BatchApiError {
    code: string;
    message: string;
    statusCode?: number;
    retryable: boolean;
}
export type ErrorClassification = "AuthenticationFailed" | "AuthorizationFailed" | "RateLimited" | "QuotaExceeded" | "InsufficientCapacity" | "PoolExists" | "Retryable" | "Unknown";
export declare function classifyError(error: string, statusCode?: number): ErrorClassification;
export declare function getActionableErrorMessage(error: string, statusCode?: number): ActionableError;
/**
 * Strip sensitive information from an error before displaying it in the UI.
 *
 * Removes Bearer tokens, SAS tokens, shared keys, connection strings,
 * stack traces, and internal ARM resource paths. The result is safe to
 * show to end-users without leaking credentials or internal URLs.
 *
 * @param error - Any thrown value (Error, string, or unknown).
 * @returns A sanitized, user-safe error string (max 200 chars).
 */
export declare function sanitizeErrorMessage(error: unknown): string;
//# sourceMappingURL=error-helpers.d.ts.map