import { __awaiter } from "tslib";
/**
 * Storage & Key Vault Security Audit page.
 *
 * Defensive auditor inspired by NetSPI's MicroBurst toolkit. The
 * operator picks one or more accessible subscriptions; the page calls
 * ARM directly (read-only) to list every storage account and key
 * vault, evaluates each one against the rule set in
 * `security-audit-helpers.ts`, and renders the resulting findings
 * with severity badges, copy-id buttons, Portal deep-links, and
 * CSV / JSON exports.
 *
 * Why this is OK for a defensive audit (the line vs. MicroBurst):
 *   - MicroBurst's Invoke-EnumerateAzureBlobs and Invoke-EnumerateAzure
 *     SubDomains attack the *anonymous* surface — they probe sub-
 *     domains the operator may not own. We do NONE of that here:
 *     this page lists the operator's OWN resources via authenticated
 *     ARM calls and only reports config-level issues.
 *   - Every call is GET. No POST/PATCH/DELETE. Worst-case impact is
 *     the operator's ARM throttle budget.
 *
 * Hard constraints honored:
 *   - New files only (no edits to services / auth / store / router /
 *     sidebar / shared components).
 *   - useArmToken + TokenExpiryBadge.
 *   - Pagination via @odata.nextLink.
 *   - 403 subs surface as inline warning rows; we keep scanning the
 *     others.
 */
import * as React from "react";
import { Activity, AlertTriangle, BookOpen, CheckCircle2, Clock, CreditCard, EyeOff, ExternalLink, FileText, Filter as FilterIcon, FolderOpen, KeyRound, Layers, Loader2, RefreshCw, Search, ShieldAlert, ShieldCheck, ShieldOff, TrendingDown, TrendingUp, X, } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import { useArmToken } from "../../auth/use-arm-token";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { useMultiRegionState } from "../../store/store-context";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { ErrorBoundary } from "../shared/error-boundary";
import { ExportMenu } from "../shared/export-menu";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
// COORDINATOR: this page intentionally renders findings with the raw
// `@/components/ui/table` widget rather than `../shared/enhanced-table` —
// each finding row carries two inline tooltips ("why it matters" /
// "remediation") plus a CopyButton + Portal link in the actions cell,
// which is more layout than EnhancedTable's cell renderer cleanly
// expresses today. If EnhancedTable later grows per-row expand/tooltip
// slots, this page is a good candidate to migrate.
import { compareFindings, countByResourceType, countBySeverity, evaluateKeyVault, evaluateStorageAccount, parseArmId, portalUrlFor, SEVERITY_BADGE_VARIANT, SEVERITY_LABEL, SEVERITY_WEIGHT, summarizeFindings, } from "./security-audit-helpers";
import { appendPostureSnapshot, computePostureTrendDelta, computeTierZeroProtectionScore, evaluateDiagnosticSettings, evaluateIdleResourceGroups, evaluateSubscriptionStates, isCorpusFinding, riskScoreFor, } from "./security-audit-corpus-signals";
import { runbookFor } from "./security-audit-runbooks";
// --------------------------------------------------------------------------
// ARM constants
// --------------------------------------------------------------------------
const ARM_BASE = "https://management.azure.com";
const STORAGE_API_VERSION = "2023-05-01";
const KEYVAULT_API_VERSION = "2023-07-01";
// Diagnostic settings on a resource — used by Signal A.
// citation: New folder\_bypass_modify_delete.md:599 (matching DELETE)
const DIAGNOSTIC_SETTINGS_API_VERSION = "2021-05-01-preview";
// Tenant subscriptions enumeration — used by Signal B.
// Same api-version the DELETE in §5.11 cites, so the state shape we
// match against is the one ARM exposes alongside the cancellation.
const SUBSCRIPTIONS_API_VERSION = "2020-01-01";
// Resource-group + resource enumeration — used by Signal D.
const RESOURCEGROUPS_API_VERSION = "2021-04-01";
const RESOURCES_API_VERSION = "2021-04-01";
// Max pages we'll follow on one provider/sub probe — defensive guard
// against a runaway nextLink loop. 50 pages * 100 results per page =
// 5,000 resources per sub per provider is enough for every real
// tenant we've seen.
const PAGE_FOLLOW_CAP = 50;
// Tags that hint at temporary / non-production lifecycle. Matched
// case-insensitively on tag KEY or VALUE. Used by Signal D to bump
// idle-RG severity from medium to high.
const TEMP_TAG_HINTS = [
    "temp",
    "temporary",
    "ephemeral",
    "scratch",
    "dev",
    "development",
    "sandbox",
    "test",
];
/** Generic paginated ARM list-call. Follows `nextLink` /
 *  `@odata.nextLink` until exhausted or the safety cap kicks in.
 *  Returns the accumulated `.value` array. */
function fetchArmPaged(initialUrl, token, signal) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const out = [];
        let url = initialUrl;
        let pages = 0;
        while (url && pages < PAGE_FOLLOW_CAP) {
            const res = yield fetch(url, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
                signal,
            });
            if (!res.ok) {
                const body = yield res.text().catch(() => "");
                const err = new Error(`ARM ${res.status} ${res.statusText} on ${url}${body ? ` — ${body.slice(0, 200)}` : ""}`);
                err.status = res.status;
                throw err;
            }
            const payload = (yield res.json());
            if (Array.isArray(payload.value)) {
                out.push(...payload.value);
            }
            const next = (_a = payload["nextLink"]) !== null && _a !== void 0 ? _a : payload["@odata.nextLink"];
            url = next;
            pages += 1;
        }
        return out;
    });
}
function listStorageAccountsUrl(subscriptionId) {
    return `${ARM_BASE}/subscriptions/${subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=${STORAGE_API_VERSION}`;
}
function listKeyVaultsUrl(subscriptionId) {
    return `${ARM_BASE}/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/vaults?api-version=${KEYVAULT_API_VERSION}`;
}
// Diagnostic-settings list on a specific resource. Used by Signal A.
// citation: New folder\_bypass_modify_delete.md §5.14
function listDiagnosticSettingsUrl(resourceArmId) {
    const trimmed = resourceArmId.startsWith("/")
        ? resourceArmId
        : `/${resourceArmId}`;
    return `${ARM_BASE}${trimmed}/providers/microsoft.insights/diagnosticSettings?api-version=${DIAGNOSTIC_SETTINGS_API_VERSION}`;
}
// Subscriptions list (defensive Signal B). Tenant-wide; one token is
// sufficient. citation: New folder\_bypass_modify_delete.md §5.11.
function listSubscriptionsUrl() {
    return `${ARM_BASE}/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`;
}
// Resource groups in a subscription (Signal D — idle / empty RG).
function listResourceGroupsUrl(subscriptionId) {
    return `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups?api-version=${RESOURCEGROUPS_API_VERSION}`;
}
// All resources in an RG with $expand=changedTime,createdTime — we
// derive the RG's last-modified from the max of these timestamps.
// citation: posture surface used by Azucar / ScoutSuite to detect
// orphaned RGs (see _analysis_defender_view.md §1).
function listResourcesInGroupUrl(subscriptionId, resourceGroupName) {
    return `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroupName)}/resources?api-version=${RESOURCES_API_VERSION}&$expand=changedTime,createdTime`;
}
/**
 * Scan ONE subscription end-to-end: list storage accounts + key
 * vaults in parallel, evaluate every resource, return the combined
 * findings list. Throws on hard failures (network outage) but
 * 403 / 404 / 429 are caught and surfaced via the `error` field on
 * SubScanResult so the page can render a warning row instead of
 * blowing up the whole scan.
 *
 * Corpus signals layered on top:
 *   - Signal A: per Tier-0 resource diagnostic-settings probe (Key
 *     Vaults always counted Tier-0; storage accounts marked tier-1
 *     by default). citation: New folder\_AZURE_BYPASS_PLAYBOOK.md
 *     item 8 + _bypass_modify_delete.md §5.14
 *   - Signal D: resource-group enumeration with $expand=changedTime
 *     to detect idle / empty RGs. citation: New folder
 *     \_analysis_defender_view.md §1 (Azucar / ScoutSuite findings
 *     model — orphan / idle infra posture failures).
 */
function scanSubscription(args, subscriptionName, opts) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const { sub, token, signal } = args;
        const result = {
            subscriptionId: sub.subscriptionId,
            subscriptionName,
            storageCount: 0,
            vaultCount: 0,
            findings: [],
        };
        try {
            const [storage, vaults, rgs] = yield Promise.all([
                fetchArmPaged(listStorageAccountsUrl(sub.subscriptionId), token, signal).catch((err) => {
                    // 403 on ONE provider — surface as partial, keep the other.
                    if (err.status === 403 || err.status === 401) {
                        return { __forbidden: true, message: err.message };
                    }
                    throw err;
                }),
                fetchArmPaged(listKeyVaultsUrl(sub.subscriptionId), token, signal).catch((err) => {
                    if (err.status === 403 || err.status === 401) {
                        return { __forbidden: true, message: err.message };
                    }
                    throw err;
                }),
                // Signal D probe — resource groups for idle / empty RG detection.
                // Tolerated to fail same as storage/vaults so a 403 on RG list
                // doesn't kill the whole sub scan.
                fetchArmPaged(listResourceGroupsUrl(sub.subscriptionId), token, signal).catch((err) => {
                    if (err.status === 403 || err.status === 401) {
                        return { __forbidden: true, message: err.message };
                    }
                    // RG enumeration failure is non-fatal — log but continue.
                    return [];
                }),
            ]);
            const storageList = Array.isArray(storage) ? storage : [];
            const vaultList = Array.isArray(vaults) ? vaults : [];
            const rgList = Array.isArray(rgs) ? rgs : [];
            // Track per-provider 403s so the warning row makes sense even
            // when one provider succeeded and the other didn't.
            const partialErrors = [];
            if (!Array.isArray(storage)) {
                partialErrors.push("storage accounts (403)");
            }
            if (!Array.isArray(vaults)) {
                partialErrors.push("key vaults (403)");
            }
            if (!Array.isArray(rgs)) {
                partialErrors.push("resource groups (403)");
            }
            result.storageCount = storageList.length;
            result.vaultCount = vaultList.length;
            for (const sa of storageList) {
                result.findings.push(...evaluateStorageAccount(sa, subscriptionName));
            }
            for (const kv of vaultList) {
                result.findings.push(...evaluateKeyVault(kv, subscriptionName));
            }
            // --- Signal A: diagnostic settings ---
            // Probe each storage account + key vault for its diagnostic
            // settings. We bound concurrency to 5 so a sub with hundreds of
            // resources doesn't burst the ARM throttle. citation: New folder
            // \_bypass_modify_delete.md §5.14 (DELETE on this exact ARM path).
            const diagnosticTargets = [];
            for (const sa of storageList) {
                const p = parseArmId(sa.id);
                diagnosticTargets.push({
                    armId: sa.id,
                    name: sa.name,
                    rg: p.resourceGroup,
                    region: sa.location,
                    tierZero: false,
                });
            }
            for (const kv of vaultList) {
                const p = parseArmId(kv.id);
                diagnosticTargets.push({
                    armId: kv.id,
                    name: kv.name,
                    rg: p.resourceGroup,
                    region: kv.location,
                    tierZero: true,
                });
            }
            const diagFindings = yield probeDiagnosticSettings(diagnosticTargets, token, subscriptionName, sub.subscriptionId, signal);
            result.findings.push(...diagFindings);
            // --- Signal D: idle / empty resource groups ---
            if (rgList.length > 0) {
                const summaries = yield buildResourceGroupSummaries(rgList, sub.subscriptionId, token, signal);
                result.findings.push(...evaluateIdleResourceGroups(summaries, {
                    subscriptionId: sub.subscriptionId,
                    subscriptionName,
                    idleThresholdDays: opts.idleThresholdDays,
                }));
            }
            // --- Signal C: public-access containers ---
            // COORDINATOR: a ListBlobContainers ARM call
            //   GET /subscriptions/{sub}/resourceGroups/{rg}/providers/
            //       Microsoft.Storage/storageAccounts/{name}/blobServices/
            //       default/containers?api-version=2023-05-01
            // would let `evaluatePublicContainers()` from
            // security-audit-corpus-signals.ts emit findings. We deliberately
            // do NOT add that endpoint here per the per-page edit boundary
            // (it belongs in the storage service layer, not in this page).
            // When it lands, wire it like the diagnostics probe above:
            //   const containers = await fetchArmPaged<ArmContainer>(...);
            //   result.findings.push(...evaluatePublicContainers(...));
            // The portal-deep-link per container should use
            //   `${portalUrlFor(storageAccountId)}/containers`
            // (the storage-account blade has a containers sub-route).
            // --- Signal E (cross-page, wave 8): dormant-SP credential rotation ---
            // COORDINATOR: `evaluateDormantSpCredentialRotation` lives in
            // security-audit-corpus-signals.ts but the data feed (SP sign-in +
            // credential-add events from Graph) lives in role-graph /
            // privileged-audit. When that pipeline lands, those pages should
            // call evaluateDormantSpCredentialRotation() and push the
            // resulting Finding[] into THIS page's findings list (via a small
            // cross-page event or shared store slice). The rule was placed
            // in the security-audit module so all defensive rule logic stays
            // in one file — the page that COLLECTS the data drives the helper.
            // citation: New folder\_bypass_role_grant.md §addKey.
            if (partialErrors.length > 0) {
                result.error = `Insufficient permissions on: ${partialErrors.join(", ")}. Partial results shown.`;
            }
        }
        catch (err) {
            const e = err;
            if (e.status === 403 || e.status === 401) {
                result.error = `No read access (HTTP ${e.status}). Skipping.`;
            }
            else {
                result.error = (_a = e.message) !== null && _a !== void 0 ? _a : String(err);
            }
        }
        return result;
    });
}
/**
 * Fetch diagnostic settings for every target with a small worker
 * pool. Each per-resource fetch tolerates 404 (no settings) /
 * 403 (no permission) — translating to an empty list so the
 * evaluator can still emit the "diag.absent" finding for the
 * 404 case (the most important defender signal).
 */
function probeDiagnosticSettings(targets, token, subscriptionName, subscriptionId, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        const CONCURRENCY = 5;
        const findings = [];
        let i = 0;
        function worker() {
            return __awaiter(this, void 0, void 0, function* () {
                while (true) {
                    if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                        return;
                    const idx = i++;
                    if (idx >= targets.length)
                        return;
                    const t = targets[idx];
                    try {
                        const settings = yield fetchArmPaged(listDiagnosticSettingsUrl(t.armId), token, signal);
                        findings.push(...evaluateDiagnosticSettings({
                            resourceId: t.armId,
                            resourceName: t.name,
                            resourceGroup: t.rg,
                            region: t.region,
                            tierZero: t.tierZero,
                            settings,
                        }, { subscriptionId, subscriptionName }));
                    }
                    catch (err) {
                        const e = err;
                        if (e.status === 404) {
                            // 404 here actually means "no diagnostic settings exist
                            // for this resource" — which IS the finding we care about.
                            findings.push(...evaluateDiagnosticSettings({
                                resourceId: t.armId,
                                resourceName: t.name,
                                resourceGroup: t.rg,
                                region: t.region,
                                tierZero: t.tierZero,
                                settings: [],
                            }, { subscriptionId, subscriptionName }));
                        }
                        // 403 / 401 / other — silently skip this resource. We can't
                        // tell "no setting" from "no permission" so we err on the
                        // side of not crying wolf.
                    }
                }
            });
        }
        const workers = [];
        for (let w = 0; w < CONCURRENCY; w++)
            workers.push(worker());
        yield Promise.all(workers);
        return findings;
    });
}
function hasTempLifecycleTag(tags) {
    if (!tags)
        return false;
    for (const [key, val] of Object.entries(tags)) {
        const k = key.toLowerCase();
        const v = (val !== null && val !== void 0 ? val : "").toLowerCase();
        for (const hint of TEMP_TAG_HINTS) {
            if (k === hint || v === hint)
                return true;
            if (k.includes(hint) || v.includes(hint))
                return true;
        }
    }
    return false;
}
function buildResourceGroupSummaries(rgs, subscriptionId, token, signal) {
    return __awaiter(this, void 0, void 0, function* () {
        // Bounded concurrency — one in-flight RG resource-list call per
        // worker. Larger pools just hit ARM throttles.
        const CONCURRENCY = 4;
        const out = [];
        let i = 0;
        function worker() {
            var _a;
            return __awaiter(this, void 0, void 0, function* () {
                while (true) {
                    if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                        return;
                    const idx = i++;
                    if (idx >= rgs.length)
                        return;
                    const rg = rgs[idx];
                    let resources = [];
                    try {
                        resources = yield fetchArmPaged(listResourcesInGroupUrl(subscriptionId, rg.name), token, signal);
                    }
                    catch (err) {
                        const e = err;
                        if (e.status !== 403 && e.status !== 401) {
                            // Non-permission errors leave us with 0 resources for the
                            // RG — we still record the summary so the operator sees
                            // the RG exists (just without an idle calculation).
                        }
                    }
                    // Compute the freshest timestamp across changedTime/createdTime.
                    let maxTs = null;
                    let hasTempTag = hasTempLifecycleTag(rg.tags);
                    for (const r of resources) {
                        const ct = r.changedTime ? Date.parse(r.changedTime) : NaN;
                        const cr = r.createdTime ? Date.parse(r.createdTime) : NaN;
                        for (const t of [ct, cr]) {
                            if (Number.isFinite(t)) {
                                maxTs = maxTs == null ? t : Math.max(maxTs, t);
                            }
                        }
                        if (!hasTempTag && hasTempLifecycleTag(r.tags))
                            hasTempTag = true;
                    }
                    out.push({
                        id: rg.id,
                        name: rg.name,
                        location: rg.location,
                        tags: (_a = rg.tags) !== null && _a !== void 0 ? _a : {},
                        resourceCount: resources.length,
                        lastChangedIso: maxTs != null ? new Date(maxTs).toISOString() : null,
                        hasTempTag,
                    });
                }
            });
        }
        const workers = [];
        for (let w = 0; w < CONCURRENCY; w++)
            workers.push(worker());
        yield Promise.all(workers);
        return out;
    });
}
// --------------------------------------------------------------------------
// Filters / display state
// --------------------------------------------------------------------------
const ALL_SEVERITIES = ["critical", "high", "medium", "info"];
const ALL_RESOURCE_TYPES = [
    "storage",
    "keyvault",
    // Corpus signals — kept on the right so the original storage/kv
    // chips stay in the same screen position for muscle memory.
    "diagnostic-setting",
    "subscription",
    "storage-container",
    "resource-group",
];
// Findings older than this are considered "stale / unfixed". 30 days
// is the typical SLA window in MicroBurst / Prowler default policies
// (NIST 800-53 SI-2 "Flaw Remediation" timing target).
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
// Default idle-RG threshold (Signal D). 90 days matches the Azucar /
// ScoutSuite default — the corpus tools' authors picked it because
// 90 days is one full sprint quarter; an RG that hasn't changed for
// a quarter is almost certainly forgotten.
// citation: New folder\_analysis_defender_view.md §1
const IDLE_RG_DEFAULT_DAYS = 90;
const IDLE_RG_MIN_DAYS = 7;
const IDLE_RG_MAX_DAYS = 365;
function resourceTypeLabel(t) {
    switch (t) {
        case "storage":
            return "Storage Account";
        case "keyvault":
            return "Key Vault";
        case "diagnostic-setting":
            return "Diagnostic Setting";
        case "subscription":
            return "Subscription";
        case "storage-container":
            return "Storage Container";
        case "resource-group":
            return "Resource Group";
        default:
            return t;
    }
}
function resourceTypeIcon(t) {
    switch (t) {
        case "storage":
            return FileText;
        case "keyvault":
            return KeyRound;
        case "diagnostic-setting":
            return Activity;
        case "subscription":
            return CreditCard;
        case "storage-container":
            return FolderOpen;
        case "resource-group":
            return Layers;
        default:
            return FileText;
    }
}
// --------------------------------------------------------------------------
// Page component
// --------------------------------------------------------------------------
export const SecurityAuditPage = () => {
    return (React.createElement(ErrorBoundary, null,
        React.createElement(TooltipProvider, { delayDuration: 150 },
            React.createElement(SecurityAuditPageInner, null))));
};
const SecurityAuditPageInner = () => {
    var _a, _b;
    const state = useMultiRegionState();
    // Pull every subscription across every signed-in account into a
    // flat list. The picker is keyed by `subscriptionId|homeAccountId`
    // so two different operator identities that both see the same sub
    // don't collide.
    const allSubscriptions = React.useMemo(() => {
        var _a, _b;
        const out = [];
        for (const acct of (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : []) {
            if (acct.signedOut)
                continue;
            if (acct.status === "error")
                continue;
            for (const sub of (_b = acct.subscriptions) !== null && _b !== void 0 ? _b : []) {
                out.push({
                    subscriptionId: sub.subscriptionId,
                    displayName: sub.displayName,
                    tenantId: sub.tenantId,
                    homeAccountId: acct.homeAccountId,
                });
            }
        }
        // Stable order: displayName ascending so the picker doesn't
        // re-shuffle when MSAL re-emits the accounts list.
        return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }, [state.azureAccounts]);
    // Flat list of distinct accounts behind the subscriptions — used to
    // resolve which account's ARM token a given sub needs.
    const accountsById = React.useMemo(() => {
        var _a, _b;
        const map = new Map();
        for (const acct of (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : []) {
            if (acct.signedOut)
                continue;
            if (acct.status === "error")
                continue;
            map.set(acct.homeAccountId, {
                homeAccountId: acct.homeAccountId,
                tenantId: acct.tenantId,
                username: acct.username,
                name: acct.name || acct.username,
                subscriptions: ((_b = acct.subscriptions) !== null && _b !== void 0 ? _b : []).map((s) => ({
                    subscriptionId: s.subscriptionId,
                    displayName: s.displayName,
                    tenantId: s.tenantId,
                    homeAccountId: acct.homeAccountId,
                })),
            });
        }
        return map;
    }, [state.azureAccounts]);
    // Primary account for token-expiry badge. The actual ARM tokens
    // used during a scan are acquired per-subscription via
    // `getArmTokenForAccount` (see the scan effect) so multi-tenant
    // scopes work without forcing the operator to pre-pick one.
    const primaryAccount = ((_a = state.azureAccounts) !== null && _a !== void 0 ? _a : []).find((a) => !a.signedOut && a.status !== "error");
    const armTokenTracker = useArmToken(primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId, primaryAccount ? resolveActiveTenantId(primaryAccount) : undefined);
    // ----------------- Scope selection -----------------
    const [selectedSubIds, setSelectedSubIds] = React.useState(() => new Set());
    // Auto-pick the first sub when the operator has exactly one — saves
    // a click for single-sub tenants (the common dev case). We only do
    // this on the very first render where there's nothing selected so
    // we don't fight the operator's manual deselect.
    const autoPickedRef = React.useRef(false);
    React.useEffect(() => {
        if (autoPickedRef.current)
            return;
        if (allSubscriptions.length === 1 && selectedSubIds.size === 0) {
            setSelectedSubIds(new Set([allSubscriptions[0].subscriptionId]));
            autoPickedRef.current = true;
        }
    }, [allSubscriptions, selectedSubIds.size]);
    const toggleSubSelected = React.useCallback((subscriptionId) => {
        setSelectedSubIds((prev) => {
            const next = new Set(prev);
            if (next.has(subscriptionId))
                next.delete(subscriptionId);
            else
                next.add(subscriptionId);
            return next;
        });
    }, []);
    const selectAllSubs = React.useCallback(() => {
        setSelectedSubIds(new Set(allSubscriptions.map((s) => s.subscriptionId)));
    }, [allSubscriptions]);
    const clearAllSubs = React.useCallback(() => {
        setSelectedSubIds(new Set());
    }, []);
    // ----------------- Scan state -----------------
    const [scanning, setScanning] = React.useState(false);
    const [scanError, setScanError] = React.useState(null);
    const [findings, setFindings] = React.useState([]);
    const [scanCounts, setScanCounts] = React.useState({
        storage: 0,
        vaults: 0,
    });
    const [scanWarnings, setScanWarnings] = React.useState([]);
    const [lastScanAt, setLastScanAt] = React.useState(null);
    const [lastScannedScope, setLastScannedScope] = React.useState([]);
    // Abort current scan when one is already in flight and the operator
    // hits Run Audit again — last click wins.
    const abortRef = React.useRef(null);
    // Idle-RG threshold for Signal D — persisted so the operator's
    // chosen sensitivity (e.g. 30 days for a hot environment, 180 for
    // a stable one) survives reloads. Bounded to [7, 365].
    // citation: New folder\_analysis_defender_view.md §1 — Azucar /
    // ScoutSuite default is 90 days.
    const [idleThresholdDays, setIdleThresholdDays] = usePersistedState("security-audit:idle-rg-threshold-days-v1", () => IDLE_RG_DEFAULT_DAYS, {
        version: 1,
        migrate: (raw) => {
            if (typeof raw !== "number" || !Number.isFinite(raw)) {
                return IDLE_RG_DEFAULT_DAYS;
            }
            return Math.min(IDLE_RG_MAX_DAYS, Math.max(IDLE_RG_MIN_DAYS, raw));
        },
    });
    const [firstSeenAt, setFirstSeenAt] = usePersistedState("security-audit:first-seen-v1", () => ({}), { version: 1 });
    // ----------------- Posture-trend snapshots (wave 8) -----------------
    // Hoisted above `runAudit` so the scan callback can push a fresh
    // snapshot without a TDZ on the setter. Persists a small ring buffer
    // of per-scan summaries so the operator sees movement between runs
    // (sparkline + delta vs. previous). The ring is capped at
    // POSTURE_TREND_MAX (30) inside the helper.
    //
    // citation: New folder\_analysis_defender_view.md §1 — ScoutSuite
    // ships HTML reports keyed off snapshots; we mirror in-page.
    const [postureSnapshots, setPostureSnapshots] = usePersistedState("security-audit:posture-trend-v1", () => [], { version: 1 });
    const runAudit = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _c, _d, _e, _f, _g;
        if (selectedSubIds.size === 0)
            return;
        // Resolve the picked subs back to full scope entries (with the
        // owning account context).
        const targets = allSubscriptions.filter((s) => selectedSubIds.has(s.subscriptionId));
        if (targets.length === 0)
            return;
        // Cancel any prior in-flight scan.
        (_c = abortRef.current) === null || _c === void 0 ? void 0 : _c.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setScanning(true);
        setScanError(null);
        setFindings([]);
        setScanCounts({ storage: 0, vaults: 0 });
        setScanWarnings([]);
        const aggFindings = [];
        const aggCounts = { storage: 0, vaults: 0 };
        const aggWarnings = [];
        try {
            // Dynamic import of `getArmTokenForAccount` to avoid pulling
            // MSAL into the page bundle unless the operator actually runs a
            // scan (cheap defer; first-click latency is negligible).
            const { getArmTokenForAccount } = yield import("../../auth/msal-auth");
            // --- Signal B: subscription-state probe (tenant-wide) ---
            // Run ONCE per scan, using the first token we can acquire from
            // an in-scope account. ARM's /subscriptions endpoint returns the
            // full set of subs the caller can see — so the same call covers
            // every selected sub in one shot. Tier-0 flag is set based on
            // whether the operator picked the sub for scanning (i.e. they
            // care about it). citation: New folder\_AZURE_BYPASS_PLAYBOOK.md
            // §"Critical Defender Audit Surface" item 10.
            const subProbeAccount = accountsById.get(targets[0].homeAccountId);
            if (subProbeAccount) {
                try {
                    const probeToken = yield getArmTokenForAccount(subProbeAccount.homeAccountId, subProbeAccount.tenantId);
                    if (probeToken && !ctrl.signal.aborted) {
                        try {
                            const subList = yield fetchArmPaged(listSubscriptionsUrl(), probeToken, ctrl.signal);
                            const selectedIdSet = new Set(targets.map((t) => t.subscriptionId));
                            const decorated = subList.map((s) => (Object.assign(Object.assign({}, s), { isTierZero: selectedIdSet.has(s.subscriptionId) })));
                            aggFindings.push(...evaluateSubscriptionStates(decorated));
                        }
                        catch (probeErr) {
                            const e = probeErr;
                            // 403 on /subscriptions is rare (any signed-in identity
                            // can read it) — but treat gracefully as a warning row.
                            if (!ctrl.signal.aborted) {
                                aggWarnings.push({
                                    kind: "warning",
                                    id: `warn::sub-state-probe::${(_d = e.status) !== null && _d !== void 0 ? _d : "err"}`,
                                    subscriptionId: "(tenant)",
                                    subscriptionName: "Subscription-state probe (Signal B)",
                                    message: `Could not list subscriptions for cancel-state check: ${(_e = e.message) !== null && _e !== void 0 ? _e : String(e)}`,
                                });
                            }
                        }
                    }
                }
                catch (_h) {
                    // Token acquisition failure already surfaces below in the
                    // per-sub loop; no duplicate warning here.
                }
            }
            // Sequential per-sub to be a polite ARM citizen — parallelizing
            // tends to trip per-tenant rate limits when the operator has 20+
            // subs. Each sub is two parallel calls (storage + vaults)
            // internally already.
            for (const sub of targets) {
                if (ctrl.signal.aborted)
                    break;
                const acct = accountsById.get(sub.homeAccountId);
                if (!acct) {
                    aggWarnings.push({
                        kind: "warning",
                        id: `warn::${sub.subscriptionId}::no-account`,
                        subscriptionId: sub.subscriptionId,
                        subscriptionName: sub.displayName,
                        message: "Owning account is no longer signed in. Re-add it on Azure Accounts.",
                    });
                    continue;
                }
                let token = null;
                try {
                    // Pass the SUBSCRIPTION's tenant id (not the account's home
                    // tenant) so multi-tenant guests / Lighthouse-delegated subs
                    // get a token scoped to the right directory. Home-tenant
                    // tokens would 401 on a sub that lives in a guested tenant.
                    token = yield getArmTokenForAccount(acct.homeAccountId, sub.tenantId);
                }
                catch (err) {
                    aggWarnings.push({
                        kind: "warning",
                        id: `warn::${sub.subscriptionId}::token-fail`,
                        subscriptionId: sub.subscriptionId,
                        subscriptionName: sub.displayName,
                        message: `Token acquisition failed: ${err instanceof Error ? err.message : String(err)}`,
                    });
                    continue;
                }
                if (!token) {
                    aggWarnings.push({
                        kind: "warning",
                        id: `warn::${sub.subscriptionId}::token-null`,
                        subscriptionId: sub.subscriptionId,
                        subscriptionName: sub.displayName,
                        message: "No ARM token returned. Check the account is signed in and the tenant is active.",
                    });
                    continue;
                }
                const result = yield scanSubscription({ sub, token, signal: ctrl.signal }, sub.displayName, { idleThresholdDays });
                aggFindings.push(...result.findings);
                aggCounts.storage += result.storageCount;
                aggCounts.vaults += result.vaultCount;
                if (result.error) {
                    aggWarnings.push({
                        kind: "warning",
                        id: `warn::${sub.subscriptionId}::scan-error`,
                        subscriptionId: sub.subscriptionId,
                        subscriptionName: sub.displayName,
                        message: result.error,
                    });
                }
            }
            if (ctrl.signal.aborted) {
                // Operator cancelled — leave the page in pre-scan state
                // without an error banner.
                return;
            }
            aggFindings.sort(compareFindings);
            setFindings(aggFindings);
            setScanCounts(aggCounts);
            setScanWarnings(aggWarnings);
            const now = new Date().toISOString();
            setLastScanAt(now);
            setLastScannedScope(targets);
            // Maintain the "first-seen" timestamp map: stamp every brand-new
            // finding-id with `Date.now()` and prune ids that no longer appear
            // (the issue was fixed — we shouldn't keep accumulating stale
            // localStorage entries forever).
            const nowMs = Date.now();
            const presentIds = new Set(aggFindings.map((f) => f.id));
            setFirstSeenAt((prev) => {
                var _a;
                const next = {};
                // Keep entries for findings we still see, brand-new ones get `now`.
                for (const id of presentIds) {
                    next[id] = (_a = prev[id]) !== null && _a !== void 0 ? _a : nowMs;
                }
                return next;
            });
            // Audit log — success path. One entry per scan, with aggregate
            // counts so the audit-log page shows the scan dimensions
            // without us having to log per-finding spam. Corpus signal
            // counts are broken out so the defender's dashboard can chart
            // Signal A/B/C/D trends over time.
            const summary = summarizeFindings(aggFindings, aggCounts);
            let signalACount = 0;
            let signalBCount = 0;
            let signalCCount = 0;
            let signalDCount = 0;
            for (const f of aggFindings) {
                if (f.ruleId.startsWith("diag."))
                    signalACount += 1;
                else if (f.ruleId.startsWith("sub.state."))
                    signalBCount += 1;
                else if (f.ruleId.startsWith("container.public"))
                    signalCCount += 1;
                else if (f.ruleId.startsWith("rg."))
                    signalDCount += 1;
            }
            auditLog.record({
                actor: (_f = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _f !== void 0 ? _f : "(unknown)",
                action: "security_audit_scan",
                target: targets.map((t) => t.displayName).join(", "),
                status: "success",
                details: {
                    subscriptionIds: targets.map((t) => t.subscriptionId),
                    storageCount: summary.storageScanned,
                    vaultCount: summary.vaultsScanned,
                    findingsCount: summary.total,
                    criticalCount: summary.critical,
                    highCount: summary.high,
                    warnings: aggWarnings.length,
                    corpusSignals: {
                        diagAbsent: signalACount,
                        subscriptionState: signalBCount,
                        publicContainer: signalCCount,
                        idleResourceGroup: signalDCount,
                    },
                    idleThresholdDays,
                },
            });
            // Push a posture-trend snapshot (wave 8). Pure helper bumps the
            // newest entry to the head of the ring and drops the oldest once
            // POSTURE_TREND_MAX (30) entries are reached. We compute the
            // Tier-0 score from the freshly-aggregated findings rather than
            // reading the memo so we don't have to thread it through the
            // closure deps.
            const t0Score = computeTierZeroProtectionScore({
                findings: aggFindings,
                vaultsScanned: aggCounts.vaults,
            }).score;
            setPostureSnapshots((prev) => appendPostureSnapshot(prev, {
                iso: now,
                total: summary.total,
                critical: summary.critical,
                high: summary.high,
                medium: summary.medium,
                info: summary.info,
                tierZeroScore: t0Score,
                subscriptionsInScope: targets.length,
            }));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setScanError(msg);
            auditLog.record({
                actor: (_g = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _g !== void 0 ? _g : "(unknown)",
                action: "security_audit_scan",
                target: targets.map((t) => t.displayName).join(", "),
                status: "failure",
                error: msg,
                details: {
                    subscriptionIds: targets.map((t) => t.subscriptionId),
                },
            });
        }
        finally {
            setScanning(false);
            // Only clear the abort ref if it's still THIS controller
            // (another scan may have raced in and replaced it).
            if (abortRef.current === ctrl)
                abortRef.current = null;
        }
    }), [
        accountsById,
        allSubscriptions,
        primaryAccount,
        selectedSubIds,
        idleThresholdDays,
        setPostureSnapshots,
        setFirstSeenAt,
    ]);
    // Cancel any in-flight scan when the component unmounts.
    React.useEffect(() => () => {
        var _a;
        (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
    }, []);
    // ----------------- Filters (URL-synced for deep-linkable views) -----------------
    // Severity / resource-type filter sets and the search box live in the
    // URL so an operator can paste a deep-link into Slack and the same
    // filtered view loads on the other end. `criticalHighOnly` is a
    // boolean toggle ("1" = on).
    //
    // The hook treats the `initial` literal as render-stable (see
    // `useUrlState` contract) — we hoist a stable record literal up here
    // so the keys + array typing are unambiguous.
    const URL_INITIAL = React.useMemo(() => ({
        sev: ALL_SEVERITIES,
        type: ALL_RESOURCE_TYPES,
        q: "",
        crit: "",
        stale: "",
        // corpus-only chip — "1" shows only Signal-A/B/C/D findings
        // (defender-side detection signals). Off by default so the
        // existing storage/keyvault findings still surface.
        corpus: "",
        // Show-suppressed chip — "1" reveals suppressed findings.
        // Off by default so the operator's prior "this is a false
        // positive" decisions stay quiet until they ask to see them.
        sup: "",
    }), []);
    const [urlState, setUrlState] = useUrlState(URL_INITIAL);
    const activeSeverities = React.useMemo(() => {
        // `useUrlState` typings tighten array keys to `string[]`, but the URL
        // can round-trip a malformed value as a bare string. Cast through
        // `unknown` to break the static-type narrowing so the
        // `typeof raw === "string"` branch isn't reduced to `never`.
        const raw = urlState.sev;
        const arr = Array.isArray(raw)
            ? raw
            : typeof raw === "string" && raw.length > 0
                ? raw.split(",")
                : ALL_SEVERITIES;
        const valid = arr.filter((s) => ALL_SEVERITIES.includes(s));
        return new Set(valid.length > 0 ? valid : ALL_SEVERITIES);
    }, [urlState.sev]);
    const activeResourceTypes = React.useMemo(() => {
        // See `activeSeverities` above — same widening rationale (cast through
        // `unknown` to break the static-type narrowing).
        const raw = urlState.type;
        const arr = Array.isArray(raw)
            ? raw
            : typeof raw === "string" && raw.length > 0
                ? raw.split(",")
                : ALL_RESOURCE_TYPES;
        const valid = arr.filter((t) => ALL_RESOURCE_TYPES.includes(t));
        return new Set(valid.length > 0 ? valid : ALL_RESOURCE_TYPES);
    }, [urlState.type]);
    const searchText = typeof urlState.q === "string" ? urlState.q : "";
    const criticalHighOnly = (typeof urlState.crit === "string" && urlState.crit === "1") ||
        (Array.isArray(urlState.crit) && urlState.crit[0] === "1");
    const showStaleOnly = (typeof urlState.stale === "string" && urlState.stale === "1") ||
        (Array.isArray(urlState.stale) && urlState.stale[0] === "1");
    const showCorpusOnly = (typeof urlState.corpus === "string" && urlState.corpus === "1") ||
        (Array.isArray(urlState.corpus) && urlState.corpus[0] === "1");
    const showSuppressed = (typeof urlState.sup === "string" && urlState.sup === "1") ||
        (Array.isArray(urlState.sup) && urlState.sup[0] === "1");
    // Audit-log helper — fires once per *change* (not per render). We only
    // record human-driven filter mutations so the audit-log page isn't
    // flooded with the URL-restore round-trip on first mount.
    const recordFilterChange = React.useCallback((kind, value) => {
        var _a;
        auditLog.record({
            actor: (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _a !== void 0 ? _a : "(unknown)",
            action: "security_audit_filter",
            target: kind,
            status: "success",
            details: { value },
        });
    }, [primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username]);
    const toggleSeverity = React.useCallback((s) => {
        const next = new Set(activeSeverities);
        if (next.has(s))
            next.delete(s);
        else
            next.add(s);
        setUrlState({ sev: Array.from(next) });
        recordFilterChange("severity-toggle", Array.from(next));
    }, [activeSeverities, setUrlState, recordFilterChange]);
    const toggleResourceType = React.useCallback((t) => {
        const next = new Set(activeResourceTypes);
        if (next.has(t))
            next.delete(t);
        else
            next.add(t);
        setUrlState({ type: Array.from(next) });
        recordFilterChange("resource-type-toggle", Array.from(next));
    }, [activeResourceTypes, setUrlState, recordFilterChange]);
    const setSearchText = React.useCallback((q) => setUrlState({ q }), [setUrlState]);
    const setCriticalHighOnly = React.useCallback((v) => {
        setUrlState({ crit: v ? "1" : "" });
        recordFilterChange("critical-high-only", v);
    }, [setUrlState, recordFilterChange]);
    const setShowStaleOnly = React.useCallback((v) => {
        setUrlState({ stale: v ? "1" : "" });
        recordFilterChange("stale-only", v);
    }, [setUrlState, recordFilterChange]);
    const setShowCorpusOnly = React.useCallback((v) => {
        setUrlState({ corpus: v ? "1" : "" });
        recordFilterChange("corpus-only", v);
    }, [setUrlState, recordFilterChange]);
    const setShowSuppressed = React.useCallback((v) => {
        setUrlState({ sup: v ? "1" : "" });
        recordFilterChange("show-suppressed", v);
    }, [setUrlState, recordFilterChange]);
    const [ackSuppressMap, setAckSuppressMap] = usePersistedState("security-audit:ack-suppress-v1", () => ({}), { version: 1 });
    // Threshold for the "stale" chip — finding-id first observed more
    // than 30 days ago and still appears in the latest scan.
    // Re-snapshots whenever a scan completes (so "now - 30d" reflects the
    // latest scan, not the first render hours ago).
    const staleThreshold = React.useMemo(() => Date.now() - STALE_THRESHOLD_MS, [lastScanAt]);
    // Filtered findings + warnings — warnings always show (they're
    // about scan health, not finding severity).
    const filteredFindings = React.useMemo(() => {
        const q = searchText.trim().toLowerCase();
        const sevPredicate = (f) => criticalHighOnly
            ? f.severity === "critical" || f.severity === "high"
            : activeSeverities.has(f.severity);
        return findings.filter((f) => {
            var _a;
            // Suppressed findings are hidden unless the operator opted in.
            // Acknowledged findings stay visible (they're real + tracked) —
            // they only get a muted style downstream.
            if (!showSuppressed && ((_a = ackSuppressMap[f.id]) === null || _a === void 0 ? void 0 : _a.state) === "suppress") {
                return false;
            }
            if (!sevPredicate(f))
                return false;
            if (!activeResourceTypes.has(f.resourceType))
                return false;
            if (showStaleOnly) {
                const firstSeen = firstSeenAt[f.id];
                if (firstSeen == null || firstSeen > staleThreshold)
                    return false;
            }
            if (showCorpusOnly && !isCorpusFinding(f))
                return false;
            if (!q)
                return true;
            const hay = [
                f.resourceName,
                f.resourceGroup,
                f.region,
                f.subscriptionName,
                f.title,
                f.ruleId,
            ]
                .join(" ")
                .toLowerCase();
            return hay.includes(q);
        });
    }, [
        findings,
        activeSeverities,
        activeResourceTypes,
        searchText,
        criticalHighOnly,
        showStaleOnly,
        showCorpusOnly,
        showSuppressed,
        ackSuppressMap,
        firstSeenAt,
        staleThreshold,
    ]);
    const [sortColumn, setSortColumn] = React.useState("severity");
    const [sortDir, setSortDir] = React.useState("desc");
    const sortedFindings = React.useMemo(() => {
        const findOnly = filteredFindings.slice();
        const dir = sortDir === "desc" ? -1 : 1;
        findOnly.sort((a, b) => {
            if (sortColumn === "name") {
                return a.resourceName.localeCompare(b.resourceName) * dir;
            }
            if (sortColumn === "type") {
                const t = a.resourceType < b.resourceType
                    ? -1
                    : a.resourceType > b.resourceType
                        ? 1
                        : 0;
                // Stable secondary by name asc when types tie.
                return t !== 0 ? t * dir : a.resourceName.localeCompare(b.resourceName);
            }
            if (sortColumn === "rg") {
                const c = a.resourceGroup.localeCompare(b.resourceGroup) * dir;
                // Stable secondary by name asc when RGs tie.
                return c !== 0 ? c : a.resourceName.localeCompare(b.resourceName);
            }
            // severity:
            //   - primary key is `riskScoreFor` (severity weight + small
            //     bonus for corpus sentinel rules) so a critical Signal-B
            //     "subscription Warned" outranks a critical storage-public
            //     finding by 0.5 — the operator sees the imminent
            //     destructive op first;
            //   - flip primary by direction (desc shows worst-first, asc
            //     shows none-first);
            //   - tie-break by name ASC regardless of direction so
            //     within-severity rows stay alphabetically predictable.
            const riskA = riskScoreFor(a);
            const riskB = riskScoreFor(b);
            const sevDiff = (riskB - riskA) * (sortDir === "desc" ? 1 : -1);
            if (sevDiff !== 0)
                return sevDiff > 0 ? 1 : -1;
            // Stable secondary — keep the severity-weight fallback so a
            // tie on score still respects the canonical bucket order.
            const wDiff = (SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]) *
                (sortDir === "desc" ? 1 : -1);
            if (wDiff !== 0)
                return wDiff;
            return a.resourceName.localeCompare(b.resourceName);
        });
        return findOnly;
    }, [filteredFindings, sortColumn, sortDir]);
    const sortedDisplayRows = React.useMemo(() => {
        return [
            ...scanWarnings,
            ...sortedFindings.map((f) => (Object.assign({ kind: "finding" }, f))),
        ];
    }, [scanWarnings, sortedFindings]);
    // Stable id -> Finding lookup. We hand the original (stable across
    // renders until findings[] mutates) reference to FindingRow so its
    // React.memo shallow-compare actually short-circuits on chip toggles.
    const sortedFindingsById = React.useMemo(() => {
        const m = new Map();
        for (const f of sortedFindings)
            m.set(f.id, f);
        return m;
    }, [sortedFindings]);
    const onHeaderClick = React.useCallback((col) => {
        if (sortColumn === col) {
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        }
        else {
            setSortColumn(col);
            setSortDir(col === "severity" ? "desc" : "asc");
        }
    }, [sortColumn]);
    // ----------------- Summary stats -----------------
    const summary = React.useMemo(() => summarizeFindings(findings, scanCounts), [findings, scanCounts]);
    // Severity counts on ALL findings (not filtered) for the chips
    // — operators need to see the totals even when a filter hides them.
    const severityCounts = React.useMemo(() => countBySeverity(findings), [findings]);
    const resourceTypeCounts = React.useMemo(() => countByResourceType(findings), [findings]);
    // ----------------- Tier-0 Protection Score (wave 8) -----------------
    // Composite signal: of all Key Vaults scanned, how many have BOTH a
    // configured diagnostic setting AND no high/critical KV-config
    // finding? Score 0..100. Surfaced in the summary strip + tooltip
    // breakdown. citation: New folder\_analysis_defender_view.md §1.
    const tierZeroScore = React.useMemo(() => computeTierZeroProtectionScore({
        findings,
        vaultsScanned: scanCounts.vaults,
    }), [findings, scanCounts.vaults]);
    // ----------------- Suppressed / acknowledged counts -----------------
    const suppressedCount = React.useMemo(() => {
        var _a;
        let n = 0;
        for (const f of findings) {
            if (((_a = ackSuppressMap[f.id]) === null || _a === void 0 ? void 0 : _a.state) === "suppress")
                n += 1;
        }
        return n;
    }, [findings, ackSuppressMap]);
    const acknowledgedCount = React.useMemo(() => {
        var _a;
        let n = 0;
        for (const f of findings) {
            if (((_a = ackSuppressMap[f.id]) === null || _a === void 0 ? void 0 : _a.state) === "ack")
                n += 1;
        }
        return n;
    }, [findings, ackSuppressMap]);
    // Critical count for the screen-reader live region — EXCLUDES
    // acknowledged + suppressed findings so the announcement reflects
    // what the operator hasn't already triaged. citation: WAI-ARIA
    // aria-live polite — change-only announcements.
    const announcedCriticalCount = React.useMemo(() => {
        let n = 0;
        for (const f of findings) {
            if (f.severity !== "critical")
                continue;
            const dec = ackSuppressMap[f.id];
            if ((dec === null || dec === void 0 ? void 0 : dec.state) === "ack" || (dec === null || dec === void 0 ? void 0 : dec.state) === "suppress")
                continue;
            n += 1;
        }
        return n;
    }, [findings, ackSuppressMap]);
    // Posture-trend snapshot delta vs. previous run.
    const postureDelta = React.useMemo(() => computePostureTrendDelta(postureSnapshots), [postureSnapshots]);
    // ----------------- Acknowledge / suppress callbacks -----------------
    const operatorName = (_b = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _b !== void 0 ? _b : "(unknown)";
    const setAckSuppress = React.useCallback((findingId, finding, state, note = "") => {
        setAckSuppressMap((prev) => {
            const next = Object.assign({}, prev);
            if (state === "clear") {
                delete next[findingId];
            }
            else {
                next[findingId] = {
                    state,
                    at: new Date().toISOString(),
                    actor: operatorName,
                    note,
                };
            }
            return next;
        });
        auditLog.record({
            actor: operatorName,
            action: `security_audit_${state === "clear" ? "unmark" : state}`,
            target: finding.resourceName,
            status: "success",
            details: {
                findingId,
                ruleId: finding.ruleId,
                severity: finding.severity,
                resourceId: finding.resourceId,
                subscriptionId: finding.subscriptionId,
                note,
            },
        });
    }, [setAckSuppressMap, operatorName]);
    // ----------------- Focused-finding keyboard model (wave 8) -----------------
    // Tracks which finding row currently has keyboard focus so the page
    // hotkeys (`a` ack, `s` suppress) can target it. Updated when a row
    // receives focus via Tab or click. Stored as the finding `id` rather
    // than an index so it survives re-sort.
    const [focusedFindingId, setFocusedFindingId] = React.useState(null);
    // ----------------- Bulk acknowledge (visible, non-suppressed) -----------------
    const bulkAcknowledgeVisible = React.useCallback(() => {
        if (filteredFindings.length === 0)
            return;
        setAckSuppressMap((prev) => {
            var _a;
            const next = Object.assign({}, prev);
            const at = new Date().toISOString();
            for (const f of filteredFindings) {
                if (((_a = next[f.id]) === null || _a === void 0 ? void 0 : _a.state) === "suppress")
                    continue;
                next[f.id] = {
                    state: "ack",
                    at,
                    actor: operatorName,
                    note: "bulk-acknowledge",
                };
            }
            return next;
        });
        auditLog.record({
            actor: operatorName,
            action: "security_audit_bulk_acknowledge",
            target: `${filteredFindings.length} visible finding(s)`,
            status: "success",
            details: {
                findingIds: filteredFindings.map((f) => f.id),
                bucketCounts: {
                    critical: filteredFindings.filter((f) => f.severity === "critical").length,
                    high: filteredFindings.filter((f) => f.severity === "high").length,
                    medium: filteredFindings.filter((f) => f.severity === "medium").length,
                    info: filteredFindings.filter((f) => f.severity === "info").length,
                },
            },
        });
    }, [filteredFindings, setAckSuppressMap, operatorName]);
    // ----------------- Tenant-switch sync -----------------
    // When the operator switches the active tenant in the sidebar, swap
    // the picked subscription scope to the subs owned by that account.
    // Mirrors the canonical pattern from invite-user-page.tsx, adapted
    // for this page's multi-select scope. The hook stashes its callback
    // in a ref so the listener always sees the latest closure — we still
    // wrap in useCallback for narrative clarity / future stability.
    const onTenantChanged = React.useCallback((detail) => {
        const candidate = detail.homeAccountId;
        const ownedSubs = allSubscriptions.filter((s) => s.homeAccountId === candidate);
        if (ownedSubs.length === 0)
            return;
        const ownedIds = new Set(ownedSubs.map((s) => s.subscriptionId));
        // Skip if the current selection is already exactly this account's subs.
        if (selectedSubIds.size === ownedIds.size &&
            Array.from(selectedSubIds).every((id) => ownedIds.has(id))) {
            return;
        }
        setSelectedSubIds(ownedIds);
    }, [allSubscriptions, selectedSubIds]);
    useTenantChange(undefined, onTenantChanged);
    // ----------------- Export -----------------
    const exportColumns = React.useMemo(() => [
        { header: "Severity", accessor: (f) => SEVERITY_LABEL[f.severity] },
        // Risk score = severity weight + small bonus for corpus
        // sentinel rules (A/B/C). Lets exports be sorted-by-risk
        // outside the UI.
        { header: "Risk Score", accessor: (f) => riskScoreFor(f).toFixed(2) },
        {
            header: "Signal Class",
            accessor: (f) => isCorpusFinding(f) ? "corpus-defender" : "microburst-style",
        },
        { header: "Resource Type", accessor: (f) => resourceTypeLabel(f.resourceType) },
        { header: "Resource Name", accessor: (f) => f.resourceName },
        { header: "Resource Group", accessor: (f) => f.resourceGroup },
        { header: "Region", accessor: (f) => f.region },
        { header: "Subscription", accessor: (f) => f.subscriptionName },
        { header: "Subscription Id", accessor: (f) => f.subscriptionId },
        { header: "Rule Id", accessor: (f) => f.ruleId },
        { header: "Title", accessor: (f) => f.title },
        { header: "Description", accessor: (f) => f.description },
        { header: "Why It Matters", accessor: (f) => f.whyItMatters },
        { header: "Remediation", accessor: (f) => f.remediation },
        { header: "ARM Id", accessor: (f) => f.resourceId },
    ], []);
    const jsonExportMetadata = React.useMemo(() => ({
        scanTimestamp: lastScanAt,
        scopeSubscriptions: lastScannedScope.map((s) => ({
            subscriptionId: s.subscriptionId,
            displayName: s.displayName,
            tenantId: s.tenantId,
        })),
        filters: {
            severities: Array.from(activeSeverities),
            resourceTypes: Array.from(activeResourceTypes),
            searchText: searchText.trim(),
            criticalHighOnly,
            showStaleOnly,
            showCorpusOnly,
            showSuppressed,
            staleThresholdDays: 30,
            idleResourceGroupThresholdDays: idleThresholdDays,
        },
        scanned: scanCounts,
        summary,
        // Tier-0 protection score (wave 8) so JSON exports carry the
        // composite signal alongside the per-finding rows.
        tierZeroProtection: {
            score: tierZeroScore.score,
            protectedCount: tierZeroScore.protectedCount,
            totalCount: tierZeroScore.totalCount,
            topOffenders: tierZeroScore.topOffenders,
        },
        ackSuppressCounts: {
            acknowledged: acknowledgedCount,
            suppressed: suppressedCount,
        },
    }), [
        lastScanAt,
        lastScannedScope,
        activeSeverities,
        activeResourceTypes,
        searchText,
        criticalHighOnly,
        showStaleOnly,
        showCorpusOnly,
        showSuppressed,
        idleThresholdDays,
        scanCounts,
        summary,
        tierZeroScore,
        acknowledgedCount,
        suppressedCount,
    ]);
    // ----------------- Render -----------------
    const titleId = React.useId();
    const searchId = React.useId();
    const critOnlyId = React.useId();
    const staleOnlyId = React.useId();
    const corpusOnlyId = React.useId();
    const showSuppressedId = React.useId();
    const idleThresholdId = React.useId();
    // Count of findings older than 30 days (for the chip badge) — pulled
    // from the unfiltered list so the number reflects reality even when
    // the chip itself is hiding rows.
    const staleCount = React.useMemo(() => {
        let n = 0;
        for (const f of findings) {
            const t = firstSeenAt[f.id];
            if (t != null && t <= staleThreshold)
                n += 1;
        }
        return n;
    }, [findings, firstSeenAt, staleThreshold]);
    // Count of corpus-derived findings — surfaces in the chip badge so
    // the operator can tell at a glance how much of the total comes from
    // the four defender signals (A: diag, B: sub-state, C: container,
    // D: idle-RG). Pulled from the unfiltered list for the same reason
    // as staleCount above.
    const corpusFindingCount = React.useMemo(() => {
        let n = 0;
        for (const f of findings)
            if (isCorpusFinding(f))
                n += 1;
        return n;
    }, [findings]);
    const clearFilters = React.useCallback(() => {
        setUrlState({
            sev: ALL_SEVERITIES,
            type: ALL_RESOURCE_TYPES,
            q: "",
            crit: "",
            stale: "",
            corpus: "",
            sup: "",
        });
        recordFilterChange("clear-filters", null);
    }, [setUrlState, recordFilterChange]);
    // ----------------- Export-critical-only (wave 8 hotkey `e`) -----------------
    // The ExportMenu uses `filteredFindings`. For the hotkey we hand-roll
    // a CSV blob of CRITICAL-only findings (regardless of current
    // filters) so the operator can ship a fast triage list. Tabs are CSV
    // separators so we don't have to quote commas inside the
    // remediation/whyItMatters text.
    const exportCriticalOnly = React.useCallback(() => {
        const crits = findings.filter((f) => f.severity === "critical");
        if (crits.length === 0) {
            auditLog.record({
                actor: operatorName,
                action: "security_audit_export_critical_only",
                target: "no-critical-findings",
                status: "success",
                details: { count: 0 },
            });
            return;
        }
        const headers = [
            "severity",
            "ruleId",
            "resourceType",
            "resourceName",
            "resourceGroup",
            "region",
            "subscriptionName",
            "title",
            "description",
            "armId",
        ];
        const escape = (v) => `"${v.replace(/"/g, '""').replace(/\n/g, " ")}"`;
        const lines = [headers.join(",")];
        for (const f of crits) {
            lines.push([
                escape(SEVERITY_LABEL[f.severity]),
                escape(f.ruleId),
                escape(resourceTypeLabel(f.resourceType)),
                escape(f.resourceName),
                escape(f.resourceGroup),
                escape(f.region),
                escape(f.subscriptionName),
                escape(f.title),
                escape(f.description),
                escape(f.resourceId),
            ].join(","));
        }
        const csv = lines.join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        a.href = url;
        a.download = `security-audit-critical-${ts}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        auditLog.record({
            actor: operatorName,
            action: "security_audit_export_critical_only",
            target: `${crits.length} critical finding(s)`,
            status: "success",
            details: { count: crits.length },
        });
    }, [findings, operatorName]);
    // ----------------- Hotkeys (wave 8) -----------------
    // `a` — acknowledge focused finding (or first visible critical when
    //       nothing's focused).
    // `s` — suppress focused finding (same fallback).
    // `e` — export critical-only.
    // All three respect input focus (the hook's default).
    const focusedFinding = React.useMemo(() => {
        var _a;
        if (!focusedFindingId)
            return null;
        return (_a = sortedFindings.find((f) => f.id === focusedFindingId)) !== null && _a !== void 0 ? _a : null;
    }, [focusedFindingId, sortedFindings]);
    useShortcut("a", () => {
        var _a;
        const target = (_a = focusedFinding !== null && focusedFinding !== void 0 ? focusedFinding : sortedFindings.find((f) => f.severity === "critical")) !== null && _a !== void 0 ? _a : sortedFindings[0];
        if (!target)
            return;
        const dec = ackSuppressMap[target.id];
        // Toggle: ack again clears.
        setAckSuppress(target.id, target, (dec === null || dec === void 0 ? void 0 : dec.state) === "ack" ? "clear" : "ack");
    });
    useShortcut("s", () => {
        var _a;
        const target = (_a = focusedFinding !== null && focusedFinding !== void 0 ? focusedFinding : sortedFindings.find((f) => f.severity === "critical")) !== null && _a !== void 0 ? _a : sortedFindings[0];
        if (!target)
            return;
        const dec = ackSuppressMap[target.id];
        setAckSuppress(target.id, target, (dec === null || dec === void 0 ? void 0 : dec.state) === "suppress" ? "clear" : "suppress");
    });
    useShortcut("e", () => {
        exportCriticalOnly();
    });
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4", role: "region", "aria-labelledby": titleId },
        React.createElement(PageHeader, { title: "Storage & Key Vault Security Audit", description: "Scan your subscriptions' storage accounts and key vaults for misconfigurations attackers would notice first. Read-only \u2014 every ARM call is a GET.", titleId: titleId },
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth({
                    loginHint: primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username,
                }) }),
            React.createElement(Button, { variant: "default", onClick: () => void runAudit(), loading: scanning, disabled: selectedSubIds.size === 0 || scanning, "aria-label": "Run security audit scan against selected subscriptions" },
                React.createElement(ShieldCheck, null),
                scanning ? "Scanning…" : "Run Audit"),
            React.createElement(ExportMenu, { rows: filteredFindings, columns: exportColumns, filename: "security-audit", label: "Export", jsonMetadata: jsonExportMetadata })),
        React.createElement("div", { className: "rounded-xl border bg-card/50 p-4" },
            React.createElement("div", { className: "mb-2 flex flex-wrap items-center justify-between gap-2" },
                React.createElement("div", { className: "flex items-center gap-2" },
                    React.createElement("h2", { className: "m-0 text-sm font-semibold" }, "Subscription scope"),
                    React.createElement(InfoTooltip, { content: "Pick one or more subscriptions you have read access to. Each picked sub is scanned for storage accounts and key vaults via two ARM list calls (paginated). No POST/PATCH/DELETE \u2014 read-only.", size: 13 }),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        selectedSubIds.size,
                        " of ",
                        allSubscriptions.length,
                        " selected")),
                React.createElement("div", { className: "flex items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: selectAllSubs, disabled: allSubscriptions.length === 0 }, "Select all"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: clearAllSubs, disabled: selectedSubIds.size === 0 }, "Clear"))),
            allSubscriptions.length === 0 ? (React.createElement("p", { className: "m-0 text-xs text-muted-foreground" }, "No subscriptions discovered. Sign in on the Azure Accounts page first.")) : (React.createElement("ul", { className: "grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3" }, allSubscriptions.map((sub) => {
                var _a, _b;
                const checked = selectedSubIds.has(sub.subscriptionId);
                const ownerLabel = (_b = (_a = accountsById.get(sub.homeAccountId)) === null || _a === void 0 ? void 0 : _a.username) !== null && _b !== void 0 ? _b : "";
                return (React.createElement("li", { key: `${sub.subscriptionId}|${sub.homeAccountId}`, className: cn("flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs transition-colors", checked
                        ? "border-primary/60 bg-primary/5"
                        : "hover:bg-accent/30") },
                    React.createElement(Checkbox, { checked: checked, onCheckedChange: () => toggleSubSelected(sub.subscriptionId), "aria-label": `Select subscription ${sub.displayName}` }),
                    React.createElement("span", { className: "flex min-w-0 flex-1 flex-col" },
                        React.createElement("span", { className: "truncate font-medium", title: sub.displayName }, sub.displayName),
                        React.createElement("span", { className: "truncate font-mono text-3xs text-muted-foreground", title: `${sub.subscriptionId} • ${ownerLabel}` },
                            sub.subscriptionId.slice(0, 8),
                            " \u2022 ",
                            ownerLabel))));
            })))),
        scanError && (React.createElement("div", { role: "alert", className: "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive" },
            React.createElement(ShieldAlert, { className: "mt-0.5 h-4 w-4 shrink-0", "aria-hidden": true }),
            React.createElement("span", null,
                "Scan failed: ",
                scanError,
                ". Re-check your ARM token and retry."))),
        React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, lastScanAt
            ? announcedCriticalCount === 0
                ? "No critical findings outstanding."
                : `${announcedCriticalCount} critical finding${announcedCriticalCount === 1 ? "" : "s"} outstanding.`
            : ""),
        React.createElement("div", { className: "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7", role: "status", "aria-live": "polite" },
            React.createElement(SummaryStatItem, { label: "Total findings", value: summary.total, tone: summary.total > 0 ? "info" : "muted", hint: lastScanAt
                    ? `scanned ${new Date(lastScanAt).toLocaleString()}${postureDelta && postureDelta.totalDelta !== 0
                        ? ` (Δ${postureDelta.totalDelta > 0 ? "+" : ""}${postureDelta.totalDelta} vs. prior)`
                        : ""}`
                    : "not scanned yet" }),
            React.createElement(SummaryStatItem, { label: "Critical", value: summary.critical, tone: summary.critical > 0 ? "destructive" : "muted", hint: acknowledgedCount + suppressedCount > 0
                    ? `${acknowledgedCount} ack · ${suppressedCount} suppressed`
                    : undefined }),
            React.createElement(SummaryStatItem, { label: "High", value: summary.high, tone: summary.high > 0 ? "warning" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Medium", value: summary.medium, tone: summary.medium > 0 ? "info" : "muted" }),
            React.createElement(SummaryStatItem, { label: "Storage scanned", value: summary.storageScanned, tone: "muted", hint: resourceTypeCounts.storage > 0
                    ? `${resourceTypeCounts.storage} finding${resourceTypeCounts.storage === 1 ? "" : "s"}`
                    : "no findings" }),
            React.createElement(SummaryStatItem, { label: "Key Vaults scanned", value: summary.vaultsScanned, tone: "muted", hint: resourceTypeCounts.keyvault > 0
                    ? `${resourceTypeCounts.keyvault} finding${resourceTypeCounts.keyvault === 1 ? "" : "s"}`
                    : "no findings" }),
            React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement("div", { className: "cursor-help" },
                        React.createElement(SummaryStatItem, { label: "Tier-0 Score", value: tierZeroScore.totalCount > 0
                                ? `${tierZeroScore.score}%`
                                : "—", tone: tierZeroScore.totalCount === 0
                                ? "muted"
                                : tierZeroScore.score >= 80
                                    ? "success"
                                    : tierZeroScore.score >= 50
                                        ? "warning"
                                        : "destructive", hint: tierZeroScore.totalCount > 0
                                ? `${tierZeroScore.protectedCount}/${tierZeroScore.totalCount} vaults clean${postureDelta && postureDelta.tierZeroDelta !== 0
                                    ? ` (Δ${postureDelta.tierZeroDelta > 0 ? "+" : ""}${postureDelta.tierZeroDelta}pt)`
                                    : ""}`
                                : "no vaults scanned" }))),
                React.createElement(TooltipContent, { side: "bottom", align: "end", className: "max-w-md" },
                    React.createElement("p", { className: "m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Tier-0 protection score"),
                    React.createElement("p", { className: "m-0 mt-1 text-xs leading-relaxed" }, "% of Key Vaults with NO purge/soft-delete/network gap AND an active diagnostic setting forwarding audit logs. Treats Key Vault as the canonical Tier-0 surface (bearer credential custody). Score < 50% means the majority of vaults have at least one disqualifying finding."),
                    tierZeroScore.topOffenders.length > 0 && (React.createElement("div", { className: "mt-2 border-t pt-2" },
                        React.createElement("p", { className: "m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Top offenders"),
                        React.createElement("ul", { className: "m-0 mt-1 list-none space-y-0.5 p-0 text-2xs" }, tierZeroScore.topOffenders.map((o) => (React.createElement("li", { key: o.ruleId, className: "font-mono" },
                            o.ruleId,
                            " ",
                            React.createElement("span", { className: "text-muted-foreground" },
                                "\u00D7",
                                o.count)))))))))),
        postureSnapshots.length >= 2 && (React.createElement(PostureTrendSparkline, { snapshots: postureSnapshots, delta: postureDelta })),
        React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2" },
            React.createElement(FilterIcon, { className: "h-4 w-4 text-muted-foreground", "aria-hidden": true }),
            React.createElement("div", { className: "flex flex-wrap items-center gap-1" }, ALL_SEVERITIES.map((s) => {
                var _a;
                const active = activeSeverities.has(s);
                const count = (_a = severityCounts[s]) !== null && _a !== void 0 ? _a : 0;
                return (React.createElement("button", { key: s, type: "button", onClick: () => toggleSeverity(s), disabled: criticalHighOnly, "aria-pressed": active, className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors", active
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-accent/30", criticalHighOnly && "opacity-50") },
                    React.createElement(SeverityDot, { severity: s }),
                    SEVERITY_LABEL[s],
                    React.createElement("span", { className: "tabular-nums" }, count)));
            })),
            React.createElement("span", { className: "h-4 w-px bg-border", "aria-hidden": true }),
            React.createElement("div", { className: "flex flex-wrap items-center gap-1" }, ALL_RESOURCE_TYPES.map((t) => {
                var _a;
                const active = activeResourceTypes.has(t);
                const count = (_a = resourceTypeCounts[t]) !== null && _a !== void 0 ? _a : 0;
                const Icon = resourceTypeIcon(t);
                return (React.createElement("button", { key: t, type: "button", onClick: () => toggleResourceType(t), "aria-pressed": active, className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors", active
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-accent/30") },
                    React.createElement(Icon, { className: "h-3 w-3" }),
                    resourceTypeLabel(t),
                    React.createElement("span", { className: "tabular-nums" }, count)));
            })),
            React.createElement("span", { className: "h-4 w-px bg-border", "aria-hidden": true }),
            React.createElement("div", { className: "relative max-w-xs flex-1" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { id: searchId, type: "search", placeholder: "Search name / RG / region\u2026", value: searchText, onChange: (e) => setSearchText(e.target.value), className: "h-7 pl-7 text-xs", "aria-label": "Search findings" })),
            React.createElement("div", { className: "flex items-center gap-1.5" },
                React.createElement(Switch, { id: critOnlyId, checked: criticalHighOnly, onCheckedChange: (v) => setCriticalHighOnly(Boolean(v)), "aria-label": "Show only critical and high severity findings" }),
                React.createElement(Label, { htmlFor: critOnlyId, className: "cursor-pointer text-2xs" }, "Critical + High only")),
            React.createElement("span", { className: "h-4 w-px bg-border", "aria-hidden": true }),
            React.createElement("div", { className: "flex items-center gap-1.5" },
                React.createElement(Switch, { id: staleOnlyId, checked: showStaleOnly, onCheckedChange: (v) => setShowStaleOnly(Boolean(v)), "aria-label": "Show only findings older than 30 days" }),
                React.createElement(Label, { htmlFor: staleOnlyId, className: "inline-flex cursor-pointer items-center gap-1 text-2xs", title: "Findings first observed more than 30 days ago and still present in the latest scan" },
                    React.createElement(Clock, { className: "h-3 w-3", "aria-hidden": true }),
                    "Unfixed > 30 days",
                    React.createElement("span", { className: "tabular-nums text-muted-foreground", "aria-label": `${staleCount} stale finding${staleCount === 1 ? "" : "s"}` },
                        "(",
                        staleCount,
                        ")"))),
            React.createElement("span", { className: "h-4 w-px bg-border", "aria-hidden": true }),
            React.createElement("div", { className: "flex items-center gap-1.5" },
                React.createElement(Switch, { id: corpusOnlyId, checked: showCorpusOnly, onCheckedChange: (v) => setShowCorpusOnly(Boolean(v)), "aria-label": "Show only corpus-derived defender signals (diag / sub-state / public-container / idle-RG)" }),
                React.createElement(Label, { htmlFor: corpusOnlyId, className: "inline-flex cursor-pointer items-center gap-1 text-2xs", title: "Restrict to corpus-derived signals: diagnostic-setting absence, subscription cancellation states, public storage containers, and idle resource groups." },
                    React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }),
                    "Corpus signals only",
                    React.createElement("span", { className: "tabular-nums text-muted-foreground", "aria-label": `${corpusFindingCount} corpus finding${corpusFindingCount === 1 ? "" : "s"}` },
                        "(",
                        corpusFindingCount,
                        ")"))),
            React.createElement("span", { className: "h-4 w-px bg-border", "aria-hidden": true }),
            React.createElement("div", { className: "flex items-center gap-1.5" },
                React.createElement(Label, { htmlFor: idleThresholdId, className: "inline-flex cursor-pointer items-center gap-1 text-2xs", title: "Resource groups with no resource changes in this many days are flagged as idle (Signal D)." },
                    React.createElement(Layers, { className: "h-3 w-3", "aria-hidden": true }),
                    "Idle RG threshold"),
                React.createElement(Input, { id: idleThresholdId, type: "number", inputMode: "numeric", min: IDLE_RG_MIN_DAYS, max: IDLE_RG_MAX_DAYS, step: 1, value: idleThresholdDays, onChange: (e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) {
                            const clamped = Math.min(IDLE_RG_MAX_DAYS, Math.max(IDLE_RG_MIN_DAYS, n));
                            setIdleThresholdDays(clamped);
                        }
                    }, className: "h-7 w-16 text-2xs tabular-nums", "aria-label": "Idle resource-group threshold in days" }),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, "days")),
            React.createElement("span", { className: "h-4 w-px bg-border", "aria-hidden": true }),
            React.createElement("div", { className: "flex items-center gap-1.5" },
                React.createElement(Switch, { id: showSuppressedId, checked: showSuppressed, onCheckedChange: (v) => setShowSuppressed(Boolean(v)), "aria-label": "Show suppressed findings" }),
                React.createElement(Label, { htmlFor: showSuppressedId, className: "inline-flex cursor-pointer items-center gap-1 text-2xs", title: "Findings the operator has previously suppressed as false positives are hidden by default. Toggle this to bring them back." },
                    React.createElement(EyeOff, { className: "h-3 w-3", "aria-hidden": true }),
                    "Show suppressed",
                    React.createElement("span", { className: "tabular-nums text-muted-foreground", "aria-label": `${suppressedCount} suppressed finding${suppressedCount === 1 ? "" : "s"}` },
                        "(",
                        suppressedCount,
                        ")"))),
            filteredFindings.length > 0 && (React.createElement(Tooltip, null,
                React.createElement(TooltipTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: bulkAcknowledgeVisible, "aria-label": `Acknowledge ${filteredFindings.length} visible findings` },
                        React.createElement(ShieldCheck, { className: "h-3 w-3" }),
                        "Ack visible",
                        React.createElement("span", { className: "tabular-nums text-muted-foreground" },
                            "(",
                            filteredFindings.length,
                            ")"))),
                React.createElement(TooltipContent, { side: "bottom", align: "end", className: "max-w-xs" }, "Bulk-mark every visible finding as acknowledged (real but expected). Recorded in the audit log with your operator name. Suppressed rows are skipped."))),
            (activeSeverities.size < ALL_SEVERITIES.length ||
                activeResourceTypes.size < ALL_RESOURCE_TYPES.length ||
                searchText.trim() ||
                criticalHighOnly ||
                showStaleOnly ||
                showCorpusOnly ||
                showSuppressed) && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearFilters, "aria-label": "Clear filters" },
                React.createElement(X, { className: "h-3 w-3" }),
                "Clear filters"))),
        React.createElement("p", { className: "m-0 text-3xs text-muted-foreground", "aria-live": "off" },
            "Hotkeys: ",
            React.createElement("kbd", { className: "rounded border px-1 font-mono" }, "a"),
            " acknowledge \u00B7",
            " ",
            React.createElement("kbd", { className: "rounded border px-1 font-mono" }, "s"),
            " suppress \u00B7",
            " ",
            React.createElement("kbd", { className: "rounded border px-1 font-mono" }, "e"),
            " export critical-only. Focus a row by tabbing into the table."),
        sortedDisplayRows.length === 0 ? (scanning ? (React.createElement("div", { className: "flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-4 py-12 text-xs text-muted-foreground" },
            React.createElement(Loader2, { className: "h-4 w-4 animate-spin", "aria-hidden": true }),
            "Scanning ",
            selectedSubIds.size,
            " subscription",
            selectedSubIds.size === 1 ? "" : "s",
            "\u2026")) : findings.length === 0 && lastScanAt ? (React.createElement(EmptyState, { icon: CheckCircle2, title: "No findings", description: "Every storage account and key vault in the scope passed the audit. Re-scan after you make changes to confirm." })) : (React.createElement(EmptyState, { icon: ShieldCheck, title: selectedSubIds.size === 0
                ? "Pick a subscription"
                : "Ready to scan", description: selectedSubIds.size === 0
                ? "Select one or more subscriptions above, then click Run Audit."
                : "Click Run Audit to scan the selected subscriptions for storage and key-vault misconfigurations.", action: selectedSubIds.size > 0
                ? {
                    label: "Run Audit",
                    onClick: () => void runAudit(),
                    icon: RefreshCw,
                    loading: scanning,
                }
                : undefined }))) : (React.createElement("div", { className: "overflow-auto rounded-md border border-border bg-card" },
            React.createElement(Table, null,
                React.createElement(TableHeader, { className: "sticky top-0 z-10 bg-card" },
                    React.createElement(TableRow, null,
                        React.createElement(SortableHeader, { label: "Severity", active: sortColumn === "severity", dir: sortDir, onClick: () => onHeaderClick("severity") }),
                        React.createElement(SortableHeader, { label: "Type", active: sortColumn === "type", dir: sortDir, onClick: () => onHeaderClick("type") }),
                        React.createElement(SortableHeader, { label: "Resource", active: sortColumn === "name", dir: sortDir, onClick: () => onHeaderClick("name") }),
                        React.createElement(SortableHeader, { label: "Resource Group", active: sortColumn === "rg", dir: sortDir, onClick: () => onHeaderClick("rg") }),
                        React.createElement(TableHead, null, "Region"),
                        React.createElement(TableHead, null, "Finding"),
                        React.createElement(TableHead, { className: "text-right" }, "Actions"))),
                React.createElement(TableBody, null, sortedDisplayRows.map((row) => {
                    var _a;
                    if (row.kind === "warning") {
                        return (React.createElement(TableRow, { key: row.id, className: "bg-warning/5" },
                            React.createElement(TableCell, { colSpan: 7, className: "text-xs" },
                                React.createElement("div", { className: "flex items-start gap-2" },
                                    React.createElement(AlertTriangle, { className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-warning", "aria-hidden": true }),
                                    React.createElement("span", { className: "flex min-w-0 flex-1 flex-col" },
                                        React.createElement("span", { className: "font-medium text-warning" }, row.subscriptionName),
                                        React.createElement("span", { className: "text-muted-foreground" }, row.message))))));
                    }
                    const entry = ackSuppressMap[row.id];
                    // Look the original finding back up from the stable
                    // id->Finding map so we hand the memoized child the
                    // STABLE Finding reference (the `row` here is a freshly-
                    // spread {kind, ...f} object created in
                    // `sortedDisplayRows` and would defeat React.memo).
                    const original = sortedFindingsById.get(row.id);
                    if (!original)
                        return null;
                    return (React.createElement(FindingRow, { key: row.id, finding: original, decision: (_a = entry === null || entry === void 0 ? void 0 : entry.state) !== null && _a !== void 0 ? _a : null, decisionAt: entry === null || entry === void 0 ? void 0 : entry.at, decisionActor: entry === null || entry === void 0 ? void 0 : entry.actor, focused: focusedFindingId === row.id, setFocused: setFocusedFindingId, setAckSuppress: setAckSuppress }));
                })))))));
};
// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------
const SortableHeader = ({ label, active, dir, onClick }) => (React.createElement(TableHead, { "aria-sort": active ? (dir === "asc" ? "ascending" : "descending") : "none" },
    React.createElement("button", { type: "button", onClick: onClick, className: "-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted/40 hover:text-foreground", "aria-label": active
            ? `Sorted by ${label} ${dir === "asc" ? "ascending" : "descending"}, click to flip direction`
            : `Sort by ${label}` },
        React.createElement("span", null, label),
        active && (React.createElement("span", { className: "text-2xs text-muted-foreground", "aria-hidden": true }, dir === "desc" ? "▼" : "▲")))));
const PostureTrendSparkline = ({ snapshots, delta, }) => {
    // Order chronologically (oldest → newest) for the sparkline path. The
    // persisted ring is newest-first.
    const ordered = React.useMemo(() => snapshots.slice().reverse(), [snapshots]);
    const totals = ordered.map((s) => s.total);
    const scores = ordered.map((s) => s.tierZeroScore);
    if (totals.length < 2)
        return null;
    const W = 240;
    const H = 48;
    const PAD_X = 4;
    const PAD_Y = 4;
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_Y * 2;
    const buildPath = (values, min, max) => {
        if (values.length === 0)
            return "";
        const range = max - min || 1;
        const stepX = values.length === 1 ? innerW : innerW / (values.length - 1);
        return values
            .map((v, i) => {
            const x = PAD_X + i * stepX;
            const y = PAD_Y + innerH - ((v - min) / range) * innerH;
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
            .join(" ");
    };
    const totalMin = Math.min(...totals);
    const totalMax = Math.max(...totals);
    const scoreMin = Math.min(0, ...scores);
    const scoreMax = Math.max(100, ...scores);
    const totalsPath = buildPath(totals, totalMin, totalMax);
    const scoresPath = buildPath(scores, scoreMin, scoreMax);
    const deltaArrow = delta == null
        ? null
        : delta.totalDelta === 0
            ? null
            : delta.totalDelta > 0
                ? "up"
                : "down";
    // "up" on TOTAL = more findings = worse; "up" on TIER-0 SCORE = better.
    // Render delta line for tier-zero score separately so semantics are clear.
    return (React.createElement("div", { className: "flex flex-wrap items-center gap-3 rounded-md border border-border bg-card/60 px-3 py-2 text-2xs text-muted-foreground", role: "img", "aria-label": `Posture trend across ${snapshots.length} scans` },
        React.createElement("span", { className: "font-medium uppercase tracking-wider" }, "Posture trend"),
        React.createElement("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, className: "text-foreground", "aria-hidden": true },
            React.createElement("path", { d: totalsPath, fill: "none", stroke: "hsl(var(--destructive, 0 80% 60%))", strokeWidth: 1.5, strokeLinecap: "round" }),
            React.createElement("path", { d: scoresPath, fill: "none", stroke: "hsl(var(--success, 142 70% 45%))", strokeWidth: 1.5, strokeLinecap: "round", strokeDasharray: "3 2" })),
        React.createElement("span", { className: "inline-flex items-center gap-1" },
            React.createElement("span", { className: "inline-block h-1.5 w-3 rounded-sm", style: { backgroundColor: "hsl(var(--destructive, 0 80% 60%))" }, "aria-hidden": true }),
            "total",
            deltaArrow === "up" ? (React.createElement(TrendingUp, { className: "h-3 w-3 text-destructive", "aria-hidden": true })) : deltaArrow === "down" ? (React.createElement(TrendingDown, { className: "h-3 w-3 text-success", "aria-hidden": true })) : null,
            delta && delta.totalDelta !== 0 && (React.createElement("span", { className: "tabular-nums" },
                delta.totalDelta > 0 ? "+" : "",
                delta.totalDelta))),
        React.createElement("span", { className: "inline-flex items-center gap-1" },
            React.createElement("span", { className: "inline-block h-1.5 w-3 rounded-sm", style: { backgroundColor: "hsl(var(--success, 142 70% 45%))" }, "aria-hidden": true }),
            "Tier-0",
            delta && delta.tierZeroDelta !== 0 && (React.createElement("span", { className: "tabular-nums" },
                delta.tierZeroDelta > 0 ? "+" : "",
                delta.tierZeroDelta,
                "pt"))),
        React.createElement("span", { className: "text-3xs text-muted-foreground" },
            snapshots.length,
            "/",
            30,
            " snapshots")));
};
const SeverityDot = ({ severity }) => {
    const color = severity === "critical"
        ? "bg-destructive"
        : severity === "high"
            ? "bg-warning"
            : severity === "medium"
                ? "bg-info"
                : severity === "info"
                    ? "bg-muted-foreground"
                    : "bg-muted";
    return (React.createElement("span", { className: cn("inline-block h-1.5 w-1.5 rounded-full", color), "aria-hidden": true }));
};
/**
 * Single finding row. Memoized to avoid re-rendering all rows when a
 * single chip / filter / sort toggle changes upstream — with O(100s)
 * of findings in a large tenant this is a real win on every filter
 * tweak. Props are passed individually rather than as a config object,
 * and the parent passes the STABLE `setAckSuppress` + `setFocused`
 * callbacks (not per-row inline arrows) so React's shallow-compare
 * equality short-circuits cleanly.
 */
const FindingRowImpl = ({ finding: f, decision, decisionAt, decisionActor, focused, setFocused, setAckSuppress, }) => {
    // Build per-row handlers inside the memoized child — they re-create
    // only when `f` (specifically its id) or the stable parent setters
    // change, NOT on every parent render.
    const onFocus = React.useCallback(() => setFocused(f.id), [setFocused, f.id]);
    const onAcknowledge = React.useCallback(() => {
        setAckSuppress(f.id, f, decision === "ack" ? "clear" : "ack");
    }, [setAckSuppress, f, decision]);
    const onSuppress = React.useCallback(() => {
        setAckSuppress(f.id, f, decision === "suppress" ? "clear" : "suppress");
    }, [setAckSuppress, f, decision]);
    const Icon = resourceTypeIcon(f.resourceType);
    const parsed = parseArmId(f.resourceId);
    const portalUrl = portalUrlFor(f.resourceId);
    const runbook = runbookFor(f.ruleId);
    const isAck = decision === "ack";
    const isSuppress = decision === "suppress";
    // Local row click/focus handler — bubbles up the focused id so
    // page-level hotkeys can target it.
    return (React.createElement(TableRow, { tabIndex: 0, onFocus: onFocus, "aria-selected": focused ? true : undefined, "data-finding-id": f.id, className: cn("outline-none transition-colors", focused && "ring-1 ring-inset ring-primary/60", isAck && "bg-muted/30 opacity-75", isSuppress && "bg-muted/40 italic opacity-60") },
        React.createElement(TableCell, null,
            React.createElement(Badge, { variant: SEVERITY_BADGE_VARIANT[f.severity], className: "text-2xs" }, SEVERITY_LABEL[f.severity]),
            decision && (React.createElement("span", { className: "ml-1 inline-flex items-center gap-0.5 rounded border px-1 py-0 text-3xs uppercase tracking-wider text-muted-foreground", title: decisionActor && decisionAt
                    ? `${decision === "ack" ? "Acknowledged" : "Suppressed"} by ${decisionActor} at ${new Date(decisionAt).toLocaleString()}`
                    : undefined }, isAck ? "ack" : "supp"))),
        React.createElement(TableCell, null,
            React.createElement("span", { className: "inline-flex items-center gap-1.5 text-xs text-muted-foreground", title: resourceTypeLabel(f.resourceType) },
                React.createElement(Icon, { className: "h-3.5 w-3.5" }),
                resourceTypeLabel(f.resourceType))),
        React.createElement(TableCell, null,
            React.createElement("span", { className: "flex min-w-0 flex-col" },
                React.createElement("span", { className: "truncate font-medium", title: f.resourceName }, f.resourceName),
                React.createElement("span", { className: "truncate font-mono text-3xs text-muted-foreground", title: f.subscriptionName }, f.subscriptionName))),
        React.createElement(TableCell, null,
            React.createElement("span", { className: "font-mono text-2xs", title: f.resourceGroup }, f.resourceGroup || parsed.resourceGroup || "—")),
        React.createElement(TableCell, null,
            React.createElement(Badge, { variant: "outline", className: "text-2xs" }, f.region)),
        React.createElement(TableCell, null,
            React.createElement("div", { className: "flex min-w-0 flex-col gap-0.5" },
                React.createElement("span", { className: "flex items-center gap-1.5 text-xs font-medium" },
                    f.title,
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("button", { type: "button", className: "text-muted-foreground/70 hover:text-foreground", "aria-label": "Why this matters", tabIndex: -1 },
                                React.createElement(ShieldAlert, { className: "h-3 w-3", "aria-hidden": true }))),
                        React.createElement(TooltipContent, { side: "top", align: "start", className: "max-w-md" },
                            React.createElement("p", { className: "m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Why it matters"),
                            React.createElement("p", { className: "m-0 mt-1 text-xs leading-relaxed" }, f.whyItMatters))),
                    React.createElement(Tooltip, null,
                        React.createElement(TooltipTrigger, { asChild: true },
                            React.createElement("button", { type: "button", className: "text-muted-foreground/70 hover:text-foreground", "aria-label": "Remediation steps", tabIndex: -1 },
                                React.createElement(ShieldCheck, { className: "h-3 w-3", "aria-hidden": true }))),
                        React.createElement(TooltipContent, { side: "top", align: "start", className: "max-w-md" },
                            React.createElement("p", { className: "m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Remediation"),
                            React.createElement("p", { className: "m-0 mt-1 whitespace-pre-wrap text-xs leading-relaxed" }, f.remediation)))),
                React.createElement("span", { className: "text-2xs text-muted-foreground" }, f.description))),
        React.createElement(TableCell, { className: "text-right" },
            React.createElement("div", { className: "inline-flex items-center gap-0.5" },
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("button", { type: "button", onClick: (e) => {
                                e.stopPropagation();
                                onAcknowledge();
                            }, "aria-pressed": isAck, "aria-label": isAck
                                ? `Clear acknowledgement on ${f.resourceName}`
                                : `Acknowledge finding on ${f.resourceName} (hotkey: a)`, className: cn("inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", isAck && "text-success") },
                            React.createElement(ShieldCheck, { className: "h-3 w-3" }))),
                    React.createElement(TooltipContent, null, isAck ? "Clear acknowledgement" : "Acknowledge (a)")),
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("button", { type: "button", onClick: (e) => {
                                e.stopPropagation();
                                onSuppress();
                            }, "aria-pressed": isSuppress, "aria-label": isSuppress
                                ? `Unsuppress ${f.resourceName}`
                                : `Suppress finding on ${f.resourceName} (hotkey: s)`, className: cn("inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", isSuppress && "text-destructive") },
                            React.createElement(ShieldOff, { className: "h-3 w-3" }))),
                    React.createElement(TooltipContent, null, isSuppress ? "Unsuppress" : "Suppress (s)")),
                runbook && (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("a", { href: runbook.url, target: "_blank", rel: "noopener noreferrer", className: "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Open runbook for ${f.ruleId}: ${runbook.label}`, onClick: (e) => e.stopPropagation() },
                            React.createElement(BookOpen, { className: "h-3 w-3" }))),
                    React.createElement(TooltipContent, null, runbook.label))),
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: "group/copy inline-flex items-center", "aria-hidden": false },
                            React.createElement(CopyButton, { value: f.resourceId, ariaLabel: `Copy ARM id for ${f.resourceName}`, alwaysVisible: true }))),
                    React.createElement(TooltipContent, null, "Copy ARM id")),
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("a", { href: portalUrl, target: "_blank", rel: "noopener noreferrer", className: "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": `Open ${f.resourceName} in Azure Portal`, onClick: (e) => e.stopPropagation() },
                            React.createElement(ExternalLink, { className: "h-3 w-3" }))),
                    React.createElement(TooltipContent, null, "Open in Azure Portal"))))));
};
// Memoize the row so a single ack/suppress toggle, sort flip, or
// filter chip doesn't re-render hundreds of unaffected rows.
const FindingRow = React.memo(FindingRowImpl);
//# sourceMappingURL=security-audit-page.js.map