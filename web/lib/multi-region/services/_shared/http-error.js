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
import { __awaiter } from "tslib";
import { classifyHttpError } from "../types";
function defaultExtractInner(body) {
    var _a, _b;
    if (typeof body !== "object" || body === null)
        return {};
    const b = body;
    // Try ARM/Graph shape first (`body.error`).
    const armErr = b.error;
    if (armErr && typeof armErr === "object") {
        return {
            code: armErr.code,
            message: armErr.message,
            details: armErr.details,
        };
    }
    // Fallback to legacy OData shape (`body["odata.error"]` — Batch).
    const odataErr = b["odata.error"];
    if (odataErr && typeof odataErr === "object") {
        const msgWrap = odataErr.message;
        const msg = typeof msgWrap === "string"
            ? msgWrap
            : typeof msgWrap === "object" &&
                msgWrap !== null &&
                "value" in msgWrap
                ? String((_a = msgWrap.value) !== null && _a !== void 0 ? _a : "")
                : "";
        return {
            code: odataErr.code,
            message: msg,
            details: undefined,
        };
    }
    // Top-level `code` / `description` (Partner Center fallback).
    return {
        code: b.code,
        message: (_b = b.message) !== null && _b !== void 0 ? _b : b.description,
    };
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
export function toAzureRequestError(response, opts = {}) {
    var _a, _b, _c, _d;
    return __awaiter(this, void 0, void 0, function* () {
        const extract = (_a = opts.extractInner) !== null && _a !== void 0 ? _a : defaultExtractInner;
        const sanitize = opts.sanitize;
        const svcLabel = (_b = opts.svcLabel) !== null && _b !== void 0 ? _b : "Azure";
        const displayMax = (_c = opts.displayMax) !== null && _c !== void 0 ? _c : 1000;
        // Read body once as text so we can fall back to raw text for
        // non-JSON 4xx (text/html error pages, proxy errors with empty
        // bodies, etc.).
        let bodyText = "";
        let body = {};
        try {
            bodyText = yield response.text();
            if (bodyText && bodyText.trim()) {
                try {
                    body = JSON.parse(bodyText);
                }
                catch (_e) {
                    body = { raw: bodyText };
                }
            }
        }
        catch (_f) {
            /* network read failure; body stays empty */
        }
        const inner = extract(body);
        let message;
        if (inner.message && inner.message.trim()) {
            message = inner.message.trim();
        }
        else if (typeof body === "object" && Object.keys(body).length > 0) {
            message = JSON.stringify(body);
        }
        else if (bodyText && bodyText.trim()) {
            message = bodyText.trim().slice(0, 500);
        }
        else {
            message =
                `${svcLabel} request failed: ${response.status} ${response.statusText || ""}`.trim();
        }
        if (sanitize)
            message = sanitize(message);
        // Roll nested `details[]` into the display message so a single toast
        // shows the policy / quota / validation problem inline.
        if (Array.isArray(inner.details) && inner.details.length > 0) {
            const detailLines = inner.details
                .map((d) => {
                var _a, _b, _c;
                const c = (_a = d.code) !== null && _a !== void 0 ? _a : "";
                const m = sanitize ? sanitize((_b = d.message) !== null && _b !== void 0 ? _b : "") : ((_c = d.message) !== null && _c !== void 0 ? _c : "");
                return c && m ? `  • [${c}] ${m}` : c || m;
            })
                .filter(Boolean)
                .slice(0, 5);
            if (detailLines.length > 0) {
                message = `${message}\n${detailLines.join("\n")}`;
            }
        }
        const urlPath = (() => {
            try {
                return new URL(response.url).pathname;
            }
            catch (_a) {
                return response.url || undefined;
            }
        })();
        if (urlPath)
            message = `${response.status} ${urlPath}: ${message}`;
        if (message.length > displayMax) {
            message = `${message.slice(0, displayMax)}…[truncated]`;
        }
        const retryAfter = response.headers.get("Retry-After");
        const err = classifyHttpError(message, response.status, (_d = inner.code) !== null && _d !== void 0 ? _d : `${svcLabel}Error`, body, retryAfter);
        if (urlPath)
            err.urlPath = urlPath;
        if (Array.isArray(inner.details) && inner.details.length > 0) {
            err.details = inner.details
                .map((d) => {
                var _a;
                return ({
                    code: d.code,
                    message: sanitize ? sanitize((_a = d.message) !== null && _a !== void 0 ? _a : "") : d.message,
                });
            })
                .filter((d) => d.code || d.message);
        }
        return err;
    });
}
//# sourceMappingURL=http-error.js.map