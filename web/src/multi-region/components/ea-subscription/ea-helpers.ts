/**
 * Pure helpers extracted from ea-subscription-page.tsx so the main
 * component file is smaller, hot reloads faster, and unit tests (when
 * added) can target the helpers without mounting React.
 *
 * No JSX, no React imports. Importing from this file MUST stay free of
 * side-effects so the page-level bundle stays lean.
 */

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALIAS_REGEX = /^[a-z0-9-]{3,63}$/;

/**
 * Map common Azure failure messages from the Subscription Alias API
 * to one-line remediation tips. The raw Azure message is still shown
 * inline; the tip appears below it as muted help text.
 */
export function suggestRemediation(rawError: string): string | null {
  const msg = rawError.toLowerCase();
  if (
    msg.includes("not authorized to create subscriptions") ||
    msg.includes("billingpermissiondenied") ||
    msg.includes("does not have authorization to perform action") ||
    (msg.includes("enrollmentaccount") && msg.includes("authoriz"))
  ) {
    return (
      "If you DO have the EA Subscription Creator / Account Owner role: " +
      "the role was likely granted after your access token was minted. " +
      "Click the user menu -> Sign out, then sign back in (this forces a " +
      "fresh token); OR wait ~5 minutes and retry — Entra propagation can " +
      "lag. Verify the diagnostic below shows the expected upn/tid/oid. " +
      "If you DON'T have the role: ask an Enterprise Administrator to grant " +
      "you EA Subscription Creator on the enrollment account in EA Portal " +
      "(ea.azure.com -> Manage -> Account -> Add Owner)."
    );
  }
  // AADSTS70000 is a generic "couldn't validate user credentials" Entra
  // ID family — typically appears when the token's claim set is rejected
  // mid-flight (e.g. conditional-access policy fired, MFA stale, or the
  // tenant is in a 'block sign-ins' state). The fix is essentially
  // "re-acquire interactively" so MSAL can replay the MFA challenge.
  if (msg.includes("aadsts70000") || msg.includes("70000:")) {
    return (
      "Entra ID rejected your token (AADSTS70000) — usually a stale MFA " +
      "claim or a conditional-access policy that fired between sign-in " +
      "and this submit. Sign out (user menu) and sign back in to replay " +
      "MFA, then retry. If it keeps happening, ask your IT to verify " +
      "that EA-billing endpoints aren't blocked by CA policy."
    );
  }
  // "Commerce Account Is Null" / "BillingAccount is null" is the documented
  // Azure error when the principal somehow does NOT have a Commerce Account
  // attached at the enrollment scope. This is a known data-plane bug where
  // the EA principal exists in the role graph but the back-end Commerce
  // store hasn't propagated. There is no client-side fix — only a support
  // case will repair it.
  if (
    msg.includes("commerce account is null") ||
    msg.includes("commerceaccountisnull") ||
    msg.includes("billingaccount is null") ||
    msg.includes("billingaccountisnull")
  ) {
    return (
      "Azure Commerce returned 'Commerce Account Is Null' — a back-end " +
      "data issue where the EA principal exists in the role graph but " +
      "the Commerce store hasn't fully propagated. There is no client-" +
      "side fix. Open an Azure support case under 'Subscription " +
      "Management → Cannot create subscription' and reference the " +
      "enrollment account name. While waiting, try a different " +
      "enrollment account on the same EA."
    );
  }
  if (msg.includes("subscriptionownerid") && msg.includes("invalid")) {
    return (
      "The subscription owner object ID is not recognized in the " +
      "destination tenant. Make sure the user / SPN you picked exists " +
      "in that tenant - guests must accept their invitation first."
    );
  }
  if (
    msg.includes("subscriptiontenantid") &&
    (msg.includes("invalid") || msg.includes("not found"))
  ) {
    return (
      "The destination tenant ID was not found. Confirm the tenant GUID " +
      "and that the EA-billing principal is allowed to provision " +
      "subscriptions in that directory."
    );
  }
  if (msg.includes("aliasalreadyexists")) {
    return (
      "An alias with that name already exists. Names auto-generate with " +
      "a random suffix; just retry - the next attempt will pick a new " +
      "name."
    );
  }
  if (msg.includes("invalidbillingscope")) {
    return (
      "The billing scope was not accepted. Re-pick the enrollment / " +
      "invoice-section above to refresh the path."
    );
  }
  // Quota / spending limit on the EA — surfaces as 400 with a specific
  // message; ask the operator to check the spending limit in EA portal.
  if (
    msg.includes("spendinglimit") ||
    msg.includes("spending limit") ||
    msg.includes("quotaexceeded") ||
    msg.includes("quota exceeded")
  ) {
    return (
      "The enrollment account is at or near its spending limit / quota. " +
      "Open EA Portal (ea.azure.com) → Manage → Enrollment Account → " +
      "increase the spending limit or wait for the next billing cycle. " +
      "Subscriptions cannot be provisioned while the limit is reached."
    );
  }
  // 429 throttle from ARM — clear; retry after a short pause.
  if (msg.includes("toomanyrequests") || msg.includes("429")) {
    return (
      "ARM is throttling this caller (429). Wait 30-60 seconds and " +
      "retry just the failed recipients (use Retry failed). Reduce " +
      "batch size if this keeps happening."
    );
  }
  // 5xx — transient; just retry.
  if (
    /\b5\d\d\b/.test(rawError) ||
    msg.includes("internalservererror") ||
    msg.includes("badgateway") ||
    msg.includes("service unavailable")
  ) {
    return (
      "Azure returned a server-side error (5xx). This is usually " +
      "transient. Use Retry failed to re-run just the failures after a " +
      "10-30s pause."
    );
  }
  return null;
}

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

export function truncateMiddle(value: string, head = 8, tail = 4): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function randomSuffix(n: number): string {
  try {
    const cryptoApi: Crypto | undefined =
      typeof globalThis !== "undefined"
        ? (globalThis as { crypto?: Crypto }).crypto
        : undefined;
    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
      const bytes = new Uint8Array(n);
      cryptoApi.getRandomValues(bytes);
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
      let out = "";
      for (let i = 0; i < n; i += 1) {
        out += alphabet[bytes[i]! % alphabet.length];
      }
      return out;
    }
  } catch {
    /* fall through to Math.random fallback */
  }
  return Math.random()
    .toString(36)
    .slice(2, 2 + n)
    .padEnd(n, "0");
}

/**
 * Parse a freeform paste into one or more `(tenantId, ownerObjectId)`
 * pairs. Tolerates:
 *   - tab / comma / whitespace separators between the two GUIDs
 *   - one row per line OR a single comma-stream
 *   - extra whitespace, surrounding quotes, BOM
 *   - blank lines and `#` / `//` comment lines
 *   - reversed order is NOT auto-corrected — the contract is
 *     `tenant, owner` and reversing would silently provision in the
 *     wrong directory
 *
 * Returns up to `cap` valid pairs. Invalid lines are returned as
 * `errors` with the original line text for the operator to fix.
 */
export function parseBulkRecipients(
  raw: string,
  cap = 500,
): {
  pairs: Array<{ tenantId: string; ownerObjectId: string; line: number }>;
  errors: Array<{ line: number; text: string; reason: string }>;
  truncated: boolean;
} {
  const pairs: Array<{
    tenantId: string;
    ownerObjectId: string;
    line: number;
  }> = [];
  const errors: Array<{ line: number; text: string; reason: string }> = [];
  if (!raw) return { pairs, errors, truncated: false };
  const lines = raw.replace(/\r/g, "").split("\n");
  let truncated = false;
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const cleaned = trimmed.replace(/^["']|["']$/g, "");
    const parts = cleaned
      .split(/[,\t\s;]+/)
      .map((p) => p.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    if (parts.length < 2) {
      errors.push({
        line: i + 1,
        text: trimmed,
        reason: "Expected at least two GUIDs (tenantId then ownerObjectId).",
      });
      continue;
    }
    const [tenantPart, ownerPart] = parts;
    if (!tenantPart || !ownerPart) {
      errors.push({
        line: i + 1,
        text: trimmed,
        reason: "Empty tenantId or ownerObjectId.",
      });
      continue;
    }
    if (!UUID_REGEX.test(tenantPart)) {
      errors.push({
        line: i + 1,
        text: trimmed,
        reason: `Not a GUID: '${tenantPart}' (column 1 = tenantId).`,
      });
      continue;
    }
    if (!UUID_REGEX.test(ownerPart)) {
      errors.push({
        line: i + 1,
        text: trimmed,
        reason: `Not a GUID: '${ownerPart}' (column 2 = ownerObjectId).`,
      });
      continue;
    }
    if (pairs.length >= cap) {
      truncated = true;
      break;
    }
    pairs.push({
      tenantId: tenantPart,
      ownerObjectId: ownerPart,
      line: i + 1,
    });
  }
  return { pairs, errors, truncated };
}

export function isValidAlias(alias: string): boolean {
  return ALIAS_REGEX.test(alias);
}

/**
 * Stable per-recipient idempotency key for a batch submit. The Subscription
 * Alias API treats the alias name itself as the idempotency key (a second
 * PUT with the same alias is a no-op when the first succeeded). We
 * additionally bake a batch-level uuid into the alias suffix so two
 * concurrent batches against the same recipient list never collide. The
 * key is also surfaced as a tag on the new subscription so it shows up in
 * audit logs and Azure Activity Log.
 */
export function generateBatchId(): string {
  // Mirrors randomSuffix() but produces a 12-char base36-ish token; opaque.
  return `${Date.now().toString(36)}-${randomSuffix(8)}`;
}

/**
 * Format a number of seconds as `mm:ss` (or `Xs` for under a minute).
 * Used in the per-recipient progress strip and the batch summary so
 * elapsed times are scannable without the operator counting digits.
 */
export function formatElapsedSec(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0s";
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs - m * 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/**
 * Coarse classification of an Azure error message into a category. Used by
 * the failure panel to badge errors so the operator can scan a long batch
 * and spot which failures are e.g. all the same auth issue vs. random
 * mixed problems. Returned label is short enough for an inline pill.
 */
export function categorizeError(error: string): {
  label: string;
  tone: "auth" | "data" | "quota" | "transient" | "input" | "unknown";
} {
  const msg = error.toLowerCase();
  if (
    msg.includes("aadsts") ||
    msg.includes("401") ||
    msg.includes("not authorized") ||
    msg.includes("authoriz") ||
    msg.includes("billingpermission")
  ) {
    return { label: "auth", tone: "auth" };
  }
  if (
    msg.includes("commerce account is null") ||
    msg.includes("billingaccount is null") ||
    msg.includes("commerceaccountisnull")
  ) {
    return { label: "commerce", tone: "data" };
  }
  if (
    msg.includes("spendinglimit") ||
    msg.includes("quota") ||
    msg.includes("limit")
  ) {
    return { label: "quota", tone: "quota" };
  }
  if (msg.includes("toomanyrequests") || msg.includes("429")) {
    return { label: "throttle", tone: "transient" };
  }
  if (
    /\b5\d\d\b/.test(error) ||
    msg.includes("internalservererror") ||
    msg.includes("badgateway") ||
    msg.includes("service unavailable") ||
    msg.includes("timeout")
  ) {
    return { label: "transient", tone: "transient" };
  }
  if (
    msg.includes("invalid") ||
    msg.includes("alias") ||
    msg.includes("subscriptionownerid") ||
    msg.includes("subscriptiontenantid")
  ) {
    return { label: "input", tone: "input" };
  }
  return { label: "unknown", tone: "unknown" };
}

/**
 * Build the Azure Portal deep-link for a freshly-provisioned subscription.
 * The Subscription Alias API returns an ARM resource id like
 * `/subscriptions/{guid}` once the alias finishes async polling. The portal
 * accepts the bare GUID as a query parameter on the Subscriptions blade.
 */
export function azurePortalLinkForSubscription(subscriptionId: string): string {
  const trimmed = subscriptionId.trim();
  // Some callers may give us a full resource path; pull just the GUID.
  const match = trimmed.match(/([0-9a-f-]{36})/i);
  const id = match ? match[1] : trimmed;
  return `https://portal.azure.com/#@/resource/subscriptions/${id}/overview`;
}
