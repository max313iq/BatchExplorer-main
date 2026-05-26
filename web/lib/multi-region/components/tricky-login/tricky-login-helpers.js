/**
 * Detect which mint methods are likely to succeed for a given source
 * account + target tenant pair WITHOUT making any network calls.
 *
 * - MSAL silent: needs the target tenant to appear in `account.tenants`
 *   (either pre-loaded via Azure Accounts or fetched lazily by the page).
 *   The presence of the tenant in that list means ARM accepted a /tenants
 *   call from this account, which is a very strong signal that
 *   acquireTokenSilent against the target tenant authority will work.
 *
 * - FOCI exchange: needs ANY imported refresh token for this account.
 *   The page also checks `detectFociEligibility` on the imported RT's
 *   originating client id, but the pre-flight here is the cheaper
 *   "do we even have an RT?" check.
 *
 * - Direct tenant RT: deliberately marked unavailable — a true
 *   "refresh-token issued by tenant Y directly" mint requires either a
 *   PRT (device-certificate-backed, OS-level only) or a stolen RT
 *   already minted against tenant Y. Both are out of scope for an
 *   admin defensive tool.
 */
export function detectMethodAvailability(args) {
    const { accountTenants, activeTenantId, targetTenantId, hasImportedRefreshToken, importedRefreshTokenClientLabel, } = args;
    // MSAL silent — discoverable means the target tenant has surfaced in
    // ARM's /tenants list for this account. If we don't have a tenant list
    // at all we surface a softer "unknown" hint instead of a hard ✗.
    const hasTenantList = Array.isArray(accountTenants) && accountTenants.length > 0;
    const tenantInList = hasTenantList
        ? accountTenants.some((t) => { var _a; return ((_a = t.tenantId) !== null && _a !== void 0 ? _a : "").toLowerCase() === targetTenantId.toLowerCase(); })
        : false;
    const sameAsActive = !!activeTenantId &&
        activeTenantId.toLowerCase() === targetTenantId.toLowerCase();
    const msalSilent = sameAsActive
        ? {
            available: false,
            reason: "✗ MSAL silent: target tenant is already the account's active tenant (no-op).",
        }
        : tenantInList
            ? {
                available: true,
                reason: "✓ MSAL silent: account has discovered access to this tenant via /tenants.",
            }
            : hasTenantList
                ? {
                    available: false,
                    reason: "✗ MSAL silent: tenant not in the account's /tenants list — ARM will likely return interaction_required.",
                }
                : {
                    // No tenant list yet — let the page nudge the operator to load it.
                    available: true,
                    reason: "? MSAL silent: tenant list not loaded — open Azure Accounts → Tenants for this account to discover.",
                };
    const fociExchange = hasImportedRefreshToken
        ? {
            available: true,
            reason: `✓ FOCI exchange: refresh token available${importedRefreshTokenClientLabel
                ? ` for ${importedRefreshTokenClientLabel}`
                : ""}.`,
        }
        : {
            available: false,
            reason: "✗ FOCI exchange: no imported refresh token for this account (paste one on the Import Token page).",
        };
    const directTenantRt = {
        available: false,
        reason: "✗ Direct refresh token for target tenant: would need a PRT / device cert (out of scope for an in-browser admin tool).",
    };
    return { msalSilent, fociExchange, directTenantRt };
}
export const AUDIENCE_CHOICES = Object.freeze([
    {
        id: "arm",
        label: "ARM",
        scope: "https://management.azure.com/.default",
        description: "Azure Resource Manager — subscriptions, resource groups, deployments, RBAC.",
        msalSilentSupported: true,
    },
    {
        id: "graph",
        label: "Microsoft Graph",
        scope: "https://graph.microsoft.com/.default",
        description: "Microsoft Graph — directory users, groups, roles, sign-in events.",
        msalSilentSupported: true,
    },
    {
        id: "batch",
        label: "Azure Batch",
        scope: "https://batch.core.windows.net/.default",
        description: "Azure Batch data plane — pools, jobs, tasks inside a Batch account.",
        msalSilentSupported: true,
    },
    {
        id: "vault",
        label: "Azure Vault",
        scope: "https://vault.azure.net/.default",
        description: "Azure Key Vault data plane (HSM/secret get/set) — different host from the resource-id `keyvault` audience.",
        msalSilentSupported: false,
    },
    {
        id: "storage",
        label: "Azure Storage",
        scope: "https://storage.azure.com/.default",
        description: "Azure Storage data plane — blob/file/queue/table operations with AAD bearer.",
        msalSilentSupported: false,
    },
    {
        id: "keyvault",
        label: "Key Vault",
        scope: "https://vault.azure.net/.default",
        description: "Key Vault data plane — same audience as Vault, exposed separately for operator clarity.",
        msalSilentSupported: false,
    },
    {
        id: "intune",
        label: "Intune",
        scope: "https://manage.microsoft.com/.default",
        description: "Microsoft Endpoint Manager (Intune) — device + policy management.",
        msalSilentSupported: false,
    },
    {
        id: "substrate",
        label: "Substrate",
        scope: "https://substrate.office.com/.default",
        description: "Office 365 Substrate — internal M365 service mesh for mail/files/people.",
        msalSilentSupported: false,
    },
    {
        id: "monitor",
        label: "Azure Monitor",
        scope: "https://monitor.azure.com/.default",
        description: "Azure Monitor data plane — metrics, logs, alerts (data-plane reads).",
        msalSilentSupported: false,
    },
    {
        id: "powerbi",
        label: "Power BI",
        scope: "https://analysis.windows.net/powerbi/api/.default",
        description: "Power BI REST API — workspaces, datasets, reports, capacities.",
        msalSilentSupported: false,
    },
    {
        id: "yammer",
        label: "Yammer",
        scope: "https://api.yammer.com/.default",
        description: "Yammer (Viva Engage) REST API.",
        msalSilentSupported: false,
    },
    {
        id: "devops",
        label: "Azure DevOps",
        scope: "499b84ac-1321-427f-aa17-267ca6975798/.default",
        description: "Azure DevOps — resource id 499b84ac (well-known SPN). Issues PAT-equivalent bearer tokens for REST API + Git over HTTPS.",
        msalSilentSupported: false,
    },
    {
        id: "custom",
        label: "Custom scope",
        scope: "https://management.azure.com/.default",
        description: "Type any v2 resource scope (must end in /.default for app permissions).",
        msalSilentSupported: false,
    },
]);
/**
 * Subset of audience ids that the "Batch mint all" button iterates. Excludes
 * `custom` (no fixed scope) and dedupes `vault`/`keyvault` order so the
 * 12-row batch panel matches the spec's "Batch mint 12 audiences" label.
 */
export const BATCH_MINT_AUDIENCES = Object.freeze([
    "arm",
    "graph",
    "batch",
    "vault",
    "storage",
    "keyvault",
    "intune",
    "substrate",
    "monitor",
    "powerbi",
    "yammer",
    "devops",
]);
/** Look up an audience choice by id. */
export function getAudienceChoice(id) {
    var _a;
    return (_a = AUDIENCE_CHOICES.find((c) => c.id === id)) !== null && _a !== void 0 ? _a : AUDIENCE_CHOICES[0];
}
/**
 * Classify a scope string into one of the canonical buckets used by the
 * imported-token vault (`AudienceBucket`).
 *
 * NOTE: this is intentionally narrower than `extendedAudienceForScope`
 * below — the vault only short-circuits arm/graph/batch, so anything else
 * has to be re-introduced via a fresh import on every audience change.
 */
export function audienceForScope(scope) {
    const s = (scope !== null && scope !== void 0 ? scope : "").toLowerCase();
    if (s.includes("management.azure.com") || s.includes("management.core.windows.net")) {
        return "arm";
    }
    if (s.includes("graph.microsoft.com"))
        return "graph";
    if (s.includes("batch.core.windows.net"))
        return "batch";
    return "unknown";
}
/**
 * Classify a scope string into the *extended* set of tricky-login audiences
 * (12 + custom). Mirrors `audienceForScope` for arm/graph/batch but also
 * recognises vault, storage, intune, substrate, monitor, powerbi, yammer,
 * devops. Returns `"custom"` when no entry matches.
 */
export function extendedAudienceForScope(scope) {
    const s = (scope !== null && scope !== void 0 ? scope : "").toLowerCase();
    if (s.includes("management.azure.com") ||
        s.includes("management.core.windows.net")) {
        return "arm";
    }
    if (s.includes("graph.microsoft.com"))
        return "graph";
    if (s.includes("batch.core.windows.net"))
        return "batch";
    if (s.includes("vault.azure.net"))
        return "vault";
    if (s.includes("storage.azure.com"))
        return "storage";
    if (s.includes("manage.microsoft.com"))
        return "intune";
    if (s.includes("substrate.office.com"))
        return "substrate";
    if (s.includes("monitor.azure.com"))
        return "monitor";
    if (s.includes("analysis.windows.net/powerbi"))
        return "powerbi";
    if (s.includes("api.yammer.com"))
        return "yammer";
    if (s.includes("499b84ac-1321-427f-aa17-267ca6975798"))
        return "devops";
    return "custom";
}
/**
 * Compact per-claim explainers rendered as `InfoTooltip` hovers on the
 * decoded-claims table. Same provenance as the token-importer page's
 * `CLAIM_EXPLAIN` map but kept page-local so this module doesn't depend
 * on the importer.
 */
export const CLAIM_EXPLAIN = Object.freeze({
    tid: "Tenant id — directory the token was minted against. For a tricky-login mint, this is the TARGET tenant.",
    oid: "AAD object id of the principal (user / SP / managed identity). Stable across all of Azure.",
    aud: "Audience — resource server the token is valid for. Drives the canonical ARM / Graph / Batch routing.",
    scp: "OAuth scope claim — space-separated delegated permissions granted to the token.",
    iss: "Issuer — STS endpoint that minted the token (https://login.microsoftonline.com/{tid}/v2.0 for v2).",
    azp: "Authorised party — client app id that requested the token (v2 tokens). For MSAL-silent flows this is the configured WebUI client.",
    appid: "Client app id (v1 tokens) — same role as azp. For FOCI exchanges this is the TARGET FOCI client id.",
    exp: "Expiration time (epoch seconds). Token MUST be rejected after this instant.",
    iat: "Issued-at time (epoch seconds). Useful for spotting clock-skew issues.",
    nbf: "Not-before time (epoch seconds). Usually equal to iat.",
    upn: "User Principal Name — sign-in identifier of the operator. For guest mints this stays as the operator's HOME UPN, not the target tenant.",
    preferred_username: "v2-token equivalent of upn — what the operator prefers to be addressed as.",
    name: "Human-readable display name of the operator.",
    ver: "Token version — 1.0 (legacy v1 endpoint) or 2.0 (v2 endpoint).",
    acct: "Account status in the target tenant: 0 = member, 1 = guest. Useful to confirm the tricky-login produced a guest-context token.",
    idp: "Identity provider — for guest tokens, the home tenant the operator authenticated against (e.g. https://sts.windows.net/{home-tid}/).",
});
/**
 * Format an epoch-seconds value as a friendly "expires in Xm Ys" string.
 * Returns "expired Xs ago" for past values, "—" for missing data.
 */
export function formatExpiresIn(epoch) {
    if (!epoch || !Number.isFinite(epoch))
        return "—";
    const now = Math.floor(Date.now() / 1000);
    const delta = epoch - now;
    if (delta <= 0)
        return `expired ${fmtDuration(-delta)} ago`;
    return `${fmtDuration(delta)} left`;
}
/** Compact duration formatter shared by the result + history rows. */
export function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return "—";
    if (seconds < 60)
        return `${Math.floor(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60)
        return s > 0 ? `${m}m ${Math.floor(s)}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m - h * 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}
/** Mask a token for screen-share-safe display. */
export function maskToken(value, visible = 6) {
    if (!value)
        return "";
    if (value.length <= visible * 2 + 3)
        return "•".repeat(value.length);
    return `${value.slice(0, visible)}${"•".repeat(8)}${value.slice(-visible)}`;
}
/**
 * Pull a stable AAD error code (AADSTSnnnnn) out of a raw error message
 * when present. Used so the history table shows a short, actionable code
 * instead of the multi-line AAD error_description.
 */
export function extractAadErrorCode(message) {
    if (!message)
        return undefined;
    const m = /AADSTS(\d{4,7})/i.exec(message);
    return m ? `AADSTS${m[1]}` : undefined;
}
/**
 * Reduce a full mint result to its history-row shape. We do NOT persist
 * token material — only metadata — so the history blob is safe to land
 * in sessionStorage and to print in audit logs.
 */
export function toHistoryRow(result) {
    return {
        id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${result.finishedAt}-${Math.random().toString(36).slice(2, 10)}`,
        sourceAccountId: result.sourceAccountId,
        sourceAccountLabel: result.sourceAccountLabel,
        targetTenantId: result.targetTenantId,
        targetTenantLabel: result.targetTenantLabel,
        methodUsed: result.methodUsed,
        audience: result.audience,
        extendedAudience: result.extendedAudience,
        scope: result.scope,
        status: result.status,
        durationMs: result.durationMs,
        errorCode: result.errorCode,
        finishedAt: result.finishedAt,
    };
}
/** sessionStorage key for the persisted history. Versioned so we can bump. */
export const HISTORY_STORAGE_KEY = "tricky-login:history:v1";
/** Cap on history entries — same as the spec calls out. */
export const HISTORY_MAX_ENTRIES = 20;
/** sessionStorage handoff key the Token Importer page reads from. */
export const TOKEN_IMPORTER_SESSION_KEY = "token-importer:access-token";
/** Read the persisted history, tolerating quota / parse failures. */
export function loadHistory() {
    if (typeof window === "undefined")
        return [];
    try {
        const raw = window.sessionStorage.getItem(HISTORY_STORAGE_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed;
    }
    catch (_a) {
        return [];
    }
}
/** Persist the history, capped to HISTORY_MAX_ENTRIES (most-recent-first). */
export function saveHistory(rows) {
    if (typeof window === "undefined")
        return;
    try {
        const capped = rows.slice(0, HISTORY_MAX_ENTRIES);
        window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(capped));
    }
    catch (_a) {
        /* sessionStorage may be full / disabled — fail soft */
    }
}
/**
 * Human label for a method — used in the result panel + history.
 */
export function methodLabel(method) {
    switch (method) {
        case "msal-silent":
            return "MSAL Silent (multi-tenant)";
        case "foci-exchange":
            return "FOCI refresh-token exchange";
        case "auto":
            return "Auto (MSAL → FOCI)";
    }
}
/** Short tag for the method badge column. */
export function methodShortLabel(method) {
    switch (method) {
        case "msal-silent":
            return "MSAL";
        case "foci-exchange":
            return "FOCI";
        case "auto":
            return "Auto";
    }
}
/**
 * Friendly tenant label resolver — matches the search order used by
 * performTenantSwitch's `findTenantLabel`. Falls back to the tenantId
 * itself when the directory list hasn't been hydrated.
 */
export function findTenantLabel(tenants, tenantId) {
    var _a, _b;
    if (!tenantId)
        return "(unknown tenant)";
    const match = tenants === null || tenants === void 0 ? void 0 : tenants.find((t) => { var _a; return ((_a = t.tenantId) !== null && _a !== void 0 ? _a : "").toLowerCase() === tenantId.toLowerCase(); });
    return (_b = (_a = match === null || match === void 0 ? void 0 : match.displayName) !== null && _a !== void 0 ? _a : match === null || match === void 0 ? void 0 : match.defaultDomain) !== null && _b !== void 0 ? _b : tenantId;
}
//# sourceMappingURL=tricky-login-helpers.js.map