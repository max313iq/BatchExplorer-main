import { __awaiter } from "tslib";
/**
 * Partner-relationships probes — page-local helpers that surface
 * MSP / GDAP / Lighthouse / PAL "drift" signals on top of the
 * existing CSP/MPN/legal-business/PAL probes.
 *
 * These are read-only enumerations against Graph + ARM that the
 * defensive view of the operator's tenant cares about:
 *
 *   - **GDAP delegation creep.** Microsoft Graph exposes the partner-
 *     side ledger of customer relationships at
 *     `GET /v1.0/tenantRelationships/delegatedAdminRelationships`.
 *     The corpus playbook `_bypass_tenant_switch.md` §6.2 flags this
 *     as the canonical pivot vector — defenders rarely audit GDAP
 *     delegations because they're invisible in the customer's role
 *     list unless specifically queried. Whenever the operator's
 *     tenant has an unusually large or growing active-delegation set,
 *     it's worth surfacing: a compromised MSP inherits access to
 *     every downstream customer.
 *
 *   - **PAL drift across subscriptions.** Microsoft attributes Azure
 *     consumption to a partner of record by stamping
 *     `Microsoft.ManagementPartner/partners/{partnerId}` on a
 *     principal. The corpus playbook `_bypass_tenant_switch.md` §6.3
 *     calls out PAL as one of the "looks routine" signals defenders
 *     miss — a subscription stamped with a stale or third-party
 *     MPN still attributes consumption (and may indicate a stale
 *     MSP relationship the operator has forgotten about). We pull
 *     the operator's accessible subscriptions and flag those whose
 *     billing-property `quotaId` / partner attribution disagrees with
 *     the configured "preferred MPN".
 *
 * Both probes are kept page-local (not promoted to
 * `services/partner-center-service.ts`) per the per-page no-edit
 * constraint — they extend the partner-center surface without
 * mutating any shared service layer.
 *
 * Source-of-truth citations:
 *   - `New folder/_bypass_tenant_switch.md` §6.1–§6.3 (Lighthouse /
 *     GDAP / MSP supply-chain)
 *   - `New folder/_bypass_mixed_chains.md` Chain (MSP → customer) —
 *     uses the same Graph endpoint
 *   - `New folder/_AZURE_BYPASS_PLAYBOOK.md` Phase 4 (escalate via
 *     GDAP enumeration)
 */
import { AzureRequestError, classifyHttpError } from "../../services/types";
import { guardedFetch } from "../../scheduling/request-governance";
const GRAPH_BASE = "https://graph.microsoft.com";
const ARM_BASE = "https://management.azure.com";
/**
 * Tier-0 directory-role display names. Sourced from the corpus —
 * the canonical "owns the tenant" set called out in
 * `_bypass_role_grant.md` §1 and `_bypass_tenant_switch.md` §6.2.
 * Matched against `roleDefinition.displayName` from
 * `accessAssignments` / `roleAssignmentScheduleInstances` payloads.
 */
const HIGH_PRIV_ROLES = new Set([
    "Global Administrator",
    "Privileged Role Administrator",
    "Privileged Authentication Administrator",
    "Application Administrator",
    "Cloud Application Administrator",
    "Directory Writers",
    "Hybrid Identity Administrator",
    "Partner Tier2 Support",
    "User Administrator",
]);
const DELEGATION_CREEP_THRESHOLD = 25;
const HIGH_PRIV_RATIO_TRIGGER = 0.3;
/** Soft "delegation expires within N days" warning window. */
const EXPIRING_SOON_MS = 30 * 24 * 60 * 60 * 1000;
function graphHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ConsistencyLevel: "eventual",
    };
}
function armHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
    };
}
function asGraphError(response, fallback) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        let body = {};
        let raw = "";
        try {
            raw = yield response.text();
            if (raw.trim()) {
                try {
                    body = JSON.parse(raw);
                }
                catch (_d) {
                    /* keep raw */
                }
            }
        }
        catch (_e) {
            /* ignore */
        }
        const inner = (_a = body.error) !== null && _a !== void 0 ? _a : {};
        const code = (_b = inner.code) !== null && _b !== void 0 ? _b : "GraphError";
        const innerMsg = (_c = inner.message) !== null && _c !== void 0 ? _c : "";
        const trimmedRaw = raw.trim();
        const msg = innerMsg ||
            (trimmedRaw ? trimmedRaw.slice(0, 300) : "") ||
            `${fallback}: ${response.status}`;
        const retryAfter = response.headers.get("Retry-After");
        return classifyHttpError(msg, response.status, code, body, retryAfter);
    });
}
function probeFromGraphError(err, fallbackName) {
    if (err instanceof AzureRequestError) {
        const isAuth = err.status === 401 || err.status === 403;
        return {
            outcome: isAuth ? "unauthorized" : "fail",
            summary: isAuth
                ? `${fallbackName}: not authorized (HTTP ${err.status})`
                : `${fallbackName} failed (HTTP ${err.status})`,
            status: err.status,
            code: err.code,
            data: null,
            detail: err.message,
        };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const isAadAccessDenied = /consent_required|interaction_required|unauthorized_client|AADSTS65001|AADSTS70011|AADSTS50020|invalid_resource/i.test(msg);
    return {
        outcome: isAadAccessDenied ? "unauthorized" : "unknown",
        summary: isAadAccessDenied
            ? "Graph token denied — tenant lacks DelegatedAdminRelationship.Read.All"
            : `${fallbackName} could not be probed`,
        data: null,
        detail: msg,
    };
}
/**
 * Probe GDAP relationships from the partner side. Requires
 * `DelegatedAdminRelationship.Read.All` (or `*.ReadWrite.All`) on
 * Microsoft Graph for the operator's principal.
 *
 * Source: `_bypass_tenant_switch.md` §6.2; `_AZURE_BYPASS_PLAYBOOK.md`
 * Phase 4 (enumerate `/v1.0/tenantRelationships/delegatedAdminRelationships`).
 */
export function probeGdapDelegations(graphToken) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${GRAPH_BASE}/v1.0/tenantRelationships/delegatedAdminRelationships` +
            `?$select=id,displayName,customer,status,endDateTime,accessDetails`;
        try {
            const response = yield guardedFetch(url, { headers: graphHeaders(graphToken) }, { subscriptionId: "_gdap", family: "graph" });
            if (!response.ok)
                throw yield asGraphError(response, "list GDAP relationships");
            const body = (yield response.json());
            const rows = ((_a = body.value) !== null && _a !== void 0 ? _a : []).map((r) => {
                var _a, _b, _c, _d, _e, _f, _g;
                const roleNames = ((_b = (_a = r.accessDetails) === null || _a === void 0 ? void 0 : _a.unifiedRoles) !== null && _b !== void 0 ? _b : [])
                    .map((x) => { var _a; return (_a = x.roleDefinitionDisplayName) !== null && _a !== void 0 ? _a : ""; })
                    .filter((s) => !!s);
                const highPriv = roleNames.some((n) => HIGH_PRIV_ROLES.has(n));
                return {
                    id: (_c = r.id) !== null && _c !== void 0 ? _c : "",
                    displayName: (_d = r.displayName) !== null && _d !== void 0 ? _d : "(unnamed)",
                    customerTenantId: (_e = r.customer) === null || _e === void 0 ? void 0 : _e.tenantId,
                    customerDisplayName: (_f = r.customer) === null || _f === void 0 ? void 0 : _f.displayName,
                    status: ((_g = r.status) !== null && _g !== void 0 ? _g : "unknown").toString(),
                    endDateTime: r.endDateTime,
                    roleNames,
                    highPriv,
                };
            });
            const now = Date.now();
            const active = rows.filter((r) => r.status === "active");
            const expiringSoon = active.filter((r) => !!r.endDateTime &&
                new Date(r.endDateTime).getTime() - now < EXPIRING_SOON_MS);
            const highPrivActive = active.filter((r) => r.highPriv);
            const creep = active.length >= DELEGATION_CREEP_THRESHOLD ||
                (active.length > 0 &&
                    highPrivActive.length / active.length >= HIGH_PRIV_RATIO_TRIGGER &&
                    highPrivActive.length >= 3);
            return {
                outcome: "pass",
                summary: creep
                    ? `GDAP creep: ${active.length} active (${highPrivActive.length} high-priv)`
                    : `${active.length} active GDAP delegations (of ${rows.length} total)`,
                status: response.status,
                data: {
                    totalCount: rows.length,
                    activeCount: active.length,
                    highPrivActiveCount: highPrivActive.length,
                    expiringSoonCount: expiringSoon.length,
                    sample: rows.slice(0, 20),
                    creep,
                },
            };
        }
        catch (err) {
            return probeFromGraphError(err, "GDAP delegations");
        }
    });
}
/**
 * Probe subscription-level PAL drift. Requires ARM listing
 * permission. Optional `preferredMpn` (the configured MPN id) drives
 * the mismatch flag — when omitted, only the no-PAL gap is surfaced.
 *
 * Source: `_bypass_tenant_switch.md` §6.3 (PAL/MSP stale relationships).
 */
export function probePalDrift(armToken, preferredMpn, options = {}) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const { maxSubscriptions = 50 } = options;
        const listUrl = `${ARM_BASE}/subscriptions?api-version=2020-01-01`;
        try {
            const response = yield guardedFetch(listUrl, { headers: armHeaders(armToken) }, { subscriptionId: "_pal-drift", family: "arm" });
            if (!response.ok)
                throw yield asGraphError(response, "list subscriptions");
            const body = (yield response.json());
            const subs = ((_a = body.value) !== null && _a !== void 0 ? _a : []).slice(0, maxSubscriptions);
            const rows = yield Promise.all(subs.map((s) => __awaiter(this, void 0, void 0, function* () {
                var _b, _c, _d, _e, _f;
                const subId = (_b = s.subscriptionId) !== null && _b !== void 0 ? _b : "";
                const row = {
                    subscriptionId: subId,
                    displayName: (_c = s.displayName) !== null && _c !== void 0 ? _c : subId,
                    state: (_d = s.state) !== null && _d !== void 0 ? _d : "Unknown",
                    tenantId: s.tenantId,
                    palPartnerId: undefined,
                    mismatch: false,
                    noPal: true,
                };
                if (!subId)
                    return row;
                // Subscription-scoped PAL endpoint. Some ARM builds reject
                // `GET partners` collection and only accept `GET partners/{id}`;
                // we ignore non-200 silently and mark noPal=true.
                try {
                    const palUrl = `${ARM_BASE}/subscriptions/${encodeURIComponent(subId)}/providers/` +
                        `Microsoft.ManagementPartner/partners?api-version=2018-02-01`;
                    const palResp = yield guardedFetch(palUrl, { headers: armHeaders(armToken) }, { subscriptionId: subId, family: "arm" });
                    if (palResp.status === 200) {
                        const data = (yield palResp.json());
                        const first = (_e = data.value) === null || _e === void 0 ? void 0 : _e[0];
                        const pid = (_f = first === null || first === void 0 ? void 0 : first.properties) === null || _f === void 0 ? void 0 : _f.partnerId;
                        if (pid) {
                            row.palPartnerId = pid;
                            row.noPal = false;
                            if (preferredMpn && pid !== preferredMpn) {
                                row.mismatch = true;
                            }
                        }
                    }
                }
                catch (_g) {
                    /* swallow per-subscription failure; row stays noPal=true */
                }
                return row;
            })));
            const noPalCount = rows.filter((r) => r.noPal).length;
            const mismatchCount = rows.filter((r) => r.mismatch).length;
            const detail = preferredMpn
                ? `${mismatchCount} mismatched, ${noPalCount} no-PAL`
                : `${noPalCount} no-PAL (no preferred MPN configured)`;
            return {
                outcome: "pass",
                summary: `${rows.length} subscriptions scanned — ${detail}`,
                status: response.status,
                data: {
                    totalSubscriptions: rows.length,
                    noPalCount,
                    mismatchCount,
                    preferredMpn: preferredMpn !== null && preferredMpn !== void 0 ? preferredMpn : null,
                    rows,
                },
            };
        }
        catch (err) {
            return probeFromGraphError(err, "Subscription PAL drift");
        }
    });
}
/**
 * Iterate customer IDs and probe each one. The progress callback
 * fires after each customer so the page can paint a progress bar.
 *
 * Cancellation: the supplied `AbortSignal` is checked before each
 * iteration so the operator can bail out of a long sweep without
 * leaking a setState into a stale render.
 */
export function bulkProbeCustomers(customerIds, partnerCenterToken, opts = {}) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        const { signal, onProgress } = opts;
        const out = [];
        for (let i = 0; i < customerIds.length; i += 1) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                break;
            const id = customerIds[i];
            const row = { customerId: id, outcome: "skipped" };
            try {
                // GET /v1/customers/{id} returns companyProfile + a subscriptions
                // pointer. Slim payload, single round-trip per customer.
                const url = `https://api.partnercenter.microsoft.com/v1/customers/${encodeURIComponent(id)}`;
                const r = yield guardedFetch(url, {
                    headers: {
                        Authorization: `Bearer ${partnerCenterToken}`,
                        Accept: "application/json",
                        "Accept-Language": "en-US",
                    },
                }, { subscriptionId: "_partner-center", family: "partner-center" });
                if (r.ok) {
                    const body = (yield r.json());
                    row.companyName = (_a = body.companyProfile) === null || _a === void 0 ? void 0 : _a.companyName;
                    row.domain = (_b = body.companyProfile) === null || _b === void 0 ? void 0 : _b.domain;
                    row.outcome = "pass";
                }
                else if (r.status === 401 || r.status === 403) {
                    row.outcome = "unauthorized";
                    row.error = `HTTP ${r.status}`;
                }
                else {
                    row.outcome = "fail";
                    row.error = `HTTP ${r.status}`;
                }
            }
            catch (err) {
                row.outcome = "fail";
                row.error = err instanceof Error ? err.message : String(err);
            }
            out.push(row);
            onProgress === null || onProgress === void 0 ? void 0 : onProgress(i + 1, customerIds.length, row);
        }
        return out;
    });
}
//# sourceMappingURL=partner-relationships-probe.js.map