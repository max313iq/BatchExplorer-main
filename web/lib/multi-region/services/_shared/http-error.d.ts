/**
 * Shared response → AzureRequestError mapper.
 *
 * Five services (arm-service, graph-service, batch-service,
 * partner-center-service, arg-service) carry near-identical
 * `toXxxError(response)` helpers. Each:
 *
 *   1. Reads the body as text + JSON (handling parse failures).
 *   2. Pulls `error.code` / `error.message` from the Azure envelope.
 *   3. Composes a `${status} ${urlPath}: ${msg}` display string.
 *   4. Truncates at ~1000 chars.
 *   5. Calls `classifyHttpError` to route into typed subclasses.
 *
 * The differences are tiny — Batch nests under `odata.error`, Graph
 * sanitizes password fragments, Partner Center has its own
 * "description" key. We capture the shape variants via an
 * `extractFn` hook so callers configure exactly what's special about
 * their wire format, and everything else is shared.
 *
 * The audit found ~600 lines of near-duplicate parsing across the
 * five services. Migrating to this helper drops that footprint and
 * fixes any drift (some services strip passwords, others don't; some
 * cap at 500 chars, others at 1000) in one place.
 */
import { AzureRequestError } from "../types";
export interface ToAzureRequestErrorOptions {
    /**
     * Extract the inner `{ code, message, details }` envelope from the
     * parsed body. Default reads `body.error` (ARM / Graph / Partner
     * Center). Batch can override to also try `body["odata.error"]`.
     */
    extractInner?: (body: unknown) => {
        code?: string;
        message?: string;
        details?: Array<{
            code?: string;
            message?: string;
        }>;
    };
    /**
     * Optional transform applied to the raw message just before
     * formatting. Used by Graph to redact `"password": "..."` payloads
     * before they reach the toast / audit log.
     */
    sanitize?: (msg: string) => string;
    /**
     * Suffix appended to the default fallback message
     * (`"<svcLabel> request failed: <status>"`). Helps the operator tell
     * an ARM 500 apart from a Graph 500 when both bubble up.
     */
    svcLabel?: string;
    /**
     * Cap on the display message. Defaults to 1000 chars; raw body is
     * still attached on `.body` for callers that want everything.
     */
    displayMax?: number;
}
/**
 * Convert any non-2xx `Response` into an `AzureRequestError`-subclass
 * appropriate for the status code (`AuthError`, `RateLimitError`,
 * `NotFoundError`, `PermissionError`, `ValidationError`, `TransientError`,
 * or `AzureRequestError` as the fallback).
 *
 * Always reads the body once — the consumer's `.body` field on the
 * error carries the parsed payload, and `.details` / `.urlPath` are
 * attached for audit-log consumers that want structured fields.
 */
export declare function toAzureRequestError(response: Response, opts?: ToAzureRequestErrorOptions): Promise<AzureRequestError>;
//# sourceMappingURL=http-error.d.ts.map