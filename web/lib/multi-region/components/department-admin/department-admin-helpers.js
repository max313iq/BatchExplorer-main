// ---------------------------------------------------------------------------
// 1) Service-principal owner detection
// ---------------------------------------------------------------------------
/**
 * Heuristic: does this `accountOwner` string look like a service
 * principal / managed identity rather than a human UPN?
 *
 * Signals (any one is sufficient):
 *   - Local part is a bare GUID (32 hex chars or 8-4-4-4-12 form).
 *     Both SP appIds and managed-identity client ids show up this way
 *     when surfaced through the EA `principalName` field.
 *   - Domain is `onmicrosoft.com` AND local part contains no dot
 *     AND local part is >= 16 chars of base16 — a known AAD pattern
 *     for SP-display-name-derived UPNs that lack a human-friendly
 *     alias.
 *   - Owner string starts with `sp:`, `app:`, `mi:` (sometimes EA
 *     billing assignments echo a prefix through `principalName` when
 *     populated by an SDK rather than the portal).
 *   - Owner is literally an objectId (no `@` at all) of GUID form.
 *
 * False-positive policy: we'd rather over-flag than miss — flagging a
 * weird-looking-but-real human costs an operator one read; missing a
 * silently-added SP costs them a compliance finding.
 */
export function looksLikeServicePrincipal(accountOwner) {
    if (!accountOwner)
        return false;
    const s = accountOwner.trim();
    if (s.length === 0)
        return false;
    // sp:/app:/mi: prefix
    if (/^(sp|app|mi):/i.test(s))
        return true;
    // Pure GUID (no @ at all) — usually an objectId pasted as the owner
    if (!s.includes("@") &&
        /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s.replace(/-/g, ""))) {
        return true;
    }
    // UPN-style with GUID local part
    if (s.includes("@")) {
        const [local, domain = ""] = s.split("@");
        if (!local)
            return false;
        // GUID with or without dashes in the local part
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(local) ||
            /^[0-9a-f]{32}$/i.test(local)) {
            return true;
        }
        // *.onmicrosoft.com with a long base16-only local part and no
        // dot inside the local part (humans usually have a "." in their
        // alias). Threshold of 16 chars keeps short admin aliases safe.
        if (domain.toLowerCase().endsWith(".onmicrosoft.com") &&
            !local.includes(".") &&
            /^[0-9a-f]{16,}$/i.test(local)) {
            return true;
        }
    }
    return false;
}
/** Convenience — pick out SP-shaped owners from a list of EAs. */
export function eaOwnersThatLookLikeSps(eas) {
    return eas.filter((e) => looksLikeServicePrincipal(e.accountOwner));
}
const DEFAULT_CLOUD = {
    env: "AzureCommercial",
    portalHost: "portal.azure.com",
    label: "Azure Commercial",
};
/**
 * Minimal `iss`-claim classifier. Decode-only — no signature check (we
 * trust the token because we already used it to call ARM successfully).
 *
 * Returns `DEFAULT_CLOUD` for null / malformed tokens, on the principle
 * that commercial is the overwhelmingly common case and producing a
 * commercial deep-link from a Gov tenant is recoverable (the portal
 * just won't find the resource) while suppressing the link entirely
 * would degrade the page for the 99% case.
 */
export function inferCloudFromToken(token) {
    var _a, _b;
    if (!token)
        return DEFAULT_CLOUD;
    const parts = token.split(".");
    if (parts.length < 2)
        return DEFAULT_CLOUD;
    try {
        const body = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = body.length % 4;
        const padded = pad ? body + "=".repeat(4 - pad) : body;
        const decoded = typeof atob === "function"
            ? atob(padded)
            : // Node fallback for tests
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (_b = (_a = globalThis.Buffer) === null || _a === void 0 ? void 0 : _a.from(padded, "base64").toString("utf8")) !== null && _b !== void 0 ? _b : "";
        const json = JSON.parse(decoded);
        const iss = typeof json.iss === "string" ? json.iss.toLowerCase() : "";
        if (iss.includes("login.microsoftonline.us") ||
            iss.includes("sts.windows.us")) {
            return {
                env: "AzureUSGovernment",
                portalHost: "portal.azure.us",
                label: "Azure US Government",
            };
        }
        if (iss.includes("login.partner.microsoftonline.cn") ||
            iss.includes("login.chinacloudapi.cn")) {
            return {
                env: "AzureChina",
                portalHost: "portal.azure.cn",
                label: "Azure China 21Vianet",
            };
        }
        if (iss.includes("login.microsoftonline.com") ||
            iss.includes("sts.windows.net")) {
            return DEFAULT_CLOUD;
        }
        return { env: "Unknown", portalHost: "portal.azure.com", label: "Unknown cloud" };
    }
    catch (_c) {
        return DEFAULT_CLOUD;
    }
}
/**
 * Compose a portal deep link into the EA billing-account /
 * enrollment-account blade for the given cloud. The portal route is
 * the same across clouds — only the host changes — so a single
 * builder serves all three.
 *
 * `billingAccountArmId` is the full ARM id of the billing account.
 * `enrollmentAccountArmId` is the full ARM id of the EA. We URL-encode
 * both for safety even though the ids are documented as ascii.
 */
export function portalEnrollmentAccountLink(cloud, enrollmentAccountArmId, tenantId) {
    const tenant = tenantId ? `@${encodeURIComponent(tenantId)}` : "";
    return (`https://${cloud.portalHost}/#${tenant}` +
        `/resource${enrollmentAccountArmId}/overview`);
}
// ---------------------------------------------------------------------------
// 3) Baseline drift snapshot
// ---------------------------------------------------------------------------
const BASELINE_STORAGE_PREFIX = "department-admin:baseline:v1:";
function snapshotKey(billingAccountName, departmentName) {
    return (BASELINE_STORAGE_PREFIX +
        `${billingAccountName}::${departmentName}`);
}
/**
 * Read the persisted snapshot for `(ba, dept)`, or `null` if none.
 * Tolerates malformed JSON / wrong-version blobs by returning null —
 * never throws.
 */
export function readBaselineSnapshot(billingAccountName, departmentName) {
    if (!billingAccountName || !departmentName)
        return null;
    try {
        const raw = localStorage.getItem(snapshotKey(billingAccountName, departmentName));
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        if (!parsed ||
            parsed.version !== 1 ||
            !Array.isArray(parsed.members) ||
            typeof parsed.takenAt !== "string") {
            return null;
        }
        return parsed;
    }
    catch (_a) {
        return null;
    }
}
/** Persist a snapshot of the current live EA roster. */
export function writeBaselineSnapshot(billingAccountName, departmentName, takenBy, eas) {
    const snapshot = {
        version: 1,
        takenAt: new Date().toISOString(),
        takenBy,
        billingAccountName,
        departmentName,
        members: eas.map((e) => {
            var _a, _b;
            return ({
                id: e.id,
                name: e.name,
                displayName: e.displayName,
                accountOwner: (_a = e.accountOwner) !== null && _a !== void 0 ? _a : "",
                status: (_b = e.status) !== null && _b !== void 0 ? _b : "",
            });
        }),
    };
    try {
        localStorage.setItem(snapshotKey(billingAccountName, departmentName), JSON.stringify(snapshot));
    }
    catch (_a) {
        /* quota / disabled — caller decides whether to surface */
    }
    return snapshot;
}
/** Clear the persisted snapshot for `(ba, dept)`. */
export function clearBaselineSnapshot(billingAccountName, departmentName) {
    try {
        localStorage.removeItem(snapshotKey(billingAccountName, departmentName));
    }
    catch (_a) {
        /* ignore */
    }
}
/**
 * Compute the drift between a saved snapshot and the live EA list.
 * Matching is by ARM id so display-name renames don't show up as
 * add+remove. Returns empty arrays everywhere when `snapshot` is null
 * so the UI can render uniformly.
 */
export function computeBaselineDrift(snapshot, live) {
    var _a, _b;
    if (!snapshot) {
        return { added: [], removed: [], ownerChanged: [], statusChanged: [] };
    }
    const liveById = new Map();
    for (const e of live)
        liveById.set(e.id, e);
    const snapById = new Map();
    for (const m of snapshot.members)
        snapById.set(m.id, m);
    const added = [];
    for (const e of live)
        if (!snapById.has(e.id))
            added.push(e);
    const removed = [];
    for (const m of snapshot.members)
        if (!liveById.has(m.id))
            removed.push(m);
    const ownerChanged = [];
    const statusChanged = [];
    for (const e of live) {
        const prev = snapById.get(e.id);
        if (!prev)
            continue;
        const curOwner = (_a = e.accountOwner) !== null && _a !== void 0 ? _a : "";
        if (prev.accountOwner !== curOwner) {
            ownerChanged.push({
                id: e.id,
                displayName: e.displayName,
                previous: prev.accountOwner,
                current: curOwner,
            });
        }
        const curStatus = (_b = e.status) !== null && _b !== void 0 ? _b : "";
        if (prev.status !== curStatus) {
            statusChanged.push({
                id: e.id,
                displayName: e.displayName,
                previous: prev.status,
                current: curStatus,
            });
        }
    }
    return { added, removed, ownerChanged, statusChanged };
}
/** Total count of differences — convenient for badge / "any drift" gates. */
export function driftCount(d) {
    return (d.added.length +
        d.removed.length +
        d.ownerChanged.length +
        d.statusChanged.length);
}
//# sourceMappingURL=department-admin-helpers.js.map