/**
 * Common types used by the multi-region SDK service layer.
 *
 * These types represent the shapes returned by the ARM management plane
 * and the Batch data plane REST APIs. They are intentionally kept lean —
 * only the fields the multi-region feature actually consumes are included.
 */
/** Thrown when an Azure REST call returns a non-2xx status. */
export class AzureRequestError extends Error {
    constructor(message, status, code, body, isRetryable = false, isAsync = false, locationHeader) {
        super(message);
        Object.defineProperty(this, "status", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: status
        });
        Object.defineProperty(this, "code", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: code
        });
        Object.defineProperty(this, "body", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: body
        });
        Object.defineProperty(this, "locationHeader", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: locationHeader
        });
        Object.defineProperty(this, "isRetryable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "isAsync", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /**
         * Optional URL pathname (no host, no query) of the failing request.
         * Set by service-layer error mappers so audit-log callers can include
         * the failing endpoint without re-parsing the message string. Not part
         * of the constructor signature — callers attach it post-construction.
         */
        Object.defineProperty(this, "urlPath", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /**
         * Optional list of nested `error.details[]` entries from the Azure
         * error envelope, preserved separately from the human-readable message
         * so audit logs can capture the full detail set even when the toast
         * truncates the display message.
         */
        Object.defineProperty(this, "details", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.name = "AzureRequestError";
        // Auto-detect retryable if not explicitly set
        this.isRetryable = isRetryable || isRetryableStatus(status);
        // Auto-detect async if not explicitly set
        this.isAsync = isAsync || isAsyncAccepted(status);
    }
}
/* eslint-disable max-classes-per-file */
/**
 * Typed error taxonomy per Design Contract §1.6. Every typed error extends
 * `AzureRequestError` so existing handlers that branch on `instanceof
 * AzureRequestError` keep working; new code can branch on the specific
 * subclass for finer-grained handling.
 */
/** 401 / 403 from auth providers — token rejected. */
export class AuthError extends AzureRequestError {
    constructor(message, status, code, body) {
        super(message, status, code, body);
        this.name = "AuthError";
    }
}
/** 429 — rate limited. Includes the Retry-After hint when present. */
export class RateLimitError extends AzureRequestError {
    constructor(message, code, body, retryAfterSeconds) {
        super(message, 429, code, body, /* isRetryable */ true);
        Object.defineProperty(this, "retryAfterSeconds", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: retryAfterSeconds
        });
        this.name = "RateLimitError";
    }
}
/** 404 — resource not found. */
export class NotFoundError extends AzureRequestError {
    constructor(message, code, body) {
        super(message, 404, code, body);
        this.name = "NotFoundError";
    }
}
/** 5xx and intermittent network errors. Retryable. */
export class TransientError extends AzureRequestError {
    constructor(message, status, code, body) {
        super(message, status, code, body, /* isRetryable */ true);
        this.name = "TransientError";
    }
}
/** 403 with explicit authorization-failed code (vs token-rejected). */
export class PermissionError extends AzureRequestError {
    constructor(message, code, body) {
        super(message, 403, code, body);
        this.name = "PermissionError";
    }
}
/** 400 with client-supplied invalid input. */
export class ValidationError extends AzureRequestError {
    constructor(message, code, body, fieldErrors) {
        super(message, 400, code, body);
        Object.defineProperty(this, "fieldErrors", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: fieldErrors
        });
        this.name = "ValidationError";
    }
}
/* eslint-enable max-classes-per-file */
/**
 * Map an HTTP status + Azure error envelope to the most specific
 * AzureRequestError subclass. Returns the base `AzureRequestError` when no
 * narrower match applies.
 */
export function classifyHttpError(message, status, code, body, retryAfter) {
    if (status === 401)
        return new AuthError(message, status, code, body);
    if (status === 429) {
        const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? parseInt(retryAfter, 10) : undefined;
        return new RateLimitError(message, code, body, retryAfterSeconds);
    }
    if (status === 404)
        return new NotFoundError(message, code, body);
    if (status === 403) {
        // Token-rejected vs not-authorized: AAD returns 401 for token issues, but
        // some upstreams normalize to 403. Treat 403 with auth-related code as
        // AuthError, otherwise PermissionError.
        if (/(invalid_token|unauthorized|InvalidAuthentication)/i.test(code)) {
            return new AuthError(message, status, code, body);
        }
        return new PermissionError(message, code, body);
    }
    if (status === 400)
        return new ValidationError(message, code, body);
    if (status >= 500 && status < 600) {
        return new TransientError(message, status, code, body);
    }
    // Default: keep the generic shape so existing handlers still match.
    return new AzureRequestError(message, status, code, body);
}
/**
 * Wrap an unknown thrown value into an AzureRequestError so consumers can
 * always work in a single error type. Pass-through for AzureRequestError.
 */
export function wrapUnknown(e) {
    if (e instanceof AzureRequestError)
        return e;
    if (e instanceof Error) {
        return new AzureRequestError(e.message, 0, "client_error", { stack: e.stack });
    }
    return new AzureRequestError(String(e), 0, "unknown_error", undefined);
}
/** Check if an HTTP status indicates an async accepted operation */
export function isAsyncAccepted(status) {
    return status === 202;
}
/** Check if an HTTP status is retryable (transient failure) */
export function isRetryableStatus(status) {
    return (status === 408 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503);
}
/** Check if a provisioningState indicates completion */
export function isTerminalProvisioningState(state) {
    const lower = state.toLowerCase();
    return (lower === "succeeded" ||
        lower === "failed" ||
        lower === "canceled" ||
        lower === "cancelled" ||
        lower === "deleted");
}
/** Check if a provisioningState indicates success */
export function isSuccessProvisioningState(state) {
    return state.toLowerCase() === "succeeded";
}
//# sourceMappingURL=types.js.map