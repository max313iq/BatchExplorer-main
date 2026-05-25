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

import { AzureRequestError, classifyHttpError } from "../types";

export interface ToAzureRequestErrorOptions {
  /**
   * Extract the inner `{ code, message, details }` envelope from the
   * parsed body. Default reads `body.error` (ARM / Graph / Partner
   * Center). Batch can override to also try `body["odata.error"]`.
   */
  extractInner?: (body: unknown) => {
    code?: string;
    message?: string;
    details?: Array<{ code?: string; message?: string }>;
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

function defaultExtractInner(body: unknown): {
  code?: string;
  message?: string;
  details?: Array<{ code?: string; message?: string }>;
} {
  if (typeof body !== "object" || body === null) return {};
  const b = body as Record<string, unknown>;
  // Try ARM/Graph shape first (`body.error`).
  const armErr = b.error as Record<string, unknown> | undefined;
  if (armErr && typeof armErr === "object") {
    return {
      code: armErr.code as string | undefined,
      message: armErr.message as string | undefined,
      details: armErr.details as
        | Array<{ code?: string; message?: string }>
        | undefined,
    };
  }
  // Fallback to legacy OData shape (`body["odata.error"]` — Batch).
  const odataErr = b["odata.error"] as Record<string, unknown> | undefined;
  if (odataErr && typeof odataErr === "object") {
    const msgWrap = odataErr.message;
    const msg =
      typeof msgWrap === "string"
        ? msgWrap
        : typeof msgWrap === "object" &&
            msgWrap !== null &&
            "value" in (msgWrap as Record<string, unknown>)
          ? String((msgWrap as { value?: unknown }).value ?? "")
          : "";
    return {
      code: odataErr.code as string | undefined,
      message: msg,
      details: undefined,
    };
  }
  // Top-level `code` / `description` (Partner Center fallback).
  return {
    code: b.code as string | undefined,
    message:
      (b.message as string | undefined) ??
      (b.description as string | undefined),
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
export async function toAzureRequestError(
  response: Response,
  opts: ToAzureRequestErrorOptions = {},
): Promise<AzureRequestError> {
  const extract = opts.extractInner ?? defaultExtractInner;
  const sanitize = opts.sanitize;
  const svcLabel = opts.svcLabel ?? "Azure";
  const displayMax = opts.displayMax ?? 1000;

  // Read body once as text so we can fall back to raw text for
  // non-JSON 4xx (text/html error pages, proxy errors with empty
  // bodies, etc.).
  let bodyText = "";
  let body: unknown = {};
  try {
    bodyText = await response.text();
    if (bodyText && bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = { raw: bodyText };
      }
    }
  } catch {
    /* network read failure; body stays empty */
  }

  const inner = extract(body);
  let message: string;
  if (inner.message && inner.message.trim()) {
    message = inner.message.trim();
  } else if (typeof body === "object" && Object.keys(body as object).length > 0) {
    message = JSON.stringify(body);
  } else if (bodyText && bodyText.trim()) {
    message = bodyText.trim().slice(0, 500);
  } else {
    message =
      `${svcLabel} request failed: ${response.status} ${response.statusText || ""}`.trim();
  }
  if (sanitize) message = sanitize(message);

  // Roll nested `details[]` into the display message so a single toast
  // shows the policy / quota / validation problem inline.
  if (Array.isArray(inner.details) && inner.details.length > 0) {
    const detailLines = inner.details
      .map((d) => {
        const c = d.code ?? "";
        const m = sanitize ? sanitize(d.message ?? "") : (d.message ?? "");
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
    } catch {
      return response.url || undefined;
    }
  })();
  if (urlPath) message = `${response.status} ${urlPath}: ${message}`;
  if (message.length > displayMax) {
    message = `${message.slice(0, displayMax)}…[truncated]`;
  }

  const retryAfter = response.headers.get("Retry-After");
  const err = classifyHttpError(
    message,
    response.status,
    inner.code ?? `${svcLabel}Error`,
    body,
    retryAfter,
  );
  if (urlPath) err.urlPath = urlPath;
  if (Array.isArray(inner.details) && inner.details.length > 0) {
    err.details = inner.details
      .map((d) => ({
        code: d.code,
        message: sanitize ? sanitize(d.message ?? "") : d.message,
      }))
      .filter((d) => d.code || d.message);
  }
  return err;
}
