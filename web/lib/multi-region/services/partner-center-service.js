/**
 * Microsoft Partner Center service layer.
 *
 * Lightweight probes that the Partner Center page uses to determine
 * whether a signed-in account holds Cloud Solution Provider (CSP) or
 * Microsoft Partner Network / Microsoft AI Cloud Partner Program
 * (MPN / MAICPP) capability, plus the Partner Admin Link (PAL) helpers
 * that live on the ARM control plane under
 * `Microsoft.ManagementPartner/partners/{partnerId}`.
 *
 * Each probe returns a discriminated `ProbeResult` so the UI can show
 * a clean pass / fail / unknown badge without having to parse error
 * shapes per call site.
 */
import { __awaiter } from "tslib";
import { AzureRequestError, classifyHttpError } from "./types";
import { guardedFetch } from "../scheduling/request-governance";
const PARTNER_CENTER_BASE = "https://api.partnercenter.microsoft.com";
const ARM_BASE = "https://management.azure.com";
const PAL_API_VERSION = "2018-02-01";
/* ─────────────────────────────────────────────────────────────────────
 * Local helpers
 * ───────────────────────────────────────────────────────────────────── */
function pcHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        // Partner Center sometimes locale-gates fields; en-US is the safe
        // default. Operators can override via Accept-Language at the
        // browser-level if needed.
        "Accept-Language": "en-US",
    };
}
function armHeaders(token, contentType) {
    const h = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
    };
    if (contentType)
        h["Content-Type"] = contentType;
    return h;
}
function toError(response, fallbackMessage) {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function* () {
        let body = {};
        let raw = "";
        try {
            raw = yield response.text();
            if (raw && raw.trim()) {
                try {
                    body = JSON.parse(raw);
                }
                catch (_f) {
                    /* keep raw */
                }
            }
        }
        catch (_g) {
            /* ignore */
        }
        const inner = (_a = body.error) !== null && _a !== void 0 ? _a : {};
        const code = (_c = (_b = inner.code) !== null && _b !== void 0 ? _b : body.code) !== null && _c !== void 0 ? _c : "PartnerCenterError";
        const innerMsg = (_e = (_d = inner.message) !== null && _d !== void 0 ? _d : body.description) !== null && _e !== void 0 ? _e : "";
        let msg = innerMsg.trim() ||
            (raw && raw.trim() ? raw.trim().slice(0, 500) : "") ||
            `${fallbackMessage}: ${response.status}`;
        const urlPath = (() => {
            try {
                return new URL(response.url).pathname;
            }
            catch (_a) {
                return response.url || undefined;
            }
        })();
        if (urlPath)
            msg = `${response.status} ${urlPath}: ${msg}`;
        const retryAfter = response.headers.get("Retry-After");
        const err = classifyHttpError(msg, response.status, code, body, retryAfter);
        if (urlPath)
            err.urlPath = urlPath;
        return err;
    });
}
/** Convert any thrown value into a `ProbeResult.fail/unauthorized`. */
function probeFromError(err, fallbackName) {
    if (err instanceof AzureRequestError) {
        const isAuth = err.status === 401 || err.status === 403;
        return {
            outcome: isAuth ? "unauthorized" : "fail",
            summary: isAuth
                ? `Not authorized (HTTP ${err.status})`
                : `${fallbackName} failed: HTTP ${err.status}`,
            status: err.status,
            code: err.code,
            data: null,
            detail: err.message,
        };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Token-acquisition or network failures land here. AAD's
    // `consent_required` / `interaction_required` / `unauthorized_client`
    // for a tenant without partner enrolment are good signals that the
    // account isn't a CSP partner — surface that as `unauthorized`.
    const isAadAccessDenied = /consent_required|interaction_required|unauthorized_client|AADSTS65001|AADSTS70011|AADSTS50020|invalid_resource/i.test(msg);
    return {
        outcome: isAadAccessDenied ? "unauthorized" : "unknown",
        summary: isAadAccessDenied
            ? "Token denied — tenant is not enrolled as a CSP partner"
            : `${fallbackName} could not be probed`,
        data: null,
        detail: msg,
    };
}
/**
 * Probe Cloud Solution Provider (CSP) capability.
 *
 * Hits `GET /v1/customers?size=1` on Partner Center. A 200 with a
 * `totalCount`/`items` payload means the account holds at least the
 * CSP "view customers" permission — i.e. is enrolled as a CSP
 * partner. 401/403 means the account is signed in but lacks CSP
 * access. Token-acquisition failure (consent_required etc.) typically
 * means the tenant isn't a partner tenant at all.
 */
export function probeCspAccess(partnerCenterToken) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${PARTNER_CENTER_BASE}/v1/customers?size=1`;
        try {
            const response = yield guardedFetch(url, { headers: pcHeaders(partnerCenterToken) }, { subscriptionId: "_partner-center", family: "partner-center" });
            if (!response.ok)
                throw yield toError(response, "list customers");
            const body = (yield response.json());
            const total = typeof body.totalCount === "number" ? body.totalCount : 0;
            const sample = ((_a = body.items) !== null && _a !== void 0 ? _a : [])
                .map((c) => { var _a; return (_a = c.id) !== null && _a !== void 0 ? _a : ""; })
                .filter((s) => !!s)
                .slice(0, 5);
            return {
                outcome: "pass",
                summary: `CSP access confirmed (${total} customer${total === 1 ? "" : "s"})`,
                status: response.status,
                data: { totalCount: total, sample },
            };
        }
        catch (err) {
            return probeFromError(err, "CSP customers");
        }
    });
}
/**
 * Probe Microsoft Partner Network / MAICPP capability.
 *
 * Hits `GET /v1/profiles/mpn` on Partner Center. A 200 means the
 * account's tenant has an MPN profile registered — the response
 * carries the `mpnId` (Partner ID) and the membership profile type.
 */
export function probeMpnProfile(partnerCenterToken) {
    var _a, _b, _c, _d;
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${PARTNER_CENTER_BASE}/v1/profiles/mpn`;
        try {
            const response = yield guardedFetch(url, { headers: pcHeaders(partnerCenterToken) }, { subscriptionId: "_partner-center", family: "partner-center" });
            if (!response.ok)
                throw yield toError(response, "get MPN profile");
            const raw = (yield response.json());
            const mpnId = (_b = (_a = raw.mpnId) !== null && _a !== void 0 ? _a : raw.partnerId) !== null && _b !== void 0 ? _b : undefined;
            const profileType = (_d = (_c = raw.profileType) !== null && _c !== void 0 ? _c : raw.type) !== null && _d !== void 0 ? _d : undefined;
            return {
                outcome: "pass",
                summary: mpnId
                    ? `MPN profile present (Partner ID ${mpnId})`
                    : "MPN profile present",
                status: response.status,
                data: { mpnId, profileType, raw },
            };
        }
        catch (err) {
            return probeFromError(err, "MPN profile");
        }
    });
}
/**
 * Probe the partner's legal-business profile — proves the partner is
 * past the onboarding "business verification" gate. Often the first
 * call that fails if a partner is mid-onboarding or has had their
 * partnership suspended.
 */
export function probeLegalBusinessProfile(partnerCenterToken) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${PARTNER_CENTER_BASE}/v1/profiles/legalbusiness`;
        try {
            const response = yield guardedFetch(url, { headers: pcHeaders(partnerCenterToken) }, { subscriptionId: "_partner-center", family: "partner-center" });
            if (!response.ok)
                throw yield toError(response, "get legal-business profile");
            const raw = (yield response.json());
            const companyName = ((_a = raw.companyName) !== null && _a !== void 0 ? _a : "").trim() || undefined;
            return {
                outcome: "pass",
                summary: companyName
                    ? `Legal business: ${companyName}`
                    : "Legal business profile present",
                status: response.status,
                data: { companyName, raw },
            };
        }
        catch (err) {
            return probeFromError(err, "Legal business profile");
        }
    });
}
/**
 * Read the Partner Admin Link for the signed-in principal. ARM
 * accepts any 6+ digit partner id in the path — the call only
 * succeeds if THAT partner id is linked. If you just want to check
 * "is anything linked", you have to know the partner id up front;
 * this helper takes one and confirms.
 */
export function getPartnerAdminLink(partnerId, armToken) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${ARM_BASE}/providers/Microsoft.ManagementPartner/partners/` +
            `${encodeURIComponent(partnerId)}?api-version=${PAL_API_VERSION}`;
        try {
            const response = yield guardedFetch(url, { headers: armHeaders(armToken) }, { subscriptionId: "_partner-admin-link", family: "arm" });
            // 404 is a legitimate "no link present" answer — surface as a
            // distinct outcome rather than throw.
            if (response.status === 404) {
                return {
                    outcome: "fail",
                    summary: `Partner ID ${partnerId} is not linked to this account`,
                    status: 404,
                    data: null,
                };
            }
            if (!response.ok)
                throw yield toError(response, "get Partner Admin Link");
            const raw = (yield response.json());
            const props = ((_a = raw.properties) !== null && _a !== void 0 ? _a : {});
            const createdTime = (_b = props.createdTime) !== null && _b !== void 0 ? _b : undefined;
            return {
                outcome: "pass",
                summary: `Partner ID ${partnerId} is linked`,
                status: response.status,
                data: { partnerId, createdTime, raw },
            };
        }
        catch (err) {
            return probeFromError(err, "Partner Admin Link");
        }
    });
}
/**
 * Link a Partner Admin Link Partner ID to the signed-in principal.
 * Idempotent — PUT against the same partner id succeeds even when the
 * link already exists.
 */
export function linkPartnerAdmin(partnerId, armToken) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${ARM_BASE}/providers/Microsoft.ManagementPartner/partners/` +
            `${encodeURIComponent(partnerId)}?api-version=${PAL_API_VERSION}`;
        const response = yield guardedFetch(url, {
            method: "PUT",
            headers: armHeaders(armToken, "application/json"),
            body: JSON.stringify({}),
        }, { subscriptionId: "_partner-admin-link", family: "arm" });
        if (!response.ok)
            throw yield toError(response, "link Partner Admin");
        const raw = (yield response.json());
        const props = ((_a = raw.properties) !== null && _a !== void 0 ? _a : {});
        return {
            partnerId,
            createdTime: (_b = props.createdTime) !== null && _b !== void 0 ? _b : undefined,
            raw,
        };
    });
}
/**
 * Unlink the Partner Admin Link. Treats 404 (already unlinked) as
 * silent success — the caller's intent is satisfied either way.
 */
export function unlinkPartnerAdmin(partnerId, armToken) {
    return __awaiter(this, void 0, void 0, function* () {
        const url = `${ARM_BASE}/providers/Microsoft.ManagementPartner/partners/` +
            `${encodeURIComponent(partnerId)}?api-version=${PAL_API_VERSION}`;
        const response = yield guardedFetch(url, {
            method: "DELETE",
            headers: armHeaders(armToken),
        }, { subscriptionId: "_partner-admin-link", family: "arm" });
        if (response.status === 404)
            return;
        if (!response.ok)
            throw yield toError(response, "unlink Partner Admin");
    });
}
//# sourceMappingURL=partner-center-service.js.map