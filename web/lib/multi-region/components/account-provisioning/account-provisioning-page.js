import { __awaiter } from "tslib";
/**
 * Account-provisioning page — 5-step wizard (Configure → Preflight → Review →
 * Submit → Result) per Design Contract §3.7. URL reflects current step via
 * `?step=...`. The `import existing accounts` flow remains as a sibling tab
 * since it is a different action class.
 *
 * 2026-05-26 wave-8 (Opus deep pass):
 *   - Lifted `PerSubSparkline` to module scope so it doesn't re-create per
 *     render of the parent (was an inline component, churned every keystroke
 *     on the filter inputs while a run was in flight).
 *   - Moved `perSubSummary` + `confirmMessage` + the dispatch-preview
 *     derivation into `React.useMemo` hooks at the component scope so they
 *     don't recompute on every render of the result step / hidden-dialog.
 *   - Added `Ctrl+Enter` (submit from Submit step) and `ArrowLeft` /
 *     `ArrowRight` to walk enabled wizard steps. ESC keeps its existing
 *     destructive-cancel-with-confirm behaviour.
 *   - Wired `aria-current="step"` on the active AnimatedTabs entry and a
 *     `role="progressbar"` mirror on the per-sub progress bar (Radix
 *     Progress is already a `<progress>` but the per-sub variant uses our
 *     internal component — explicit role + valuenow/valuemin/valuemax keep
 *     it screen-reader correct).
 *   - Per-region/by-sub toggle on the mid-run live rollup so an operator
 *     debugging a stuck region can group by region instead of by sub
 *     (defender-side telemetry view).
 *   - Resume-aborted-run banner: when a persisted `attemptStartedAt`
 *     outlives a hard reload, the configure step shows "Previous run
 *     interrupted at sub X/Y — see audit log for the partial state".
 *   - Defender-grade audit payload (per `_bypass_modify_delete.md` —
 *     state-change operations should be reconstructable from the audit
 *     trail alone): every submit now records a stable `attemptId` UUID,
 *     a preview of the dispatch plan (first 10 pairs), the
 *     `tokenExpirySecAtSubmit` (so a defender reviewing a 401 storm can
 *     tell whether the token was already near-expiry), and the unique
 *     tenant id set the run spans.
 *   - "Post-creation enumeration preview" panel on the Review step
 *     (corpus: NetSPI MicroBurst `Get-AzBatchAccounts` — every new Batch
 *     account is discoverable via `Microsoft.Batch/batchAccounts` list).
 *     Mirrors what an attacker enumerating this tenant would see immediately
 *     after a successful run, so the operator has informed-consent at the
 *     irreversible-action boundary.
 *   - Per-step elapsed time chip rendered in the step header so the
 *     operator can see how long they've spent reading vs. acting.
 *
 * 2026-05-24 redesign: per-page improvement loop. Focus areas:
 *   - Cancellable inter-sub waits (Stop now aborts both the orchestrator
 *     and the configured delay between sub dispatches).
 *   - Region-picker presets (All US / Europe / GPU / Clear) and inline
 *     filter so the dropdown isn't a wall of 40 regions to scroll.
 *   - Subscription-picker filter, copy-to-clipboard for IDs, info tooltip
 *     on the per-sub delay slider, and a "Skip already-existing" toggle
 *     that drops regions where the picked sub already owns a Batch
 *     account from the dispatch list (avoids 409 conflicts at the
 *     orchestrator).
 *   - Result step gains a summary stats panel (success rate, elapsed
 *     wall-clock, avg per region) and a per-account row click that opens
 *     the Azure Portal blade.
 *   - Multiple correctness fixes: timer cleanup on unmount during Stop,
 *     consolidated prefs hydration effect (replaces the two split effects
 *     with the eslint-disabled deps), and tightened attemptAccounts
 *     filter (use createdAt parse rather than lexical compare).
 *
 * 2026-05-25 hardening pass:
 *   - Plumbed AbortSignal end-to-end into `orchestrator.execute({...,signal})`
 *     so a Stop click cancels the in-flight ARM PUT (and not just the
 *     inter-sub wait + the agent-side cancellation flag).
 *   - Switched the 1-second progress ticker + the unmount-cancellation
 *     guard to `useAbortableEffect` so all async timer lifetimes are
 *     guaranteed to be torn down on dependency change / unmount.
 *   - Added `auditLog.record(...)` for every state-mutating user action
 *     (submit, stop, retry, discover, stop-discover, ESC-cancel,
 *     new-request) so the audit-log page surfaces this page like every
 *     other destructive page.
 *   - Persisted the in-progress wizard draft (subs picked, regions,
 *     per-sub delay, skipExisting) to localStorage via `usePersistedState`
 *     so a hard reload mid-configuration doesn't blow away the operator's
 *     work.
 *   - ESC-bound cancel-everything (orchestrator + inter-sub wait) gated
 *     by a confirmation dialog. Inactive when no run is in flight so the
 *     key isn't hijacked from other Radix popovers.
 *   - Per-sub success/fail mini-sparkline rendered mid-run from
 *     `attemptAccounts` so the operator sees per-sub progress without
 *     scrolling to the result step.
 *   - "Copy region list to clipboard" affordance on Step 2 (Preflight)
 *     via the shared `CopyButton`, so the operator can paste the list
 *     into a runbook / ticket without leaving the wizard.
 *   - Per-sub estimated-time badge derived from the rolling average
 *     across previously completed subs in the same attempt, so when a
 *     run is mid-flight the operator can see "Sub 4/8 — ~2m 30s
 *     remaining" instead of staring at an indeterminate spinner.
 *   - Switched the bespoke `CopyChip` to the shared `CopyButton`
 *     primitive so clipboard fallback semantics are identical to the
 *     rest of the app (clipboard API → execCommand fallback).
 */
import * as React from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, CloudDownload, ExternalLink, Info, Loader2, Pencil, Plus, RotateCw, Search, Sparkles, Square, Users, XCircle, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { AnimatedTabs } from "@/components/ui/effects";
import { cn } from "@/lib/utils";
import { useAbortableEffect } from "../../hooks/use-abortable-effect";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useUrlState } from "../../hooks/use-url-state";
import { auditLog } from "../../services/audit-log";
import { preflightCanSubmit, runPreflight, } from "../../shared/account-provisioning-preflight";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { DataTable, } from "../shared/enhanced-table";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { AZURE_REGIONS, DEFAULT_CONFIG, isGpuRegion, isValidSubscriptionId, } from "../shared/constants";
import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { PageHeader } from "../shared/page-header";
import { StatusBadge } from "../shared/status-badge";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { useArmToken } from "../../auth/use-arm-token";
const STEP_ORDER = [
    "configure",
    "preflight",
    "review",
    "submit",
    "result",
];
const STEP_LABEL = {
    configure: "Configure",
    preflight: "Preflight",
    review: "Review",
    submit: "Submit",
    result: "Result",
};
const PREFLIGHT_LEVEL_VARIANT = {
    ok: "success",
    warn: "warning",
    error: "destructive",
    unknown: "info",
};
const REGION_PRESETS = [
    {
        id: "us",
        label: "All US",
        description: "All United States regions (East/West/Central + variants).",
        predicate: (r) => r === "eastus" ||
            r === "eastus2" ||
            r === "westus" ||
            r === "westus2" ||
            r === "westus3" ||
            r === "centralus" ||
            r === "northcentralus" ||
            r === "southcentralus" ||
            r === "westcentralus",
    },
    {
        id: "europe",
        label: "All Europe",
        description: "EU + UK + Nordics regions.",
        predicate: (r) => r === "northeurope" ||
            r === "westeurope" ||
            r === "uksouth" ||
            r === "ukwest" ||
            r === "francecentral" ||
            r === "germanywestcentral" ||
            r === "norwayeast" ||
            r === "switzerlandnorth" ||
            r === "swedencentral" ||
            r === "polandcentral" ||
            r === "italynorth" ||
            r === "spaincentral",
    },
    {
        id: "apac",
        label: "All APAC",
        description: "Asia-Pacific + India + Australia regions.",
        predicate: (r) => r === "eastasia" ||
            r === "southeastasia" ||
            r === "japaneast" ||
            r === "japanwest" ||
            r === "australiaeast" ||
            r === "australiasoutheast" ||
            r === "centralindia" ||
            r === "southindia" ||
            r === "westindia" ||
            r === "koreacentral" ||
            r === "koreasouth",
    },
    {
        id: "gpu",
        label: "All V100/H100",
        description: "Regions advertising Nvidia V100 (NCv3) or H100.",
        predicate: (r) => isGpuRegion(r),
    },
];
const PreflightIcon = ({ level }) => {
    const className = "h-4 w-4 shrink-0";
    if (level === "ok")
        return React.createElement(CheckCircle2, { className: className, "aria-hidden": true });
    if (level === "warn")
        return React.createElement(AlertTriangle, { className: className, "aria-hidden": true });
    if (level === "error")
        return React.createElement(AlertCircle, { className: className, "aria-hidden": true });
    return React.createElement(Info, { className: className, "aria-hidden": true });
};
const PREFLIGHT_LEVEL_TEXT = {
    ok: "OK",
    warn: "Warning",
    error: "Error",
    unknown: "Info",
};
const PreflightChips = ({ checks, }) => {
    // Aggregate summary so the operator can see overall posture at a glance
    // before reading individual chips. Pure derivation — no state.
    const summary = React.useMemo(() => {
        let ok = 0;
        let warn = 0;
        let err = 0;
        for (const c of checks) {
            if (c.level === "ok")
                ok++;
            else if (c.level === "warn")
                warn++;
            else if (c.level === "error")
                err++;
        }
        return { ok, warn, err, total: checks.length };
    }, [checks]);
    return (React.createElement("div", { className: "flex flex-col gap-2", role: "status", "aria-live": "polite", "aria-label": "Pre-flight checks" },
        summary.total > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 text-2xs", "aria-label": "Pre-flight summary" },
            React.createElement("span", { className: "inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 font-semibold text-success transition-colors duration-200" },
                React.createElement(CheckCircle2, { className: "h-3 w-3", "aria-hidden": true }),
                summary.ok,
                " ok"),
            summary.warn > 0 && (React.createElement("span", { className: "inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 font-semibold text-warning transition-colors duration-200" },
                React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
                summary.warn,
                " warn")),
            summary.err > 0 && (React.createElement("span", { className: "inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-semibold text-destructive transition-colors duration-200" },
                React.createElement(XCircle, { className: "h-3 w-3", "aria-hidden": true }),
                summary.err,
                " blocking")))),
        checks.map((c) => (React.createElement(Alert, { key: c.id, variant: PREFLIGHT_LEVEL_VARIANT[c.level], className: "px-3 py-2 text-xs transition-colors duration-200 ease-out [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6", "aria-label": `${PREFLIGHT_LEVEL_TEXT[c.level]} — ${c.label}: ${c.detail}` },
            React.createElement(PreflightIcon, { level: c.level }),
            React.createElement(AlertDescription, { className: "text-xs leading-relaxed" },
                React.createElement("span", { className: "font-semibold" },
                    c.label,
                    "."),
                " ",
                React.createElement("span", { className: "opacity-90" }, c.detail)))))));
};
// Thin wrapper around the shared `CopyButton` primitive. We keep the
// CopyChip name (and the `label` prop ergonomics) so every existing call
// site in this file stays unchanged, but the clipboard write itself now
// flows through the shared primitive — that gives us the
// clipboard-API → execCommand fallback path the rest of the app uses, so
// in insecure contexts (file:// previews, blocked clipboard perms) the
// chip still copies instead of silently failing. Tooltip wrapping is
// kept here so consumers continue to get a hover hint with the resource
// label rather than the raw value.
const CopyChip = ({ value, label, className }) => {
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true },
            React.createElement("span", { className: "inline-flex" },
                React.createElement(CopyButton, { value: value, ariaLabel: label ? `Copy ${label}` : `Copy ${value}`, iconSize: 12, alwaysVisible: true, className: cn("h-4 w-4 rounded-sm", className) }))),
        React.createElement(TooltipContent, { side: "top" }, label ? `Copy ${label}` : "Copy")));
};
const ConfigureFieldsetReadOnly = ({ subscriptions, selectedRegions, perSubDelaySec, skipExisting, skippedCount, onEdit, }) => (React.createElement("div", { className: "rounded-md border border-border bg-surface-sunken/40 p-3" },
    React.createElement("div", { className: "mb-2 flex items-center justify-between gap-2" },
        React.createElement("h4", { className: "m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Configuration"),
        React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: onEdit, "aria-label": "Edit configuration" },
            React.createElement(Pencil, { className: "h-3 w-3", "aria-hidden": true }),
            "Edit")),
    React.createElement("dl", { className: "grid grid-cols-1 gap-2 text-xs sm:grid-cols-2" },
        React.createElement("div", { className: "flex flex-col gap-0.5" },
            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" },
                "Subscriptions (",
                subscriptions.length,
                ")"),
            React.createElement("dd", { className: "m-0 flex flex-col gap-1" },
                subscriptions.map((s) => {
                    var _a;
                    return (React.createElement("span", { key: s.subscriptionId, className: "inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground" },
                        React.createElement("span", { className: "font-medium" }, s.displayName),
                        React.createElement("span", { className: "font-mono text-muted-foreground" },
                            ((_a = s.subscriptionId) !== null && _a !== void 0 ? _a : "").slice(0, 8),
                            "\u2026"),
                        React.createElement(CopyChip, { value: s.subscriptionId, label: "subscription id" }),
                        s.ownerAccountLabel && (React.createElement("span", { className: "text-muted-foreground" },
                            "\u00B7 ",
                            s.ownerAccountLabel))));
                }),
                subscriptions.length > 1 && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                    "Sequential dispatch \u00B7 ",
                    perSubDelaySec,
                    "s between subs")))),
        React.createElement("div", { className: "flex flex-col gap-0.5" },
            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" },
                "Regions (",
                selectedRegions.length,
                ")"),
            React.createElement("dd", { className: "m-0 flex flex-wrap gap-1" }, selectedRegions.map((r) => (React.createElement("span", { key: r, className: "inline-flex items-center rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground" }, r)))))),
    subscriptions.length > 1 && (React.createElement("div", { className: "mt-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-2xs text-foreground" },
        "Total accounts to create:",
        " ",
        React.createElement("span", { className: "font-semibold tabular-nums" }, subscriptions.length * selectedRegions.length - skippedCount),
        " ",
        "(",
        subscriptions.length,
        " sub",
        subscriptions.length === 1 ? "" : "s",
        " \u00D7",
        " ",
        selectedRegions.length,
        " region",
        selectedRegions.length === 1 ? "" : "s",
        ")",
        skipExisting && skippedCount > 0 && (React.createElement("span", { className: "ml-1 text-muted-foreground" },
            "\u00B7 skipping ",
            skippedCount,
            " existing"))))));
const REGION_STATE_TONE = {
    pending: "border-border bg-muted/40 text-muted-foreground",
    creating: "border-primary/40 bg-primary/10 text-primary",
    created: "border-success/40 bg-success/10 text-success",
    failed: "border-destructive/40 bg-destructive/10 text-destructive",
};
const RegionStatusChip = ({ region, state, accountName, error }) => {
    const normalized = state === "created" || state === "failed" || state === "creating"
        ? state
        : "pending";
    const Icon = normalized === "created"
        ? CheckCircle2
        : normalized === "failed"
            ? XCircle
            : normalized === "creating"
                ? Loader2
                : null;
    const chip = (React.createElement("span", { className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors duration-200 ease-out", REGION_STATE_TONE[normalized]), "aria-label": `${region}: ${normalized}` },
        Icon ? (React.createElement(Icon, { className: cn("h-3 w-3", normalized === "creating" && "animate-spin motion-reduce:animate-none"), "aria-hidden": true })) : null,
        region));
    // Show tooltip with detail when there's something to surface (account
    // name, error message). Skip the tooltip in the trivial case.
    const tip = error
        ? error
        : accountName
            ? `${accountName} — ${normalized}`
            : null;
    if (!tip)
        return chip;
    return (React.createElement(Tooltip, null,
        React.createElement(TooltipTrigger, { asChild: true },
            React.createElement("span", { className: "inline-flex" }, chip)),
        React.createElement(TooltipContent, { side: "top" }, tip)));
};
function formatEta(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60)
        return s === 0 ? `${m}m` : `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}
/**
 * Cancellable delay. Resolves when `ms` elapses OR when `signal.aborted`
 * fires (in which case it resolves with `cancelled = true`). Used by the
 * inter-subscription wait so a Stop click actually halts the loop rather
 * than letting the wait run to completion before the next dispatch is
 * skipped.
 */
function abortableDelay(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve({ cancelled: true });
            return;
        }
        const handle = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve({ cancelled: false });
        }, ms);
        const onAbort = () => {
            clearTimeout(handle);
            signal.removeEventListener("abort", onAbort);
            resolve({ cancelled: true });
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
/** Build the Azure portal blade URL for a Batch account. */
function azurePortalUrl(args) {
    const resourceId = `/subscriptions/${args.subscriptionId}` +
        `/resourceGroups/${args.resourceGroup}` +
        `/providers/Microsoft.Batch/batchAccounts/${args.accountName}`;
    return `https://portal.azure.com/#@/resource${resourceId}/overview`;
}
/**
 * Stable per-sub sparkline. Lifted to module scope from the parent
 * component so it doesn't get re-created on every parent render (which
 * happens at 1Hz while the ticker effect is running). React.memo so
 * sub rows with unchanged counts skip re-render.
 */
const PerSubSparkline = React.memo(({ created, failed, total }) => {
    const cells = Math.max(1, Math.min(total, 24));
    const out = [];
    let createdLeft = created;
    let failedLeft = failed;
    for (let i = 0; i < cells; i++) {
        let tone = "bg-muted";
        if (createdLeft > 0) {
            tone = "bg-success/80";
            createdLeft -= 1;
        }
        else if (failedLeft > 0) {
            tone = "bg-destructive/80";
            failedLeft -= 1;
        }
        out.push(React.createElement("span", { key: i, className: cn("h-2.5 w-1 rounded-sm", tone), "aria-hidden": true }));
    }
    return (React.createElement("span", { className: "inline-flex items-center gap-[2px]", "aria-label": `${created} created, ${failed} failed of ${total}` }, out));
});
PerSubSparkline.displayName = "PerSubSparkline";
/**
 * Cheap RFC-4122-ish v4 UUID. Used for stable `attemptId` audit
 * correlation — the audit log records this id at submit, complete,
 * stop, and esc_cancel, so a defender reviewing the trail can scope
 * every event back to a single user intent. Falls back to
 * `crypto.randomUUID()` when available (browsers since 2022); fallback
 * is Math.random-based so it's not collision-resistant in a strict
 * cryptographic sense — fine for audit correlation, not fine for
 * security tokens. Corpus reference: `_bypass_modify_delete.md`
 * § "state-change operations should be reconstructable from the
 * audit trail alone".
 */
function newAttemptId() {
    try {
        if (typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
    }
    catch (_a) {
        /* fall through */
    }
    // Non-crypto fallback — purely for correlation, never for auth.
    return "atmpt-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}
const AccountProvisioningPageInner = ({ orchestrator, }) => {
    var _a, _b, _c;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    // ---- URL-backed step state -----------------------------------------------
    const [urlState, setUrlState] = useUrlState({
        step: "configure",
        tab: "create",
    });
    const activeTab = urlState.tab === "import" ? "import" : "create";
    const rawStep = ((_a = urlState.step) !== null && _a !== void 0 ? _a : "configure");
    const currentStep = STEP_ORDER.includes(rawStep)
        ? rawStep
        : "configure";
    const setStep = React.useCallback((next) => setUrlState({ step: next }), [setUrlState]);
    const setActiveTab = React.useCallback((next) => setUrlState({
        tab: next,
        step: next === "create" ? currentStep : "configure",
    }), [setUrlState, currentStep]);
    // ---- Persisted wizard draft ----------------------------------------------
    // The configure step's inputs are persisted to localStorage so a hard
    // reload mid-configuration doesn't blow away the operator's draft. We
    // use a single envelope keyed by `WIZARD_DRAFT_KEY` so all four
    // wizard inputs survive together (or get wiped together on schema
    // bump). `subscriptionId` (typed-input fallback) stays in the store's
    // `lastSubscriptionId` because it's not wizard-scoped — it's the
    // "last sub the user worked with" used by other pages too.
    const [wizardDraft, setWizardDraft] = usePersistedState("abm.account-provisioning.wizard-draft", {
        selectedSubIds: [],
        selectedRegions: [],
        perSubDelaySec: 30,
        skipExisting: true,
    }, {
        version: 1,
        migrate: (raw) => {
            // Defensive read — drop the persisted draft entirely if it
            // doesn't look like our shape rather than leak shape errors
            // into the form. Returning undefined falls back to the
            // initialValue (clean defaults).
            if (!raw || typeof raw !== "object")
                return undefined;
            const d = raw;
            return {
                selectedSubIds: Array.isArray(d.selectedSubIds)
                    ? d.selectedSubIds.filter((x) => typeof x === "string")
                    : [],
                selectedRegions: Array.isArray(d.selectedRegions)
                    ? d.selectedRegions.filter((x) => typeof x === "string")
                    : [],
                perSubDelaySec: typeof d.perSubDelaySec === "number" &&
                    d.perSubDelaySec >= 30 &&
                    d.perSubDelaySec <= 60
                    ? d.perSubDelaySec
                    : 30,
                skipExisting: typeof d.skipExisting === "boolean" ? d.skipExisting : true,
            };
        },
    });
    // ---- Form state -----------------------------------------------------------
    // Mirror the persisted draft into local pieces so the existing render
    // path (which sets each field independently) keeps working unchanged.
    // We expose `setSelectedRegions` etc. as thin setters that route back
    // into `setWizardDraft` so writes are persisted automatically.
    const selectedRegions = wizardDraft.selectedRegions;
    const setSelectedRegions = React.useCallback((next) => {
        setWizardDraft((d) => (Object.assign(Object.assign({}, d), { selectedRegions: typeof next === "function"
                ? next(d.selectedRegions)
                : next })));
    }, [setWizardDraft]);
    // `subscriptionId` is the fallback (typed) single-sub for the case
    // where no Azure account is signed in — the existing free-text input
    // path. `selectedSubIds` is the multi-pick set used when the page
    // can enumerate signed-in subs via the dropdown — every sub the user
    // ticks gets its own create_accounts run in the submit loop.
    const [subscriptionId, setSubscriptionId] = React.useState("");
    const selectedSubIds = wizardDraft.selectedSubIds;
    const setSelectedSubIds = React.useCallback((next) => {
        setWizardDraft((d) => (Object.assign(Object.assign({}, d), { selectedSubIds: typeof next === "function"
                ? next(d.selectedSubIds)
                : next })));
    }, [setWizardDraft]);
    // Delay (seconds) between per-subscription create_accounts dispatches.
    // Bound 30–60 — anything lower risks tripping ARM's per-tenant write
    // throttle when the same operator fires identical PUT batchAccounts
    // calls back-to-back across many subs. Persisted with the draft so
    // the operator's chosen pacing sticks across reloads.
    const perSubDelaySec = wizardDraft.perSubDelaySec;
    const setPerSubDelaySec = React.useCallback((next) => {
        setWizardDraft((d) => (Object.assign(Object.assign({}, d), { perSubDelaySec: next })));
    }, [setWizardDraft]);
    // ISO timestamp of when the user submitted the CURRENT attempt. The
    // wizard's progress + result counters are scoped to accounts created
    // at-or-after this stamp so prior submissions don't bleed into the
    // current attempt's view (which previously froze the user on the
    // result step and silently blocked re-submission).
    const [attemptStartedAt, setAttemptStartedAt] = React.useState(null);
    // Stable correlation id for the current attempt — used as the audit
    // log's `attemptId` field so submit / complete / stop / esc_cancel
    // events for the same user intent can be grouped server-side.
    // Generated fresh at each submit; null between runs. Per
    // `_bypass_modify_delete.md` § audit-reconstruction.
    const [attemptId, setAttemptId] = React.useState(null);
    // Persisted resume hint for mid-batch interruptions — see
    // `AttemptResumeHint` (module scope). When a hard reload happens
    // while a run is in flight, the next mount reads this and surfaces
    // a banner on the configure step. Cleared on completion / cancel.
    const [resumeHint, setResumeHint] = usePersistedState("abm.account-provisioning.resume-hint", null, {
        version: 1,
        migrate: (raw) => {
            if (!raw || typeof raw !== "object")
                return null;
            const r = raw;
            if (typeof r.attemptId !== "string" ||
                typeof r.attemptStartedAt !== "string" ||
                typeof r.completedSubs !== "number" ||
                typeof r.totalSubs !== "number") {
                return null;
            }
            return {
                attemptId: r.attemptId,
                attemptStartedAt: r.attemptStartedAt,
                completedSubs: r.completedSubs,
                totalSubs: r.totalSubs,
                currentSubId: typeof r.currentSubId === "string" ? r.currentSubId : null,
            };
        },
    });
    // Per-step elapsed-time tracker. Whenever `currentStep` changes we
    // capture the wall-clock at that moment; the step header renders
    // the rolling delta. Pure UI signal — no persistence, no audit
    // recording (would be too chatty).
    const [stepEnteredAt, setStepEnteredAt] = React.useState(() => Date.now());
    // Re-render every ~5s while the user is on a step so the elapsed
    // chip refreshes. Cheap; cleaned up by useAbortableEffect on step
    // change / unmount.
    const [, setStepTick] = React.useState(0);
    // Wall-clock duration of the last completed attempt, in ms. Captured
    // when isRunning flips false so the result step can show a stable
    // "elapsed N min" stat without ticking after completion.
    const [lastAttemptDurationMs, setLastAttemptDurationMs] = React.useState(null);
    const [autoSelectedSubscription, setAutoSelectedSubscription] = React.useState(false);
    const [isRunning, setIsRunning] = React.useState(false);
    const [isDiscovering, setIsDiscovering] = React.useState(false);
    const [discoverError, setDiscoverError] = React.useState(null);
    const [submitError, setSubmitError] = React.useState(null);
    const [validationError, setValidationError] = React.useState(null);
    const [confirmHidden, setConfirmHidden] = React.useState(true);
    // When true, regions that already have a "created" Batch account in the
    // picked sub are dropped from the dispatch list so the orchestrator
    // doesn't issue a 409 PUT against an existing account. Default on so
    // re-running a partially-completed batch is idempotent by default.
    // Persisted via the wizard draft so the operator's preference survives
    // reload.
    const skipExisting = wizardDraft.skipExisting;
    const setSkipExisting = React.useCallback((next) => setWizardDraft((d) => (Object.assign(Object.assign({}, d), { skipExisting: next }))), [setWizardDraft]);
    // Region picker inline filter — typed into the search box at the top
    // of the dropdown so the operator can jump straight to a region by
    // typing part of its name. Empty string means "show all".
    const [regionFilter, setRegionFilter] = React.useState("");
    // Subscription picker inline filter — same idea as the region filter,
    // but applied to the subscription dropdown. Multi-account environments
    // can show >20 subs and the operator wants to type "prod" or "westus"
    // (matches displayName + id) to find the right one fast.
    const [subFilter, setSubFilter] = React.useState("");
    // Cancellation handle for the active submit run. Used by the Stop
    // button to abort BOTH the orchestrator AND the inter-sub wait — the
    // previous version only cancelled the orchestrator, leaving the
    // setTimeout running so the next sub's create_accounts would still
    // fire after the operator hit Stop.
    const submitAbortRef = React.useRef(null);
    // Cleanup any in-flight controller on unmount so a Stop -> route
    // change doesn't leave a dangling timer. Use `useAbortableEffect`
    // for symmetry with the other async lifetimes on this page even
    // though the cleanup runs only at unmount (deps = []).
    useAbortableEffect(() => {
        return () => {
            var _a;
            (_a = submitAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
            submitAbortRef.current = null;
        };
    }, []);
    // ESC-bound cancel-everything. When a run is in flight, ESC pops a
    // confirmation dialog rather than aborting silently — destructive
    // shortcuts should never trigger from a stray keystroke. The shortcut
    // is hard-gated on `isRunning || isDiscovering` so other Radix
    // popovers (which also handle ESC) aren't fighting for the keystroke
    // when no run is active.
    const [escCancelHidden, setEscCancelHidden] = React.useState(true);
    // ---- Page-level ARM token tracker ----------------------------------------
    // Account-provisioning fires PUT batchAccounts across N subs × M regions
    // and can sit open for many minutes (especially with the per-sub delay).
    // Without an expiry hint the operator can submit at minute 58 of a 60-min
    // token and watch every region 401. We pick the account that owns the
    // FIRST selected sub when available; otherwise fall back to the first
    // signed-in azureAccount so the badge still surfaces an expiry warning
    // when the operator hasn't picked a sub yet.
    const armTokenAccount = React.useMemo(() => {
        var _a, _b;
        const firstSubId = selectedSubIds.length > 0 ? selectedSubIds[0] : undefined;
        const sub = firstSubId
            ? state.subscriptions.find((s) => s.subscriptionId === firstSubId)
            : undefined;
        const azureAccounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
        if (sub === null || sub === void 0 ? void 0 : sub.homeAccountId) {
            const match = azureAccounts.find((a) => a.homeAccountId === sub.homeAccountId);
            if (match) {
                return {
                    homeAccountId: match.homeAccountId,
                    tenantId: (_b = sub.tenantId) !== null && _b !== void 0 ? _b : match.tenantId,
                };
            }
            return {
                homeAccountId: sub.homeAccountId,
                tenantId: sub.tenantId,
            };
        }
        const fallback = azureAccounts[0];
        if (!fallback)
            return {
                homeAccountId: undefined,
                tenantId: undefined,
            };
        return {
            homeAccountId: fallback.homeAccountId,
            tenantId: fallback.tenantId,
        };
    }, [selectedSubIds, state.subscriptions, state.azureAccounts]);
    const armTokenTracker = useArmToken(armTokenAccount.homeAccountId, armTokenAccount.tenantId);
    // ---- Prefs hydration -----------------------------------------------------
    // Consolidated mount-time prefs read: do BOTH the typed-input default
    // and the multi-sub auto-tick in one effect so a saved
    // `lastSubscriptionId` doesn't race with a fresh subs list and end up
    // hydrating twice. Runs once on mount; re-runs when the subs list
    // first becomes non-empty so the saved id can pre-tick a row.
    const hydratedRef = React.useRef(false);
    React.useEffect(() => {
        var _a, _b;
        const prefs = store.getUserPreferences();
        // Always seed the typed-input fallback once — independent of
        // whether subs are loaded yet (operator may want to paste a sub id
        // without signing in).
        if (!hydratedRef.current && prefs.lastSubscriptionId) {
            setSubscriptionId(prefs.lastSubscriptionId);
        }
        // Only fall back to the global `lastRegions` pref when the wizard
        // draft is empty. If `usePersistedState` already restored a draft
        // with non-empty regions, that's the more recent intent and should
        // win — overwriting it with the global pref would lose the
        // operator's in-progress wizard work after a reload.
        if (!hydratedRef.current &&
            ((_a = prefs.lastRegions) === null || _a === void 0 ? void 0 : _a.length) &&
            selectedRegions.length === 0) {
            setSelectedRegions(prefs.lastRegions.slice(0, DEFAULT_CONFIG.maxRegionsPerRequest));
        }
        hydratedRef.current = true;
        // Subs-aware pre-tick: when the list lands, restore the saved id if
        // it's still visible. Same precedence rule — only fire when the
        // wizard draft hasn't already chosen one.
        if (state.subscriptions.length > 0 && selectedSubIds.length === 0) {
            if (prefs.lastSubscriptionId &&
                state.subscriptions.some((s) => s.subscriptionId === prefs.lastSubscriptionId)) {
                setSelectedSubIds([prefs.lastSubscriptionId]);
            }
            else if (state.subscriptions.length === 1) {
                const onlyId = (_b = state.subscriptions[0]) === null || _b === void 0 ? void 0 : _b.subscriptionId;
                if (onlyId) {
                    setSelectedSubIds([onlyId]);
                    setAutoSelectedSubscription(true);
                }
            }
        }
        // Drop stale ids the moment subs change (sign-out etc.)
        const visible = new Set(state.subscriptions.map((s) => s.subscriptionId));
        setSelectedSubIds((prev) => {
            const filtered = prev.filter((id) => visible.has(id));
            return filtered.length === prev.length ? prev : filtered;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.subscriptions]);
    const handleSubscriptionChange = React.useCallback((newValue) => {
        setSubscriptionId(newValue);
        setAutoSelectedSubscription(false);
        setValidationError(null);
        store.saveUserPreferences({ lastSubscriptionId: newValue });
    }, [store]);
    const toggleSubSelection = React.useCallback((subId) => {
        setSelectedSubIds((prev) => {
            const next = prev.includes(subId)
                ? prev.filter((x) => x !== subId)
                : [...prev, subId];
            setAutoSelectedSubscription(false);
            setValidationError(null);
            // Persist the FIRST selected as "last sub" so a fresh load
            // pre-ticks something sensible. Multi-select state itself
            // isn't persisted — operators usually want a fresh pick per
            // batch run.
            if (next.length > 0) {
                store.saveUserPreferences({ lastSubscriptionId: next[0] });
            }
            return next;
        });
    }, [store]);
    const handleRegionsChange = React.useCallback((newRegions) => {
        if (newRegions.length > DEFAULT_CONFIG.maxRegionsPerRequest) {
            // Trim rather than refuse — operator clearly wants "all of
            // these" and trimming to the cap is friendlier than a no-op.
            newRegions = newRegions.slice(0, DEFAULT_CONFIG.maxRegionsPerRequest);
        }
        setSelectedRegions(newRegions);
        store.saveUserPreferences({ lastRegions: newRegions });
    }, [store]);
    // Apply a region preset: union with existing selection (so the user
    // can compose multiple presets), clamped to the per-request cap.
    const applyRegionPreset = React.useCallback((preset) => {
        const set = new Set(selectedRegions);
        for (const r of AZURE_REGIONS) {
            if (preset.predicate(r))
                set.add(r);
        }
        handleRegionsChange(Array.from(set));
    }, [selectedRegions, handleRegionsChange]);
    const clearRegions = React.useCallback(() => {
        handleRegionsChange([]);
    }, [handleRegionsChange]);
    // ---- Pre-flight (also used by "preflight" step) --------------------------
    // Preflight is single-sub today — it validates GUID shape, sub
    // presence, and name uniqueness against the *primary* picked sub.
    // For multi-sub runs we pass the FIRST effective sub so the checks
    // still execute against a real id; the name-uniqueness check is
    // safe because account names are scoped per-sub and we generate them
    // fresh per dispatch.
    const preflightSubId = selectedSubIds.length > 0 ? selectedSubIds[0] : subscriptionId;
    const preflight = React.useMemo(() => {
        var _a;
        return runPreflight({
            subscriptionId: preflightSubId,
            selectedRegions,
            accounts: state.accounts,
            subscriptions: state.subscriptions,
            azureAccounts: (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [],
            maxRegions: DEFAULT_CONFIG.maxRegionsPerRequest,
        });
    }, [
        preflightSubId,
        selectedRegions,
        state.accounts,
        state.subscriptions,
        state.azureAccounts,
    ]);
    const canPassPreflight = React.useMemo(() => preflightCanSubmit(preflight), [preflight]);
    // ---- Step gate ------------------------------------------------------------
    // Two valid input modes:
    //   1. Multi-select from the signed-in subscription list →
    //      selectedSubIds is non-empty. This is the common path when the
    //      Azure Accounts page has signed-in identities.
    //   2. Typed single subscription id → subscriptionId trimmed, valid
    //      GUID. Used as the fallback when no AAD accounts are signed in
    //      and the operator wants to provision via az-cli credentials.
    //
    // COORDINATOR: pre-filter `selectedSubIds` against per-tenant Batch
    // account quota before dispatch. Today we only filter (sub, region)
    // pairs against the "already created" set via `existingByKey`; we do
    // NOT consult the per-sub quota. The quota check belongs in the
    // provisioner-agent (it already calls ARM /providers/Microsoft.Batch
    // /locations/{loc}/quotas) — the page should surface a preflight
    // warn-chip when (sub, region).quota.remaining < region count rather
    // than reach in itself. Add a `runPreflight` arm that walks the plan
    // and asks the orchestrator for quota; until then the worst-case is
    // a 4xx at submit time which the per-region failed-state already
    // surfaces.
    //
    // COORDINATOR: CSV/newline bulk-paste of subscription IDs is the
    // natural next step here (operator could paste "sub-a\nsub-b\nsub-c"
    // into the typed-input). If that lands, this page starts behaving
    // like the import-batch flow — consider folding the paste UX into a
    // shared "id-list-paste" control so the import-batch page can reuse
    // it without two divergent implementations.
    const effectiveSubscriptionIds = React.useMemo(() => {
        if (selectedSubIds.length > 0)
            return selectedSubIds;
        const trimmed = subscriptionId.trim();
        return trimmed ? [trimmed] : [];
    }, [selectedSubIds, subscriptionId]);
    const configureValid = React.useMemo(() => {
        if (effectiveSubscriptionIds.length === 0)
            return false;
        // For the typed-input fallback, validate the GUID shape. Multi-
        // select already constrains to ids that came from MSAL — no need
        // to re-validate.
        if (state.subscriptions.length === 0 &&
            selectedSubIds.length === 0 &&
            !isValidSubscriptionId(subscriptionId)) {
            return false;
        }
        if (selectedRegions.length === 0)
            return false;
        return true;
    }, [
        effectiveSubscriptionIds.length,
        selectedSubIds.length,
        subscriptionId,
        selectedRegions,
        state.subscriptions.length,
    ]);
    const isStepDisabled = React.useCallback((step) => {
        if (step === "configure")
            return false;
        if (step === "preflight")
            return !configureValid;
        if (step === "review")
            return !configureValid || !canPassPreflight;
        if (step === "submit")
            return !configureValid || !canPassPreflight;
        if (step === "result") {
            // Result is reachable only after a submit attempt has occurred
            // IN THIS SESSION — `attemptStartedAt` is the canonical signal.
            // Using `state.accounts.length` would let a prior session's
            // accounts unlock the result tab without a fresh submission.
            return !attemptStartedAt && !isRunning;
        }
        return false;
    }, [configureValid, canPassPreflight, attemptStartedAt, isRunning]);
    // ---- Skip-existing planning ----------------------------------------------
    // Map of (subId, region) -> "created" account so we can both:
    //   - show a warning chip on regions the operator already owns in
    //     the picked sub(s), AND
    //   - drop them from the dispatch list when `skipExisting` is on.
    const existingByKey = React.useMemo(() => {
        const m = new Map();
        for (const a of state.accounts) {
            if (a.provisioningState === "created" && a.subscriptionId && a.region) {
                m.set(`${a.subscriptionId}::${a.region}`, true);
            }
        }
        return m;
    }, [state.accounts]);
    // Per (sub, region) plan = the (sub, region) pairs the orchestrator
    // will actually be asked to create. Honors `skipExisting`.
    const dispatchPlan = React.useMemo(() => {
        const out = [];
        for (const sub of effectiveSubscriptionIds) {
            for (const region of selectedRegions) {
                if (skipExisting && existingByKey.has(`${sub}::${region}`))
                    continue;
                out.push({ subscriptionId: sub, region });
            }
        }
        return out;
    }, [effectiveSubscriptionIds, selectedRegions, skipExisting, existingByKey]);
    // Per-sub list of regions the orchestrator will dispatch. Used to
    // skip the dispatch when ALL regions for a sub are already created.
    const dispatchPerSub = React.useMemo(() => {
        var _a;
        const m = new Map();
        for (const p of dispatchPlan) {
            const list = (_a = m.get(p.subscriptionId)) !== null && _a !== void 0 ? _a : [];
            list.push(p.region);
            m.set(p.subscriptionId, list);
        }
        return m;
    }, [dispatchPlan]);
    const skippedExistingCount = effectiveSubscriptionIds.length * selectedRegions.length -
        dispatchPlan.length;
    // ---- Counters / progress --------------------------------------------------
    // Scope to the current attempt: only count accounts whose `addedAt`
    // is at-or-after `attemptStartedAt`. When `attemptStartedAt` is null
    // (no submission yet, or user cleared via "New request") all counts
    // collapse to 0 — the auto-advance below will not fire and the
    // submit button stays enabled for a fresh request.
    const attemptAccounts = React.useMemo(() => {
        if (!attemptStartedAt)
            return [];
        const startMs = Date.parse(attemptStartedAt);
        if (Number.isNaN(startMs))
            return [];
        return state.accounts.filter((a) => {
            if (!a.createdAt)
                return false;
            const ts = Date.parse(a.createdAt);
            return !Number.isNaN(ts) && ts >= startMs;
        });
    }, [state.accounts, attemptStartedAt]);
    const createdCount = attemptAccounts.filter((a) => a.provisioningState === "created").length;
    const failedCount = attemptAccounts.filter((a) => a.provisioningState === "failed").length;
    const totalCount = attemptAccounts.length;
    // Progress total now reflects the dispatch plan (post-skip), not the
    // raw region count, so the % accurately reports "of what we're
    // actually asking the orchestrator to do".
    const dispatchTotal = dispatchPlan.length;
    const progressTotal = totalCount > 0 ? totalCount : dispatchTotal;
    const progressDone = createdCount + failedCount;
    const progressPercent = progressTotal > 0
        ? Math.min(100, Math.round((progressDone / progressTotal) * 100))
        : 0;
    // Per-region status keyed by region — drives the per-region status list
    // shown during submit. Falls back to "pending" for any region the
    // orchestrator hasn't reported on yet.
    const regionStatus = React.useMemo(() => {
        var _a, _b;
        const byRegion = new Map();
        for (const a of attemptAccounts) {
            byRegion.set(a.region, {
                id: (_a = a.id) !== null && _a !== void 0 ? _a : `${a.region}-${a.accountName}`,
                region: a.region,
                accountName: a.accountName,
                resourceGroup: a.resourceGroup,
                subscriptionId: a.subscriptionId,
                provisioningState: a.provisioningState,
                error: (_b = a.error) !== null && _b !== void 0 ? _b : undefined,
            });
        }
        return selectedRegions.map((r) => {
            var _a;
            const row = byRegion.get(r);
            return {
                region: r,
                state: (_a = row === null || row === void 0 ? void 0 : row.provisioningState) !== null && _a !== void 0 ? _a : (attemptStartedAt && isRunning ? "creating" : "pending"),
                accountName: row === null || row === void 0 ? void 0 : row.accountName,
                error: row === null || row === void 0 ? void 0 : row.error,
            };
        });
    }, [attemptAccounts, selectedRegions, attemptStartedAt, isRunning]);
    // Region currently being provisioned — first non-terminal in the list.
    // Used as the "Working on..." label below the progress bar so the user
    // sees forward motion even when the bar is mid-transition.
    const currentRegion = React.useMemo(() => {
        var _a;
        if (!isRunning)
            return null;
        const next = regionStatus.find((r) => r.state !== "created" && r.state !== "failed");
        return (_a = next === null || next === void 0 ? void 0 : next.region) !== null && _a !== void 0 ? _a : null;
    }, [regionStatus, isRunning]);
    // Lightweight ETA: average elapsed-per-completed-region times remaining.
    // We track elapsed via `attemptStartedAt`; when zero have completed we
    // can't estimate yet, so we render an em-dash.
    const etaSeconds = React.useMemo(() => {
        if (!isRunning || !attemptStartedAt)
            return null;
        if (progressDone === 0 || progressDone >= progressTotal)
            return null;
        const elapsedMs = Date.now() - new Date(attemptStartedAt).getTime();
        if (elapsedMs <= 0)
            return null;
        const perItemMs = elapsedMs / progressDone;
        const remaining = progressTotal - progressDone;
        return Math.max(1, Math.round((perItemMs * remaining) / 1000));
    }, [isRunning, attemptStartedAt, progressDone, progressTotal]);
    // Re-render every second while running so the ETA display + the
    // inter-sub waitingUntil countdown both update without forcing the
    // orchestrator to push tick events. When not running this effect is
    // a no-op. Uses `useAbortableEffect` so the interval is guaranteed
    // torn down on `isRunning` flip or unmount (the abort fires before
    // the setState would; React batching swallows the final tick).
    const [, setTickNonce] = React.useState(0);
    useAbortableEffect((signal) => {
        if (!isRunning)
            return;
        const id = setInterval(() => {
            if (signal.aborted)
                return;
            setTickNonce((n) => n + 1);
        }, 1000);
        return () => clearInterval(id);
    }, [isRunning]);
    // Step-elapsed timer: re-capture `stepEnteredAt` whenever the step
    // changes, and tick once every 5s so the chip in the step header
    // refreshes. Aborted on step change / unmount.
    React.useEffect(() => {
        setStepEnteredAt(Date.now());
        setStepTick(0);
    }, [currentStep]);
    useAbortableEffect((signal) => {
        const id = setInterval(() => {
            if (signal.aborted)
                return;
            setStepTick((n) => n + 1);
        }, 5000);
        return () => clearInterval(id);
    }, [currentStep]);
    // Mid-run rollup grouping toggle. Default by-sub matches the wave-1
    // sparkline layout; by-region transposes the matrix so an operator
    // debugging a stuck region can see all subs that hit it at a glance.
    const [liveGrouping, setLiveGrouping] = React.useState("sub");
    // Auto-advance to "result" when submit completes — but ONLY for an
    // attempt that has actually started in this session. Previously the
    // effect fired the moment the user reached the submit step because
    // a stale `progressTotal > 0` from a prior session bounced them off.
    React.useEffect(() => {
        if (!attemptStartedAt)
            return;
        if (currentStep === "submit" &&
            !isRunning &&
            progressTotal > 0 &&
            progressDone >= progressTotal) {
            setStep("result");
        }
    }, [
        attemptStartedAt,
        currentStep,
        isRunning,
        progressTotal,
        progressDone,
        setStep,
    ]);
    // ---- Audit-log helper ----------------------------------------------------
    // Resolve a stable "actor" string from the first signed-in Azure
    // account, falling back to a synthetic label. Keeps the audit-log
    // entries grouped per-operator on the audit-log page.
    const auditActor = React.useMemo(() => {
        var _a, _b;
        const accounts = (_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [];
        const first = accounts[0];
        return (_b = first === null || first === void 0 ? void 0 : first.username) !== null && _b !== void 0 ? _b : "anonymous@local";
    }, [state.azureAccounts]);
    // ---- Submit + retry handlers ---------------------------------------------
    const requestSubmit = React.useCallback(() => {
        if (!configureValid) {
            setValidationError("Resolve configuration errors before submitting.");
            return;
        }
        if (dispatchPlan.length === 0) {
            setValidationError(skipExisting
                ? "All selected (subscription × region) pairs already exist. Untick \"Skip already-existing\" or pick different regions."
                : "No (subscription × region) pairs to dispatch.");
            return;
        }
        setConfirmHidden(false);
    }, [configureValid, dispatchPlan.length, skipExisting]);
    // Per-sub progress so the UI can show "Sub 2/5 in progress — waiting
    // 30 s before next dispatch" instead of a single opaque spinner that
    // runs for minutes when many subs are selected.
    const [subBatchProgress, setSubBatchProgress] = React.useState(null);
    const handleConfirmCreate = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _d, _e, _f, _g;
        setConfirmHidden(true);
        setIsRunning(true);
        setSubmitError(null);
        setLastAttemptDurationMs(null);
        const attemptStart = new Date();
        const newId = newAttemptId();
        setAttemptStartedAt(attemptStart.toISOString());
        setAttemptId(newId);
        // Fresh AbortController for this submit run. Stop button can call
        // .abort() on it to bail the inter-sub wait early; the orchestrator
        // cancel still happens via orchestrator.cancel().
        (_d = submitAbortRef.current) === null || _d === void 0 ? void 0 : _d.abort();
        const ac = new AbortController();
        submitAbortRef.current = ac;
        // Build per-sub dispatch list from the plan so we honour
        // `skipExisting`. Subs whose every region is already created end up
        // with an empty array and are silently skipped (no orchestrator
        // call, no audit-noise).
        const subs = effectiveSubscriptionIds.filter((s) => { var _a, _b; return ((_b = (_a = dispatchPerSub.get(s)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > 0; });
        const delayMs = Math.max(30, Math.min(60, perSubDelaySec)) * 1000;
        const errors = [];
        let cancelled = false;
        // Seed the persisted resume hint so a hard-reload mid-run can
        // surface a banner on the configure step. Cleared on
        // completion / cancel. Per `_bypass_modify_delete.md` § audit-
        // reconstruction — even an interrupted run should leave breadcrumbs.
        setResumeHint({
            attemptId: newId,
            attemptStartedAt: attemptStart.toISOString(),
            completedSubs: 0,
            totalSubs: subs.length,
            currentSubId: (_e = subs[0]) !== null && _e !== void 0 ? _e : null,
        });
        // Compute the unique tenant id set the run spans — useful in the
        // audit log so a defender can scope ARM-write-throttle alerts back
        // to a single operator action that hit N tenants.
        const tenantIdsSet = new Set();
        for (const sid of subs) {
            const known = state.subscriptions.find((s) => s.subscriptionId === sid);
            if (known === null || known === void 0 ? void 0 : known.tenantId)
                tenantIdsSet.add(known.tenantId);
        }
        const tenantIds = Array.from(tenantIdsSet);
        // Token expiry at submit — if a defender investigates a 401 burst,
        // they can immediately tell whether the token was already
        // near-expiry when the operator clicked Create.
        const tokenExpirySecAtSubmit = armTokenTracker.secondsUntilExpiry;
        // Audit the submit at the start of the run — captures the intent
        // even if the run is cancelled or partially fails. Result counters
        // are recorded on completion below. Payload enriched per
        // `_bypass_modify_delete.md`: a defender reviewing the trail must
        // be able to reconstruct the full operator intent (what, where,
        // when, with which token, against which tenants).
        auditLog.record({
            actor: auditActor,
            action: "provision_accounts.submit",
            target: `subs:${subs.length} regions:${selectedRegions.length} dispatch:${dispatchPlan.length}`,
            status: "success",
            details: {
                attemptId: newId,
                subscriptionIds: subs,
                tenantIds,
                regions: selectedRegions,
                perSubDelaySec,
                skipExisting,
                skippedExistingCount,
                dispatchTotal: dispatchPlan.length,
                // Preview first 10 (sub, region) pairs verbatim so the
                // defender doesn't have to cross-reference subs+regions to
                // reconstruct intent. Bounded to avoid blowing the audit row.
                dispatchPlanPreview: dispatchPlan.slice(0, 10),
                tokenExpirySecAtSubmit,
                userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
            },
        });
        for (let i = 0; i < subs.length; i++) {
            if (ac.signal.aborted) {
                cancelled = true;
                break;
            }
            const sub = subs[i];
            const regionsForSub = (_f = dispatchPerSub.get(sub)) !== null && _f !== void 0 ? _f : selectedRegions;
            setSubBatchProgress({
                completed: i,
                total: subs.length,
                currentSubId: sub,
                waiting: false,
                waitingUntil: null,
            });
            try {
                // Forward the AbortSignal to the orchestrator so the in-flight
                // ARM PUT for this sub is cancelled when Stop is pressed,
                // rather than only cancelling the inter-sub wait. The
                // orchestrator's `execute()` reads `params.signal` (see
                // orchestrator-agent.ts:579) and wires it into the cancellation
                // tracker so the agent-side fetch is aborted too. Without this
                // forwarding, Stop would let the current region finish before
                // the loop bailed.
                yield orchestrator.execute({
                    action: "create_accounts",
                    payload: {
                        subscriptionId: sub,
                        regions: regionsForSub,
                    },
                    signal: ac.signal,
                });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                // Don't record AbortError-style cancellations as errors; the
                // user explicitly asked to stop.
                if (!ac.signal.aborted) {
                    errors.push({ subscriptionId: sub, error: message });
                }
            }
            if (ac.signal.aborted) {
                cancelled = true;
                break;
            }
            // Update the persisted resume hint after each sub completes so
            // a hard reload sees the right "X of Y done" state.
            setResumeHint({
                attemptId: newId,
                attemptStartedAt: attemptStart.toISOString(),
                completedSubs: i + 1,
                totalSubs: subs.length,
                currentSubId: (_g = subs[i + 1]) !== null && _g !== void 0 ? _g : null,
            });
            // Inter-sub delay. Skip for the last sub — no one's waiting.
            // Cancellable via AbortController so a Stop click halts the wait
            // immediately rather than letting it run to completion.
            if (i < subs.length - 1) {
                const until = Date.now() + delayMs;
                setSubBatchProgress({
                    completed: i + 1,
                    total: subs.length,
                    currentSubId: sub,
                    waiting: true,
                    waitingUntil: until,
                });
                const wait = yield abortableDelay(delayMs, ac.signal);
                if (wait.cancelled) {
                    cancelled = true;
                    break;
                }
            }
        }
        setSubBatchProgress({
            completed: subs.length,
            total: subs.length,
            currentSubId: null,
            waiting: false,
            waitingUntil: null,
        });
        if (errors.length > 0) {
            setSubmitError(errors
                .map((e) => { var _a; return `${((_a = e.subscriptionId) !== null && _a !== void 0 ? _a : "").slice(0, 8)}…: ${e.error}`; })
                .join(" · "));
        }
        if (cancelled && errors.length === 0) {
            setSubmitError("Stopped before all subscriptions finished. Already-running orchestrator dispatches will continue server-side.");
        }
        const elapsedMs = Date.now() - attemptStart.getTime();
        setLastAttemptDurationMs(elapsedMs);
        if (submitAbortRef.current === ac)
            submitAbortRef.current = null;
        setIsRunning(false);
        // Clear the resume hint — the run is no longer in flight, even if
        // it cancelled / errored partway through. The audit log retains
        // the full breadcrumb trail for forensic reconstruction.
        setResumeHint(null);
        // Audit completion — surface whether the run finished, was
        // cancelled, or accrued errors so the audit-log page paints the
        // correct status badge. We classify the outcome from the same
        // signals the UI uses (errors[] / cancelled / dispatch total).
        auditLog.record({
            actor: auditActor,
            action: "provision_accounts.complete",
            target: `subs:${subs.length} regions:${selectedRegions.length}`,
            status: errors.length === 0 && !cancelled ? "success" : "failure",
            details: {
                attemptId: newId,
                tenantIds,
                elapsedMs,
                cancelled,
                errorsCount: errors.length,
                errors: errors.slice(0, 5),
                dispatchTotal: dispatchPlan.length,
            },
            error: errors.length > 0
                ? errors.map((e) => `${e.subscriptionId}: ${e.error}`).join(" · ")
                : cancelled
                    ? "Stopped by operator"
                    : undefined,
        });
    }), [
        orchestrator,
        effectiveSubscriptionIds,
        dispatchPerSub,
        selectedRegions,
        perSubDelaySec,
        auditActor,
        dispatchPlan,
        skipExisting,
        skippedExistingCount,
        state.subscriptions,
        armTokenTracker.secondsUntilExpiry,
        setResumeHint,
    ]);
    // Stop = abort the inter-sub timer + tell the orchestrator to bail
    // mid-region. Both signals fire; whichever the loop is sitting on
    // gets the message. We also audit the explicit stop so the audit-log
    // can correlate the operator's intent with the per-region failures
    // that follow. Audit payload includes the `attemptId` so a defender
    // can group the stop event with the originating submit / complete
    // pair (per `_bypass_modify_delete.md` § audit-reconstruction).
    const handleStop = React.useCallback(() => {
        var _a;
        (_a = submitAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        orchestrator.cancel();
        auditLog.record({
            actor: auditActor,
            action: "provision_accounts.stop",
            target: `subs:${effectiveSubscriptionIds.length}`,
            status: "success",
            details: { attemptId },
        });
    }, [orchestrator, auditActor, effectiveSubscriptionIds.length, attemptId]);
    const handleDiscover = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _h;
        // Discover walks one subscription at a time. When the operator has
        // picked several from the dropdown we run them sequentially with the
        // same inter-sub delay used by create — keeps the import experience
        // symmetric with create and avoids hammering ARM's per-tenant read
        // throttle when listing Batch accounts across many tenants.
        const subs = effectiveSubscriptionIds;
        if (subs.length === 0) {
            setValidationError("Subscription ID is required.");
            return;
        }
        if (state.subscriptions.length === 0 &&
            selectedSubIds.length === 0 &&
            !isValidSubscriptionId(subscriptionId)) {
            setValidationError("Subscription ID must be a valid UUID.");
            return;
        }
        setValidationError(null);
        setIsDiscovering(true);
        setDiscoverError(null);
        const delayMs = Math.max(30, Math.min(60, perSubDelaySec)) * 1000;
        const errors = [];
        auditLog.record({
            actor: auditActor,
            action: "import_accounts.discover",
            target: `subs:${subs.length}`,
            status: "success",
            details: { subscriptionIds: subs, perSubDelaySec },
        });
        // Discover gets the same abort plumbing as create — same Stop
        // behaviour applies if the operator picks dozens of subs and
        // changes their mind mid-run.
        const ac = new AbortController();
        (_h = submitAbortRef.current) === null || _h === void 0 ? void 0 : _h.abort();
        submitAbortRef.current = ac;
        try {
            for (let i = 0; i < subs.length; i++) {
                if (ac.signal.aborted)
                    break;
                const sub = subs[i];
                try {
                    yield orchestrator.execute({
                        action: "discover_accounts",
                        payload: { subscriptionId: sub.trim() },
                        // Forward the discover loop's abort so the orchestrator's
                        // in-flight Microsoft.Batch listing cancels mid-call rather
                        // than running to completion after Stop. Same plumbing as
                        // create_accounts — the orchestrator's `cancel()` API is a
                        // belt-and-braces backup, not the primary cancellation
                        // path.
                        signal: ac.signal,
                    });
                }
                catch (err) {
                    if (!ac.signal.aborted) {
                        const message = err instanceof Error ? err.message : String(err);
                        errors.push({ subscriptionId: sub, error: message });
                    }
                }
                if (i < subs.length - 1) {
                    const wait = yield abortableDelay(delayMs, ac.signal);
                    if (wait.cancelled)
                        break;
                }
            }
            if (errors.length > 0) {
                setDiscoverError(errors
                    .map((e) => { var _a; return `${((_a = e.subscriptionId) !== null && _a !== void 0 ? _a : "").slice(0, 8)}…: ${e.error}`; })
                    .join(" · "));
            }
            auditLog.record({
                actor: auditActor,
                action: "import_accounts.complete",
                target: `subs:${subs.length}`,
                status: errors.length === 0 ? "success" : "failure",
                details: { errorsCount: errors.length, errors: errors.slice(0, 5) },
                error: errors.length > 0
                    ? errors.map((e) => `${e.subscriptionId}: ${e.error}`).join(" · ")
                    : undefined,
            });
        }
        finally {
            if (submitAbortRef.current === ac)
                submitAbortRef.current = null;
            setIsDiscovering(false);
        }
    }), [
        orchestrator,
        effectiveSubscriptionIds,
        selectedSubIds.length,
        subscriptionId,
        state.subscriptions.length,
        perSubDelaySec,
        auditActor,
    ]);
    const handleStopDiscover = React.useCallback(() => {
        var _a;
        (_a = submitAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        orchestrator.cancel();
        auditLog.record({
            actor: auditActor,
            action: "import_accounts.stop",
            target: `subs:${effectiveSubscriptionIds.length}`,
            status: "success",
        });
    }, [orchestrator, auditActor, effectiveSubscriptionIds.length]);
    const handleRetryFailed = React.useCallback(() => {
        const ids = store.retryFailedAccounts();
        store.addNotification({
            type: "info",
            message: `Retrying ${ids.length} failed account(s)...`,
            autoDismissMs: 5000,
        });
        auditLog.record({
            actor: auditActor,
            action: "provision_accounts.retry_failed",
            target: `count:${ids.length}`,
            status: "success",
            details: { retriedAccountIds: ids.slice(0, 20) },
        });
    }, [store, auditActor]);
    const subscriptionFieldId = React.useId();
    const regionFieldId = React.useId();
    const skipExistingId = React.useId();
    const perSubDelayId = React.useId();
    // ESC handler — only active while a submit or discover loop is in
    // flight. We let Radix dialogs / dropdowns swallow ESC normally, and
    // only step in when an in-flight operation could be aborted.
    // `preventDefault` is kept on so the keystroke doesn't bubble to
    // arbitrary keyboard listeners further up the tree.
    const handleEscCancel = React.useCallback(() => {
        setEscCancelHidden(false);
    }, []);
    useShortcut("Escape", handleEscCancel, {
        enabled: isRunning || isDiscovering,
        preventDefault: false,
        allowInInputs: true,
    });
    // Ctrl/Cmd+Enter — submit when the operator is on the Submit step
    // (or Review, jumping forward one step). Gated on `configureValid &&
    // canPassPreflight && dispatchPlan.length > 0` and `!isRunning` so
    // a hot-keyboarded operator can't bypass disabled-state checks.
    // Disabled while a run is in flight or a destructive dialog is open.
    const canHotkeySubmit = !isRunning &&
        configureValid &&
        canPassPreflight &&
        dispatchPlan.length > 0 &&
        confirmHidden &&
        escCancelHidden;
    const handleHotkeySubmit = React.useCallback((e) => {
        var _a, _b;
        // Avoid hijacking Ctrl+Enter when the user is typing a newline
        // in a textarea / contenteditable. The current page has no
        // textareas, but defensive.
        const tag = (_b = (_a = e.target) === null || _a === void 0 ? void 0 : _a.tagName) === null || _b === void 0 ? void 0 : _b.toLowerCase();
        if (tag === "textarea")
            return;
        if (currentStep === "submit" || currentStep === "review") {
            e.preventDefault();
            if (currentStep === "review")
                setStep("submit");
            requestSubmit();
        }
    }, [currentStep, setStep, requestSubmit]);
    useShortcut("Mod+Enter", handleHotkeySubmit, {
        enabled: canHotkeySubmit,
        preventDefault: false,
        allowInInputs: true,
    });
    // Also bind plain Ctrl+Enter on non-Mac users; `Mod+` already maps
    // to Ctrl off-Mac, so this is a defensive alias for keyboards that
    // report Ctrl explicitly under different layouts.
    useShortcut("Ctrl+Enter", handleHotkeySubmit, {
        enabled: canHotkeySubmit,
        preventDefault: false,
        allowInInputs: true,
    });
    // Arrow keys → walk enabled wizard steps. Skip-over disabled steps
    // so an operator who hasn't passed preflight can't accidentally land
    // on submit. Disabled while a run is in flight (the operator should
    // be watching, not navigating).
    const walkStep = React.useCallback((dir) => {
        const idx = STEP_ORDER.indexOf(currentStep);
        let next = idx + dir;
        while (next >= 0 && next < STEP_ORDER.length) {
            const candidate = STEP_ORDER[next];
            if (!isStepDisabled(candidate)) {
                setStep(candidate);
                return;
            }
            next += dir;
        }
    }, [currentStep, isStepDisabled, setStep]);
    useShortcut("ArrowLeft", () => walkStep(-1), {
        enabled: !isRunning && !isDiscovering && activeTab === "create",
        preventDefault: false,
        // No allowInInputs — we don't want to hijack arrow keys inside
        // text inputs and the region/sub filter boxes.
    });
    useShortcut("ArrowRight", () => walkStep(1), {
        enabled: !isRunning && !isDiscovering && activeTab === "create",
        preventDefault: false,
    });
    const handleEscCancelConfirm = React.useCallback(() => {
        var _a;
        setEscCancelHidden(true);
        (_a = submitAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
        orchestrator.cancel();
        auditLog.record({
            actor: auditActor,
            action: "provision_accounts.esc_cancel",
            target: `running:${isRunning ? "1" : "0"} discovering:${isDiscovering ? "1" : "0"}`,
            status: "success",
            details: { attemptId },
        });
    }, [orchestrator, auditActor, isRunning, isDiscovering, attemptId]);
    // ---- Subscription selector (shared) --------------------------------------
    // Group the picker by owning Azure account when multiple operators are
    // signed in. Each option shows: sub display name, prefix of subId, and
    // (when the same browser has more than one signed-in account) the
    // owner account name as a secondary label. This is the multi-account
    // unblock — without it the dropdown only ever showed the primary
    // account's subs, so an operator with two signed-in accounts couldn't
    // pick a sub that belonged to the non-primary one.
    const filteredSubscriptions = React.useMemo(() => {
        const q = subFilter.trim().toLowerCase();
        if (!q)
            return state.subscriptions;
        return state.subscriptions.filter((s) => {
            var _a;
            return (s.displayName.toLowerCase().includes(q) ||
                s.subscriptionId.toLowerCase().includes(q) ||
                ((_a = s.ownerAccountLabel) !== null && _a !== void 0 ? _a : "").toLowerCase().includes(q));
        });
    }, [state.subscriptions, subFilter]);
    const subscriptionGroups = React.useMemo(() => {
        var _a;
        const groups = new Map();
        for (const s of filteredSubscriptions) {
            const key = s.ownerAccountLabel || s.homeAccountId || "Active account";
            const list = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : [];
            list.push(s);
            groups.set(key, list);
        }
        return Array.from(groups.entries());
    }, [filteredSubscriptions]);
    const showOwnerGroups = subscriptionGroups.length > 1;
    // Detect subs that share both `displayName` and `ownerAccountLabel` —
    // happens when the same provisioning script ran under two different
    // signed-in AAD identities that ALSO share a display name (e.g.
    // "Sub for Provisioned User 5" / "Provisioned User 5"). They are
    // functionally distinct (different subscriptionId + homeAccountId,
    // tokens route correctly), but the picker rendered them as visually
    // identical chips. We tag the duplicates here and append a
    // homeAccountId suffix at render time so the operator can tell them
    // apart. Computed once over the FULL list so the dedupe doesn't
    // depend on the search filter narrowing things.
    const ambiguousSubIds = React.useMemo(() => {
        var _a, _b, _c, _d;
        const counts = new Map();
        const ids = new Set();
        for (const s of state.subscriptions) {
            const key = `${s.displayName} ${(_a = s.ownerAccountLabel) !== null && _a !== void 0 ? _a : ""}`;
            counts.set(key, ((_b = counts.get(key)) !== null && _b !== void 0 ? _b : 0) + 1);
        }
        for (const s of state.subscriptions) {
            const key = `${s.displayName} ${(_c = s.ownerAccountLabel) !== null && _c !== void 0 ? _c : ""}`;
            if (((_d = counts.get(key)) !== null && _d !== void 0 ? _d : 0) > 1)
                ids.add(s.subscriptionId);
        }
        return ids;
    }, [state.subscriptions]);
    // Quick-pick "select all visible" / "clear" for the subs dropdown so
    // an operator with 12 visible subs doesn't have to click 12 times.
    const visibleSubIds = React.useMemo(() => filteredSubscriptions.map((s) => s.subscriptionId), [filteredSubscriptions]);
    const allVisibleSelected = visibleSubIds.length > 0 &&
        visibleSubIds.every((id) => selectedSubIds.includes(id));
    const selectAllVisibleSubs = React.useCallback(() => {
        setSelectedSubIds((prev) => Array.from(new Set([...prev, ...visibleSubIds])));
        setAutoSelectedSubscription(false);
        setValidationError(null);
    }, [visibleSubIds]);
    const clearAllSubs = React.useCallback(() => {
        setSelectedSubIds([]);
        setAutoSelectedSubscription(false);
    }, []);
    const subscriptionSelector = (React.createElement("div", { className: "flex flex-col gap-1.5 max-w-[28rem]" },
        React.createElement(Label, { htmlFor: subscriptionFieldId }, state.subscriptions.length > 0
            ? `Subscriptions${selectedSubIds.length > 0 ? ` (${selectedSubIds.length} selected)` : ""}`
            : "Subscription ID"),
        state.subscriptions.length > 0 ? (React.createElement(DropdownMenu, null,
            React.createElement(DropdownMenuTrigger, { asChild: true },
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", id: subscriptionFieldId, "aria-label": "Azure subscriptions", className: "justify-between" },
                    React.createElement("span", { className: "truncate" }, selectedSubIds.length === 0
                        ? "Pick one or more subscriptions"
                        : selectedSubIds.length === 1
                            ? (_c = (_b = state.subscriptions.find((s) => s.subscriptionId === selectedSubIds[0])) === null || _b === void 0 ? void 0 : _b.displayName) !== null && _c !== void 0 ? _c : selectedSubIds[0]
                            : `${selectedSubIds.length} subscription${selectedSubIds.length === 1 ? "" : "s"} selected`),
                    React.createElement("span", { className: "ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-2xs font-semibold text-primary" }, selectedSubIds.length))),
            React.createElement(DropdownMenuContent, { align: "start", className: "max-h-80 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto", 
                // Keep typing focused in the search box without the
                // dropdown stealing keystrokes for its own type-ahead.
                onCloseAutoFocus: (e) => e.preventDefault() },
                React.createElement("div", { className: "sticky top-0 z-10 -mx-1 mb-1 bg-popover px-2 py-1.5" },
                    React.createElement("div", { className: "relative" },
                        React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                        React.createElement(Input, { value: subFilter, onChange: (e) => setSubFilter(e.target.value), placeholder: `Filter ${state.subscriptions.length} subs…`, "aria-label": "Filter subscriptions", className: "h-7 pl-7 text-xs", 
                            // Stop dropdown type-ahead from intercepting characters.
                            onKeyDown: (e) => e.stopPropagation(), autoFocus: true })),
                    React.createElement("div", { className: "mt-1.5 flex items-center justify-between gap-2" },
                        React.createElement("div", { className: "flex items-center gap-1" },
                            React.createElement("button", { type: "button", onClick: selectAllVisibleSubs, disabled: visibleSubIds.length === 0 || allVisibleSelected, className: "rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-2xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50", "aria-label": "Select all visible subscriptions" },
                                "Select visible (",
                                visibleSubIds.length,
                                ")"),
                            React.createElement("button", { type: "button", onClick: clearAllSubs, disabled: selectedSubIds.length === 0, className: "rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-2xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50", "aria-label": "Clear all selected subscriptions" }, "Clear")),
                        React.createElement("span", { className: "text-2xs text-muted-foreground tabular-nums" },
                            selectedSubIds.length,
                            " / ",
                            state.subscriptions.length))),
                filteredSubscriptions.length === 0 ? (React.createElement("div", { className: "px-2 py-3 text-center text-2xs text-muted-foreground" },
                    "No subscriptions match \u201C",
                    subFilter,
                    "\u201D.")) : (subscriptionGroups.flatMap(([owner, subs]) => {
                    var _a;
                    const items = [];
                    if (showOwnerGroups) {
                        items.push(React.createElement(DropdownMenuLabel, { key: `hdr-${owner}`, className: "text-2xs font-semibold uppercase tracking-wide text-muted-foreground" }, owner));
                    }
                    for (const s of subs) {
                        const checked = selectedSubIds.includes(s.subscriptionId);
                        const isAmbiguous = ambiguousSubIds.has(s.subscriptionId);
                        items.push(React.createElement(DropdownMenuCheckboxItem, { key: s.subscriptionId, checked: checked, onSelect: (e) => e.preventDefault(), onCheckedChange: () => toggleSubSelection(s.subscriptionId) },
                            React.createElement("span", { className: "font-medium" }, s.displayName),
                            React.createElement("span", { className: "ml-2 font-mono text-2xs text-muted-foreground" },
                                s.subscriptionId.substring(0, 8),
                                "\u2026"),
                            isAmbiguous && s.homeAccountId && (React.createElement("span", { className: "ml-2 inline-flex items-center rounded-sm bg-warning/15 px-1 font-mono text-2xs text-warning", title: `Disambiguator: homeAccountId ${s.homeAccountId}` },
                                "acct ",
                                ((_a = s.homeAccountId) !== null && _a !== void 0 ? _a : "").slice(0, 6),
                                "\u2026"))));
                    }
                    return items;
                }))))) : (React.createElement(Input, { id: subscriptionFieldId, value: subscriptionId, onChange: (e) => handleSubscriptionChange(e.target.value), placeholder: "Enter Azure subscription ID (run 'az login' to auto-load)", "aria-label": "Azure subscription ID", autoComplete: "off", spellCheck: false })),
        autoSelectedSubscription && selectedSubIds.length === 1 && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Auto-selected your only subscription")),
        selectedSubIds.length > 0 && (React.createElement("div", { className: "mt-1 flex flex-wrap gap-1", "aria-label": "Selected subscriptions" }, selectedSubIds.map((id) => {
            var _a, _b, _c;
            const sub = state.subscriptions.find((s) => s.subscriptionId === id);
            const isAmbiguous = ambiguousSubIds.has(id);
            return (React.createElement("span", { key: id, className: "inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground", title: `subscriptionId ${id}${(sub === null || sub === void 0 ? void 0 : sub.homeAccountId) ? ` · homeAccountId ${sub.homeAccountId}` : ""}` },
                React.createElement("span", { className: "font-medium" }, (_a = sub === null || sub === void 0 ? void 0 : sub.displayName) !== null && _a !== void 0 ? _a : id.slice(0, 8) + "…"),
                React.createElement("span", { className: "font-mono text-muted-foreground" },
                    id.slice(0, 8),
                    "\u2026"),
                React.createElement(CopyChip, { value: id, label: "subscription id" }),
                showOwnerGroups && (sub === null || sub === void 0 ? void 0 : sub.ownerAccountLabel) && (React.createElement("span", { className: "text-muted-foreground" },
                    "\u00B7 ",
                    sub.ownerAccountLabel)),
                isAmbiguous && (sub === null || sub === void 0 ? void 0 : sub.homeAccountId) && (React.createElement("span", { className: "font-mono text-warning" },
                    "(acct ",
                    ((_b = sub.homeAccountId) !== null && _b !== void 0 ? _b : "").slice(0, 6),
                    "\u2026)")),
                React.createElement("button", { type: "button", onClick: () => toggleSubSelection(id), className: "rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": `Remove ${(_c = sub === null || sub === void 0 ? void 0 : sub.displayName) !== null && _c !== void 0 ? _c : id}` },
                    React.createElement("span", { "aria-hidden": true }, "x"))));
        }))),
        selectedSubIds.length > 1 && (React.createElement("div", { className: "mt-2 flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2.5" },
            React.createElement(Label, { htmlFor: perSubDelayId, className: "flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground" },
                "Delay between subscriptions",
                React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement(Info, { className: "h-3 w-3 text-muted-foreground/80 hover:text-foreground", "aria-label": "About the per-subscription delay" })),
                    React.createElement(TooltipContent, { side: "top", className: "max-w-xs" }, "ARM enforces per-tenant write throttles. Spacing dispatches 30\u201360 s apart keeps batch creation under the 1200-writes/h budget on the tenants that host the picked subs.")),
                React.createElement("span", { className: "ml-auto font-mono text-2xs text-foreground" },
                    perSubDelaySec,
                    "s")),
            React.createElement(Input, { id: perSubDelayId, type: "range", min: 30, max: 60, step: 5, value: perSubDelaySec, onChange: (ev) => {
                    const v = Number(ev.target.value);
                    if (Number.isFinite(v)) {
                        setPerSubDelaySec(Math.max(30, Math.min(60, Math.floor(v))));
                    }
                }, "aria-label": "Per-subscription delay seconds", className: "h-2 cursor-pointer accent-primary" }),
            React.createElement("span", { className: "text-2xs text-muted-foreground leading-relaxed" }, "After each subscription finishes its create_accounts run, the page waits this long before starting the next \u2014 keeps ARM's per-tenant write throttle happy when fanning out across many subs. Range 30\u201360 s.")))));
    // Resolve every effective sub id into a display object so the review
    // step and confirmation dialog can show meaningful names instead of
    // raw GUIDs. For the typed-input fallback we synthesize a minimal
    // entry so the same render path works regardless of input mode.
    const effectiveSubscriptionDetails = React.useMemo(() => {
        return effectiveSubscriptionIds.map((id) => {
            var _a;
            const known = state.subscriptions.find((s) => s.subscriptionId === id);
            return {
                subscriptionId: id,
                displayName: (_a = known === null || known === void 0 ? void 0 : known.displayName) !== null && _a !== void 0 ? _a : "(custom)",
                ownerAccountLabel: known === null || known === void 0 ? void 0 : known.ownerAccountLabel,
            };
        });
    }, [effectiveSubscriptionIds, state.subscriptions]);
    const atMaxRegions = selectedRegions.length >= DEFAULT_CONFIG.maxRegionsPerRequest;
    // (confirmMessage + totalToCreate are now memoized at component
    // scope above so they don't rebuild on every parent render. See
    // the `React.useMemo` block before `renderConfigure`.)
    // Step-elapsed chip — rendered in each step's CardHeader. Re-renders
    // every ~5s via the `stepEnteredAt` effect ticker above so it stays
    // fresh without forcing a 1Hz re-render of the whole page. Hidden
    // when the operator is mid-run (the submit progress already shows
    // a wall-clock).
    const stepElapsedSec = Math.floor((Date.now() - stepEnteredAt) / 1000);
    const stepElapsedChip = !isRunning && stepElapsedSec > 5 ? (React.createElement("span", { className: "inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs text-muted-foreground tabular-nums", title: `Time on this step (since you last navigated to it)`, "aria-label": `Time on this step: ${formatEta(stepElapsedSec)}` },
        React.createElement(Loader2, { className: "h-2.5 w-2.5", "aria-hidden": true }),
        formatEta(stepElapsedSec),
        " on step")) : null;
    // ---- DataTable for provisioned accounts ----------------------------------
    // Scope to the current attempt so the result table doesn't bleed in
    // accounts from prior submissions or imports — only the rows relevant
    // to *this* request show up here.
    const provisionedRows = React.useMemo(() => attemptAccounts.map((a, idx) => {
        var _a, _b;
        return ({
            id: (_a = a.id) !== null && _a !== void 0 ? _a : `${a.region}-${a.accountName}-${idx}`,
            region: a.region,
            accountName: a.accountName,
            resourceGroup: a.resourceGroup,
            subscriptionId: a.subscriptionId,
            provisioningState: a.provisioningState,
            error: (_b = a.error) !== null && _b !== void 0 ? _b : undefined,
        });
    }), [attemptAccounts]);
    // For the import-tab table we still want ALL accounts (not scoped to
    // an attempt), since import has no notion of an attempt start.
    const importedRows = React.useMemo(() => state.accounts.map((a, idx) => {
        var _a, _b;
        return ({
            id: (_a = a.id) !== null && _a !== void 0 ? _a : `${a.region}-${a.accountName}-${idx}`,
            region: a.region,
            accountName: a.accountName,
            resourceGroup: a.resourceGroup,
            subscriptionId: a.subscriptionId,
            provisioningState: a.provisioningState,
            error: (_b = a.error) !== null && _b !== void 0 ? _b : undefined,
        });
    }), [state.accounts]);
    const provisionedColumns = React.useMemo(() => [
        {
            id: "region",
            header: "Region",
            cell: (r) => React.createElement("span", { className: "text-sm" }, r.region),
            sort: (a, b) => a.region.localeCompare(b.region),
            csv: (r) => r.region,
            json: { key: "region", value: (r) => r.region },
        },
        {
            id: "accountName",
            header: "Account Name",
            cell: (r) => (React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement("span", { className: "text-sm" }, r.accountName),
                React.createElement(CopyChip, { value: r.accountName, label: "account name" }))),
            sort: (a, b) => a.accountName.localeCompare(b.accountName),
            csv: (r) => r.accountName,
            json: { key: "accountName", value: (r) => r.accountName },
        },
        {
            id: "resourceGroup",
            header: "Resource Group",
            cell: (r) => (React.createElement("span", { className: "inline-flex items-center gap-1" },
                React.createElement("span", { className: "text-xs text-muted-foreground" }, r.resourceGroup),
                React.createElement(CopyChip, { value: r.resourceGroup, label: "resource group" }))),
            sort: (a, b) => a.resourceGroup.localeCompare(b.resourceGroup),
            csv: (r) => r.resourceGroup,
            json: { key: "resourceGroup", value: (r) => r.resourceGroup },
        },
        {
            id: "subscriptionId",
            header: "Subscription",
            cell: (r) => (React.createElement("span", { className: "inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground" },
                r.subscriptionId.slice(0, 8),
                "\u2026",
                React.createElement(CopyChip, { value: r.subscriptionId, label: "subscription id" }))),
            sort: (a, b) => a.subscriptionId.localeCompare(b.subscriptionId),
            csv: (r) => r.subscriptionId,
            json: { key: "subscriptionId", value: (r) => r.subscriptionId },
            defaultHidden: true,
        },
        {
            id: "status",
            header: "Status",
            cell: (r) => React.createElement(StatusBadge, { status: r.provisioningState }),
            sort: (a, b) => a.provisioningState.localeCompare(b.provisioningState),
            csv: (r) => r.provisioningState,
            json: { key: "status", value: (r) => r.provisioningState },
        },
        {
            id: "error",
            header: "Error",
            cell: (r) => r.error ? (React.createElement("span", { className: "text-xs text-destructive" }, r.error)) : null,
            csv: (r) => { var _a; return (_a = r.error) !== null && _a !== void 0 ? _a : ""; },
            json: { key: "error", value: (r) => { var _a; return (_a = r.error) !== null && _a !== void 0 ? _a : null; } },
        },
        {
            id: "portal",
            header: "",
            cell: (r) => (React.createElement("a", { href: azurePortalUrl({
                    subscriptionId: r.subscriptionId,
                    resourceGroup: r.resourceGroup,
                    accountName: r.accountName,
                }), target: "_blank", rel: "noopener noreferrer", className: "inline-flex items-center gap-1 rounded-sm px-1 text-2xs text-primary transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": `Open ${r.accountName} in Azure Portal` },
                React.createElement(ExternalLink, { className: "h-3 w-3", "aria-hidden": true }),
                "Portal")),
            width: "w-20",
            // Skip CSV/JSON — derived field, can be reconstructed from
            // the columns the operator already gets.
            json: false,
        },
    ], []);
    // ---- Result-step rollup (memoized at component scope) --------------------
    // Was previously an IIFE inside `renderResult()`, which meant it
    // recomputed on every parent render even when the operator was
    // sitting on another step. Hoist + memoize so it only changes when
    // its real inputs change.
    const perSubSummary = React.useMemo(() => {
        var _a, _b;
        const map = new Map();
        for (const a of attemptAccounts) {
            const known = state.subscriptions.find((s) => s.subscriptionId === a.subscriptionId);
            const entry = (_a = map.get(a.subscriptionId)) !== null && _a !== void 0 ? _a : {
                displayName: (_b = known === null || known === void 0 ? void 0 : known.displayName) !== null && _b !== void 0 ? _b : (a.subscriptionId ? a.subscriptionId.slice(0, 8) + "…" : "—"),
                created: 0,
                failed: 0,
                total: 0,
            };
            entry.total += 1;
            if (a.provisioningState === "created")
                entry.created += 1;
            if (a.provisioningState === "failed")
                entry.failed += 1;
            map.set(a.subscriptionId, entry);
        }
        return Array.from(map.entries()).map(([subscriptionId, v]) => (Object.assign({ subscriptionId }, v)));
    }, [attemptAccounts, state.subscriptions]);
    // Mid-run rollup transposed by region — drives the "Group by region"
    // toggle so the operator can see, per region, which subs already
    // landed and which are still pending. Computed only when the
    // grouping toggle is set; otherwise an empty array (cheap memo).
    const liveRegionSummary = React.useMemo(() => {
        var _a;
        if (liveGrouping !== "region")
            return [];
        const map = new Map();
        for (const r of selectedRegions) {
            // Total per region = number of subs that have this region in
            // their dispatch plan (post-skip).
            let totalForRegion = 0;
            for (const sid of effectiveSubscriptionIds) {
                const regions = (_a = dispatchPerSub.get(sid)) !== null && _a !== void 0 ? _a : selectedRegions;
                if (regions.includes(r))
                    totalForRegion += 1;
            }
            map.set(r, { created: 0, failed: 0, total: totalForRegion });
        }
        for (const a of attemptAccounts) {
            const entry = map.get(a.region);
            if (!entry)
                continue;
            if (a.provisioningState === "created")
                entry.created += 1;
            if (a.provisioningState === "failed")
                entry.failed += 1;
        }
        return Array.from(map.entries()).map(([region, v]) => (Object.assign({ region }, v)));
    }, [
        liveGrouping,
        selectedRegions,
        effectiveSubscriptionIds,
        dispatchPerSub,
        attemptAccounts,
    ]);
    // ---- Post-creation enumeration preview ----------------------------------
    // What an attacker (or any operator with Reader on the sub) will see
    // immediately after this run completes, via the equivalent of NetSPI
    // MicroBurst's `Get-AzBatchAccount` enumeration. Surfaces the
    // {accountName, region, resourceGroup, subscriptionId} quadruple per
    // planned account so the operator has informed consent at the
    // irreversible-action boundary. Corpus reference: NetSPI
    // `MicroBurst\AzureRM\Get-AzPasswords.ps1` and the
    // `Microsoft.Batch/batchAccounts` list pattern. We do NOT
    // hit ARM — this is a pure preview of what the dispatch plan will
    // create, mirroring the orchestrator's per-region account name
    // generator. Bounded to 12 rows so the dialog stays scannable.
    const enumerationPreview = React.useMemo(() => {
        var _a;
        const rows = [];
        for (const p of dispatchPlan) {
            const known = state.subscriptions.find((s) => s.subscriptionId === p.subscriptionId);
            // The orchestrator generates account names via the provisioner
            // agent. Use a stable, transparent pattern here so the operator
            // sees the SHAPE of what will be created. The actual name may
            // differ — we annotate "(orchestrator may suffix)" to keep
            // expectations correct without claiming we know the final name.
            rows.push({
                subscriptionId: p.subscriptionId,
                subscriptionLabel: (_a = known === null || known === void 0 ? void 0 : known.displayName) !== null && _a !== void 0 ? _a : p.subscriptionId.slice(0, 8) + "…",
                region: p.region,
                accountNamePattern: `batch${p.region}<6 hex>`,
                resourceGroupPattern: `rg-batch-${p.region}`,
            });
            if (rows.length >= 12)
                break;
        }
        return rows;
    }, [dispatchPlan, state.subscriptions]);
    // Memoize the confirmation-dialog message body. Previously rebuilt
    // on every parent render even when the dialog was hidden (which is
    // ~all the time). Pure-derivation, depends only on the visible
    // inputs.
    const confirmMessage = React.useMemo(() => (React.createElement("div", { className: "space-y-3 text-sm leading-relaxed" },
        React.createElement("p", { className: "m-0" },
            "You are about to create",
            " ",
            React.createElement("span", { className: "font-semibold text-foreground" },
                dispatchPlan.length,
                " Batch account",
                dispatchPlan.length === 1 ? "" : "s"),
            effectiveSubscriptionIds.length > 1 && (React.createElement(React.Fragment, null,
                " ",
                "across ",
                effectiveSubscriptionIds.length,
                " subscriptions \u00D7",
                " ",
                selectedRegions.length,
                " region",
                selectedRegions.length === 1 ? "" : "s")),
            skippedExistingCount > 0 && (React.createElement(React.Fragment, null,
                " ",
                React.createElement("span", { className: "text-muted-foreground" },
                    "(skipping ",
                    skippedExistingCount,
                    " existing)"))),
            ":"),
        effectiveSubscriptionIds.length > 1 && (React.createElement("div", { className: "rounded-md border border-border bg-surface-sunken/60 px-3 py-2 text-xs" },
            React.createElement("div", { className: "font-semibold text-foreground" }, "Subscriptions"),
            React.createElement("ul", { className: "mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground" }, effectiveSubscriptionDetails.map((s) => {
                var _a, _b;
                const regionsForSub = (_a = dispatchPerSub.get(s.subscriptionId)) !== null && _a !== void 0 ? _a : [];
                return (React.createElement("li", { key: s.subscriptionId },
                    React.createElement("span", { className: "text-foreground" }, s.displayName),
                    " ",
                    React.createElement("span", { className: "font-mono" },
                        ((_b = s.subscriptionId) !== null && _b !== void 0 ? _b : "").slice(0, 8),
                        "\u2026"),
                    s.ownerAccountLabel && (React.createElement("span", null,
                        " \u00B7 ",
                        s.ownerAccountLabel)),
                    React.createElement("span", { className: "ml-1 text-2xs" },
                        "(",
                        regionsForSub.length,
                        " region",
                        regionsForSub.length === 1 ? "" : "s",
                        ")")));
            })))),
        React.createElement("div", { className: "max-h-20 overflow-y-auto rounded-md border border-border bg-surface-sunken/60 px-3 py-2 text-xs text-muted-foreground" },
            React.createElement("span", { className: "font-semibold text-foreground" }, "Regions:"),
            " ",
            selectedRegions.join(", ")),
        effectiveSubscriptionIds.length > 1 && (React.createElement(Alert, { variant: "info", className: "px-3 py-2 text-xs" },
            React.createElement(Info, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertDescription, { className: "text-xs leading-relaxed" },
                "Subscriptions are processed sequentially with a",
                " ",
                React.createElement("span", { className: "font-semibold" },
                    perSubDelaySec,
                    "s delay"),
                " ",
                "between each. Estimated wall-clock minimum:",
                " ",
                React.createElement("span", { className: "font-mono" }, formatEta((effectiveSubscriptionIds.length - 1) * perSubDelaySec)),
                " ",
                "of inter-sub wait plus per-region creation time."))),
        React.createElement(Alert, { variant: "warning", className: "px-3 py-2 text-xs" },
            React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertDescription, { className: "text-xs leading-relaxed" }, "Each account incurs Azure storage and management overhead. Costs scale with the number of pools and nodes you later attach.")),
        React.createElement(Alert, { variant: "destructive", className: "px-3 py-2 text-xs" },
            React.createElement(AlertCircle, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertDescription, { className: "text-xs leading-relaxed" },
                React.createElement("span", { className: "font-semibold" }, "This action is irreversible from this UI."),
                " ",
                "Account and resource group cleanup must be performed manually in the Azure portal or via CLI.")))), [
        dispatchPlan.length,
        effectiveSubscriptionIds.length,
        effectiveSubscriptionDetails,
        selectedRegions,
        skippedExistingCount,
        perSubDelaySec,
        dispatchPerSub,
    ]);
    // `totalToCreate` is a stable derivation of the same plan and is
    // re-used below in the Submit button label and the dialog confirmText.
    const totalToCreate = dispatchPlan.length;
    // ---- Step body renderers --------------------------------------------------
    const renderConfigure = () => {
        const filterQuery = regionFilter.trim().toLowerCase();
        // Group regions by GPU availability so the operator can jump straight
        // to the bucket they need. Preserves the original within-group
        // ordering of AZURE_REGIONS, so long-standing muscle memory (US first,
        // then Europe, then APAC) still works. Filter is applied here so the
        // empty-state message shows the right count.
        const matchFilter = (r) => !filterQuery ||
            r.toLowerCase().includes(filterQuery) ||
            (isGpuRegion(r) && "v100h100gpu".includes(filterQuery));
        const gpu = [];
        const noGpu = [];
        for (const r of AZURE_REGIONS) {
            if (!matchFilter(r))
                continue;
            (isGpuRegion(r) ? gpu : noGpu).push(r);
        }
        const totalMatching = gpu.length + noGpu.length;
        const renderRegion = (r) => {
            const checked = selectedRegions.includes(r);
            return (React.createElement(DropdownMenuCheckboxItem, { key: r, checked: checked, onSelect: (e) => e.preventDefault(), onCheckedChange: (c) => {
                    const next = c
                        ? [...selectedRegions, r]
                        : selectedRegions.filter((x) => x !== r);
                    handleRegionsChange(next);
                } },
                r,
                isGpuRegion(r) && (React.createElement("span", { className: "ml-2 inline-flex items-center rounded-sm bg-primary/15 px-1 text-[0.625rem] font-semibold text-primary" }, "GPU"))));
        };
        return (React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
                    React.createElement("div", { className: "flex flex-col gap-0.5" },
                        React.createElement(CardTitle, { className: "text-sm font-semibold uppercase tracking-wider text-muted-foreground" }, "Configuration"),
                        React.createElement(CardDescription, null, "Choose a subscription and target regions. Each region creates one Batch account.")),
                    stepElapsedChip)),
            React.createElement(CardContent, { className: "flex flex-col gap-4" },
                resumeHint && resumeHint.attemptId !== attemptId && (React.createElement(Alert, { variant: "warning", className: "px-3 py-2 text-xs", role: "alert" },
                    React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                    React.createElement(AlertDescription, { className: "flex flex-wrap items-center gap-2 text-xs leading-relaxed" },
                        React.createElement("span", null,
                            React.createElement("span", { className: "font-semibold" }, "Previous provisioning run was interrupted."),
                            " ",
                            "Completed ",
                            resumeHint.completedSubs,
                            " of ",
                            resumeHint.totalSubs,
                            " ",
                            "subscription",
                            resumeHint.totalSubs === 1 ? "" : "s",
                            " (started",
                            " ",
                            React.createElement("span", { className: "font-mono" }, new Date(resumeHint.attemptStartedAt).toLocaleTimeString()),
                            "). Audit attemptId",
                            " ",
                            React.createElement("span", { className: "font-mono" },
                                resumeHint.attemptId.slice(0, 8),
                                "\u2026"),
                            "."),
                        React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                            React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => setResumeHint(null), "aria-label": "Dismiss interrupted-run banner" }, "Dismiss"))))),
                subscriptionSelector,
                React.createElement("div", { className: "flex flex-col gap-1.5 max-w-[28rem]" },
                    React.createElement(Label, { htmlFor: regionFieldId },
                        "Regions",
                        " ",
                        React.createElement("span", { className: "font-normal text-muted-foreground" },
                            "(select up to ",
                            DEFAULT_CONFIG.maxRegionsPerRequest,
                            ")")),
                    React.createElement("div", { className: "flex flex-wrap gap-1", role: "group", "aria-label": "Region presets" },
                        REGION_PRESETS.map((preset) => (React.createElement(Tooltip, { key: preset.id },
                            React.createElement(TooltipTrigger, { asChild: true },
                                React.createElement("button", { type: "button", onClick: () => applyRegionPreset(preset), className: "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-2xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": `Add preset ${preset.label}` },
                                    React.createElement(Plus, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                                    preset.label)),
                            React.createElement(TooltipContent, { side: "top" }, preset.description)))),
                        selectedRegions.length > 0 && (React.createElement("button", { type: "button", onClick: clearRegions, className: "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": "Clear all selected regions" },
                            React.createElement(XCircle, { className: "h-2.5 w-2.5", "aria-hidden": true }),
                            "Clear all"))),
                    React.createElement(DropdownMenu, null,
                        React.createElement(DropdownMenuTrigger, { asChild: true },
                            React.createElement(Button, { id: regionFieldId, type: "button", variant: "outline", className: "h-9 w-full justify-between bg-surface-sunken px-3 text-sm font-normal", "aria-label": "Azure regions", "aria-haspopup": "menu" },
                                React.createElement("span", { className: cn("truncate", selectedRegions.length === 0
                                        ? "text-muted-foreground"
                                        : "text-foreground") }, selectedRegions.length === 0
                                    ? "Select regions"
                                    : `${selectedRegions.length} region${selectedRegions.length === 1 ? "" : "s"} selected`),
                                React.createElement("span", { className: "ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-2xs font-semibold text-primary" }, selectedRegions.length))),
                        React.createElement(DropdownMenuContent, { align: "start", className: "max-h-80 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto", onCloseAutoFocus: (e) => e.preventDefault() },
                            React.createElement("div", { className: "sticky top-0 z-10 -mx-1 mb-1 bg-popover px-2 py-1.5" },
                                React.createElement("div", { className: "relative" },
                                    React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                                    React.createElement(Input, { value: regionFilter, onChange: (e) => setRegionFilter(e.target.value), placeholder: "Filter regions (e.g. 'us', 'gpu')\u2026", "aria-label": "Filter regions", className: "h-7 pl-7 text-xs", onKeyDown: (e) => e.stopPropagation(), autoFocus: true }))),
                            totalMatching === 0 ? (React.createElement("div", { className: "px-2 py-3 text-center text-2xs text-muted-foreground" },
                                "No regions match \u201C",
                                regionFilter,
                                "\u201D.")) : (React.createElement(React.Fragment, null,
                                gpu.length > 0 && (React.createElement(React.Fragment, null,
                                    React.createElement(DropdownMenuLabel, null,
                                        "V100 / H100 regions",
                                        React.createElement("span", { className: "ml-2 text-2xs font-normal text-muted-foreground" },
                                            "(",
                                            gpu.length,
                                            ")")),
                                    React.createElement(DropdownMenuSeparator, null),
                                    gpu.map(renderRegion))),
                                noGpu.length > 0 && (React.createElement(React.Fragment, null,
                                    gpu.length > 0 && React.createElement(DropdownMenuSeparator, null),
                                    React.createElement(DropdownMenuLabel, null,
                                        "No V100 / H100 advertised",
                                        React.createElement("span", { className: "ml-2 text-2xs font-normal text-muted-foreground" },
                                            "(",
                                            noGpu.length,
                                            ")")),
                                    React.createElement(DropdownMenuSeparator, null),
                                    noGpu.map(renderRegion))))))),
                    selectedRegions.length > 0 && (React.createElement("div", { className: "mt-1 flex flex-wrap gap-1", "aria-label": "Selected regions" }, selectedRegions.map((r) => (React.createElement("span", { key: r, className: "inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground" },
                        isGpuRegion(r) && (React.createElement("span", { title: "V100 (NCv3) or H100 (NCadsH100_v5 / NDH100v5) advertised", className: "inline-flex h-3.5 items-center justify-center rounded-sm bg-primary/15 px-1 text-[0.625rem] font-semibold text-primary", "aria-label": "V100/H100 region" }, "V100/H100")),
                        r,
                        React.createElement("button", { type: "button", onClick: () => handleRegionsChange(selectedRegions.filter((x) => x !== r)), className: "rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": `Remove ${r}` },
                            React.createElement("span", { "aria-hidden": true }, "x")))))))),
                atMaxRegions && (React.createElement(Alert, { variant: "warning", className: "px-3 py-2" },
                    React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                    React.createElement(AlertDescription, { className: "text-xs" },
                        "Maximum ",
                        DEFAULT_CONFIG.maxRegionsPerRequest,
                        " regions reached."))),
                effectiveSubscriptionIds.length > 0 &&
                    selectedRegions.length > 0 && (React.createElement("div", { className: "flex items-start gap-2 rounded-md border border-border bg-surface-sunken/40 p-2.5" },
                    React.createElement("input", { id: skipExistingId, type: "checkbox", checked: skipExisting, onChange: (e) => setSkipExisting(e.target.checked), className: "mt-0.5 h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary", "aria-describedby": `${skipExistingId}-desc` }),
                    React.createElement("div", { className: "flex flex-col gap-0.5 text-xs" },
                        React.createElement(Label, { htmlFor: skipExistingId, className: "cursor-pointer text-xs font-medium text-foreground" },
                            "Skip already-existing accounts",
                            skippedExistingCount > 0 && (React.createElement("span", { className: "ml-2 inline-flex items-center rounded-full border border-info/30 bg-info/10 px-1.5 py-0.5 text-2xs font-medium text-info" },
                                skippedExistingCount,
                                " would be skipped"))),
                        React.createElement("span", { id: `${skipExistingId}-desc`, className: "text-2xs text-muted-foreground leading-relaxed" }, "When on, (subscription \u00D7 region) pairs that already have a created Batch account are dropped from the dispatch list so the orchestrator never issues a 409. Untick to force re-creation (typically fails with an existing-account error).")))),
                React.createElement(Separator, { className: "my-1" }),
                React.createElement("div", { className: "flex justify-end" }, !configureValid ? (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: "inline-flex" },
                            React.createElement(Button, { type: "button", variant: "default", disabled: true, "aria-label": "Continue to preflight (disabled)" }, "Continue"))),
                    React.createElement(TooltipContent, { side: "top" }, effectiveSubscriptionIds.length === 0
                        ? "Pick a subscription first."
                        : selectedRegions.length === 0
                            ? "Select at least one region."
                            : "Resolve configuration errors."))) : (React.createElement(Button, { type: "button", variant: "default", onClick: () => setStep("preflight"), "aria-label": "Continue to preflight" }, "Continue"))))));
    };
    const renderPreflight = () => (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "pb-3" },
            React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
                React.createElement("div", { className: "flex flex-col gap-0.5" },
                    React.createElement(CardTitle, { className: "text-sm font-semibold uppercase tracking-wider text-muted-foreground" }, "Pre-flight checks"),
                    React.createElement(CardDescription, null, "Verifies subscription, region capacity, and naming uniqueness before submission.")),
                stepElapsedChip)),
        React.createElement(CardContent, { className: "flex flex-col gap-4" },
            React.createElement(PreflightChips, { checks: preflight }),
            selectedRegions.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken/40 px-3 py-2" },
                React.createElement("div", { className: "flex flex-col gap-0.5 text-2xs" },
                    React.createElement("span", { className: "font-semibold uppercase tracking-wider text-muted-foreground" }, "Picked regions"),
                    React.createElement("span", { className: "text-muted-foreground" },
                        selectedRegions.length,
                        " region",
                        selectedRegions.length === 1 ? "" : "s",
                        " \u00B7",
                        " ",
                        React.createElement("span", { className: "font-mono text-foreground" },
                            selectedRegions.slice(0, 6).join(", "),
                            selectedRegions.length > 6 && (React.createElement(React.Fragment, null,
                                ", ",
                                React.createElement("span", { className: "text-muted-foreground" },
                                    "+",
                                    selectedRegions.length - 6,
                                    " more")))))),
                React.createElement(CopyButton, { value: selectedRegions.join("\n"), ariaLabel: `Copy ${selectedRegions.length} region${selectedRegions.length === 1 ? "" : "s"} to clipboard`, iconSize: 14, alwaysVisible: true, onCopied: () => auditLog.record({
                        actor: auditActor,
                        action: "provision_accounts.copy_region_list",
                        target: `count:${selectedRegions.length}`,
                        status: "success",
                        details: { regions: selectedRegions },
                    }), className: "h-7 w-7 rounded-md border border-border bg-card text-foreground hover:bg-muted" }))),
            React.createElement(Separator, { className: "my-1" }),
            React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                React.createElement(Button, { type: "button", variant: "outline", onClick: () => setStep("configure"), "aria-label": "Back to configure" }, "Back"),
                canPassPreflight ? (React.createElement(Button, { type: "button", variant: "default", onClick: () => setStep("review"), "aria-label": "Continue to review" }, "Continue")) : (React.createElement(Tooltip, null,
                    React.createElement(TooltipTrigger, { asChild: true },
                        React.createElement("span", { className: "inline-flex" },
                            React.createElement(Button, { type: "button", variant: "default", disabled: true, "aria-label": "Continue to review (disabled)" }, "Continue"))),
                    React.createElement(TooltipContent, { side: "top" }, "Resolve all blocking errors before continuing.")))))));
    const renderReview = () => (React.createElement(Card, null,
        React.createElement(CardHeader, { className: "pb-3" },
            React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
                React.createElement("div", { className: "flex flex-col gap-0.5" },
                    React.createElement(CardTitle, { className: "text-sm font-semibold uppercase tracking-wider text-muted-foreground" }, "Review"),
                    React.createElement(CardDescription, null, "Confirm the request below. You can jump back to edit any section.")),
                stepElapsedChip)),
        React.createElement(CardContent, { className: "flex flex-col gap-4" },
            React.createElement(ConfigureFieldsetReadOnly, { subscriptions: effectiveSubscriptionDetails, selectedRegions: selectedRegions, perSubDelaySec: perSubDelaySec, skipExisting: skipExisting, skippedCount: skippedExistingCount, onEdit: () => setStep("configure") }),
            skippedExistingCount > 0 && (React.createElement(Alert, { variant: "info", className: "px-3 py-2 text-xs" },
                React.createElement(Info, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement(AlertDescription, { className: "text-xs leading-relaxed" },
                    React.createElement("span", { className: "font-semibold" },
                        skippedExistingCount,
                        " (subscription \u00D7 region) pair",
                        skippedExistingCount === 1 ? "" : "s",
                        " already have a Batch account"),
                    " ",
                    "and will be skipped. Untick \u201CSkip already-existing\u201D on the Configure step to force re-creation."))),
            React.createElement("div", { className: "rounded-md border border-border bg-surface-sunken/40 p-3" },
                React.createElement("div", { className: "mb-2 flex items-center justify-between gap-2" },
                    React.createElement("h4", { className: "m-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Pre-flight summary"),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => setStep("preflight"), "aria-label": "Edit pre-flight" },
                        React.createElement(Pencil, { className: "h-3 w-3", "aria-hidden": true }),
                        "Edit")),
                React.createElement(PreflightChips, { checks: preflight })),
            enumerationPreview.length > 0 && (React.createElement("details", { className: "rounded-md border border-border bg-surface-sunken/40 p-3 text-xs", "aria-label": "Post-creation enumeration preview" },
                React.createElement("summary", { className: "flex cursor-pointer items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground select-none" },
                    React.createElement(Search, { className: "h-3 w-3", "aria-hidden": true }),
                    "Post-creation enumeration preview",
                    React.createElement("span", { className: "font-normal normal-case tracking-normal text-muted-foreground/80" }, "\u2014 what an operator with Reader on these subs will see")),
                React.createElement("div", { className: "mt-2 flex flex-col gap-1.5" },
                    React.createElement("p", { className: "m-0 text-2xs text-muted-foreground leading-relaxed" },
                        "After this run completes, every account below is enumerable via",
                        " ",
                        React.createElement("code", { className: "font-mono text-foreground" }, "az batch account list"),
                        " ",
                        "or the equivalent",
                        " ",
                        React.createElement("code", { className: "font-mono text-foreground" }, "Microsoft.Batch/batchAccounts"),
                        " ",
                        "LIST call with",
                        " ",
                        React.createElement("span", { className: "font-mono text-foreground" }, "Reader"),
                        " RBAC. Account-name pattern shown is the orchestrator's template; the final name may include a suffix."),
                    React.createElement("ul", { className: "m-0 flex flex-col gap-0.5 p-0 text-2xs" },
                        enumerationPreview.map((row, idx) => (React.createElement("li", { key: `${row.subscriptionId}::${row.region}::${idx}`, className: "flex flex-wrap items-center gap-2 rounded-sm bg-card/40 px-2 py-1 font-mono" },
                            React.createElement("span", { className: "text-muted-foreground" }, "sub"),
                            React.createElement("span", { className: "text-foreground" }, row.subscriptionLabel),
                            React.createElement("span", { className: "text-muted-foreground" },
                                "(",
                                row.subscriptionId.slice(0, 8),
                                "\u2026)"),
                            React.createElement("span", { className: "text-muted-foreground" }, "\u00B7"),
                            React.createElement("span", { className: "text-muted-foreground" }, "region"),
                            React.createElement("span", { className: "text-foreground" }, row.region),
                            React.createElement("span", { className: "text-muted-foreground" }, "\u00B7"),
                            React.createElement("span", { className: "text-muted-foreground" }, "acct"),
                            React.createElement("span", { className: "text-foreground" }, row.accountNamePattern),
                            React.createElement("span", { className: "text-muted-foreground" }, "\u00B7"),
                            React.createElement("span", { className: "text-muted-foreground" }, "rg"),
                            React.createElement("span", { className: "text-foreground" }, row.resourceGroupPattern)))),
                        dispatchPlan.length > enumerationPreview.length && (React.createElement("li", { className: "px-2 py-0.5 text-muted-foreground" },
                            "+ ",
                            dispatchPlan.length - enumerationPreview.length,
                            " more")))))),
            React.createElement(Alert, { variant: "warning", className: "px-3 py-2 text-xs" },
                React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement(AlertDescription, { className: "text-xs leading-relaxed" }, "Submission is irreversible from this UI. Cleanup of accounts and resource groups is manual.")),
            React.createElement(Separator, { className: "my-1" }),
            React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                React.createElement(Button, { type: "button", variant: "outline", onClick: () => setStep("preflight"), "aria-label": "Back to preflight" }, "Back"),
                React.createElement(Button, { type: "button", variant: "default", onClick: () => setStep("submit"), "aria-label": "Continue to submit" }, "Continue")))));
    // ---- Mid-run live per-sub rollup -----------------------------------------
    // Slim derivative of `attemptAccounts` keyed by subscriptionId. Drives the
    // mid-run sparkline so the operator sees per-sub progress while the batch
    // is still moving forward — no need to wait for the result step.
    // Keep this stable on `attemptAccounts` only; selectedRegions / subs
    // are part of `dispatchPerSub` and a re-pick mid-run would already have
    // had a fresh attemptStartedAt.
    const liveSubSummary = React.useMemo(() => {
        var _a, _b, _c;
        const map = new Map();
        if (!attemptStartedAt)
            return [];
        const attemptStartMs = Date.parse(attemptStartedAt);
        for (const subId of effectiveSubscriptionIds) {
            const known = state.subscriptions.find((s) => s.subscriptionId === subId);
            // Total for this sub = its dispatch plan size (post-skip),
            // falling back to selectedRegions when the sub isn't in the
            // plan (typed-input fallback path).
            const total = (_b = (_a = dispatchPerSub.get(subId)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : selectedRegions.length;
            map.set(subId, {
                displayName: (_c = known === null || known === void 0 ? void 0 : known.displayName) !== null && _c !== void 0 ? _c : (subId ? subId.slice(0, 8) + "…" : "(custom)"),
                created: 0,
                failed: 0,
                total,
                elapsedMs: 0,
            });
        }
        for (const a of attemptAccounts) {
            const entry = map.get(a.subscriptionId);
            if (!entry)
                continue;
            if (a.provisioningState === "created")
                entry.created += 1;
            if (a.provisioningState === "failed")
                entry.failed += 1;
            if (a.createdAt) {
                const ts = Date.parse(a.createdAt);
                if (!Number.isNaN(ts) && ts >= attemptStartMs) {
                    entry.elapsedMs = Math.max(entry.elapsedMs, ts - attemptStartMs);
                }
            }
        }
        return Array.from(map.entries()).map(([subscriptionId, v]) => (Object.assign({ subscriptionId }, v)));
    }, [
        attemptAccounts,
        attemptStartedAt,
        effectiveSubscriptionIds,
        dispatchPerSub,
        selectedRegions.length,
        state.subscriptions,
    ]);
    // Rolling avg seconds per region across all completed regions in the
    // current attempt — used to render a per-sub ETA badge.
    const rollingAvgPerRegionSec = React.useMemo(() => {
        let totalElapsedMs = 0;
        let completedRegions = 0;
        for (const s of liveSubSummary) {
            totalElapsedMs += s.elapsedMs;
            completedRegions += s.created + s.failed;
        }
        if (completedRegions === 0)
            return null;
        return Math.max(1, Math.round(totalElapsedMs / completedRegions / 1000));
    }, [liveSubSummary]);
    // PerSubSparkline is now declared at module scope (above the
    // component) so it doesn't get re-created on every parent render
    // (parent re-renders at 1Hz while the ticker effect is running —
    // re-declaring the component each tick was thrashing React's
    // reconciliation across the per-sub rollup list).
    const renderSubmit = () => {
        var _a, _b, _c;
        return (React.createElement(Card, null,
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement("div", { className: "flex flex-wrap items-start justify-between gap-2" },
                    React.createElement("div", { className: "flex flex-col gap-0.5" },
                        React.createElement(CardTitle, { className: "text-sm font-semibold uppercase tracking-wider text-muted-foreground" }, "Submit"),
                        React.createElement(CardDescription, null,
                            "Provision ",
                            totalToCreate,
                            " Batch account",
                            totalToCreate === 1 ? "" : "s",
                            effectiveSubscriptionIds.length > 1 ? (React.createElement(React.Fragment, null,
                                " ",
                                "across ",
                                effectiveSubscriptionIds.length,
                                " subscriptions \u00B7",
                                " ",
                                perSubDelaySec,
                                "s gap between subs")) : (React.createElement(React.Fragment, null, ".")))),
                    stepElapsedChip)),
            React.createElement(CardContent, { className: "flex flex-col gap-4" },
                submitError && (React.createElement(ErrorState, { message: "Provisioning request failed.", detail: submitError, onRetry: () => {
                        setSubmitError(null);
                        requestSubmit();
                    }, size: "compact" })),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(Button, { type: "button", variant: "default", onClick: requestSubmit, disabled: isRunning || !configureValid || dispatchPlan.length === 0, loading: isRunning, "aria-label": `Provision ${totalToCreate} Batch accounts`, className: "min-w-[14rem]" },
                        React.createElement(Plus, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Provision ",
                        totalToCreate,
                        " account",
                        totalToCreate === 1 ? "" : "s"),
                    isRunning && (React.createElement(Button, { type: "button", variant: "outline", onClick: handleStop, "aria-label": "Stop account creation", className: "border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive" },
                        React.createElement(Square, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Stop"))),
                subBatchProgress && subBatchProgress.total > 1 && (React.createElement("div", { className: "flex flex-col gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5", role: "status", "aria-live": "polite", "aria-label": "Multi-subscription dispatch progress" },
                    React.createElement("div", { className: "flex items-center justify-between gap-2 text-xs" },
                        React.createElement("span", { className: "inline-flex items-center gap-1.5 font-medium text-foreground" },
                            subBatchProgress.waiting ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none", "aria-hidden": true })) : (React.createElement(Sparkles, { className: "h-3.5 w-3.5 text-primary", "aria-hidden": true })),
                            "Subscription",
                            " ",
                            React.createElement("span", { className: "tabular-nums" }, Math.min(subBatchProgress.completed +
                                (subBatchProgress.waiting ? 0 : 1), subBatchProgress.total)),
                            " ",
                            "of ",
                            React.createElement("span", { className: "tabular-nums" }, subBatchProgress.total)),
                        subBatchProgress.waiting && subBatchProgress.waitingUntil && (React.createElement("span", { className: "font-mono text-2xs text-muted-foreground tabular-nums" },
                            "next dispatch in ~",
                            Math.max(0, Math.ceil((subBatchProgress.waitingUntil - Date.now()) / 1000)),
                            "s"))),
                    React.createElement(Progress, { value: Math.round((subBatchProgress.completed / subBatchProgress.total) * 100), "aria-label": `${subBatchProgress.completed} of ${subBatchProgress.total} subscriptions dispatched` }),
                    subBatchProgress.currentSubId && !subBatchProgress.waiting && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "Working on",
                        " ",
                        React.createElement("span", { className: "font-mono text-foreground" }, (_b = (_a = effectiveSubscriptionDetails.find((s) => s.subscriptionId === subBatchProgress.currentSubId)) === null || _a === void 0 ? void 0 : _a.displayName) !== null && _b !== void 0 ? _b : ((_c = subBatchProgress.currentSubId) !== null && _c !== void 0 ? _c : "").slice(0, 8) + "…"))),
                    subBatchProgress.waiting && (React.createElement("span", { className: "text-2xs text-muted-foreground leading-relaxed" }, "Waiting before the next subscription so ARM's per-tenant write throttle has room to breathe. Click Stop above to abort.")))),
                (isRunning || progressTotal > 0) && (React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-surface-sunken/60 px-3 py-2.5", role: "group", "aria-labelledby": "creation-progress-label" },
                    React.createElement("div", { className: "flex items-center justify-between gap-2 text-xs text-foreground" },
                        React.createElement("span", { id: "creation-progress-label", className: "inline-flex items-center gap-1.5 font-medium" },
                            isRunning ? (React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none", "aria-hidden": true })) : failedCount === 0 ? (React.createElement(CheckCircle2, { className: "h-3.5 w-3.5 text-success", "aria-hidden": true })) : (React.createElement(AlertTriangle, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true })),
                            isRunning ? "Creating accounts..." : "Completed"),
                        React.createElement("span", { className: "tabular-nums text-muted-foreground", "aria-live": "polite" },
                            progressDone,
                            "/",
                            progressTotal,
                            " (",
                            progressPercent,
                            "%)")),
                    React.createElement(Progress, { value: progressPercent, "aria-label": `${progressDone} of ${progressTotal} accounts processed`, "aria-valuetext": `${progressDone} of ${progressTotal} accounts processed (${progressPercent} percent)` }),
                    (isRunning || currentRegion) && (React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground" },
                        currentRegion ? (React.createElement("span", { "aria-live": "polite" },
                            "Working on",
                            " ",
                            React.createElement("span", { className: "font-mono text-foreground" }, currentRegion))) : (React.createElement("span", null)),
                        etaSeconds !== null && (React.createElement("span", { className: "tabular-nums", "aria-live": "polite" },
                            "~",
                            formatEta(etaSeconds),
                            " remaining")))),
                    regionStatus.length > 0 && (React.createElement("ul", { className: "mt-1 flex flex-wrap gap-1", "aria-label": "Per-region provisioning status" }, regionStatus.map((r) => (React.createElement("li", { key: r.region },
                        React.createElement(RegionStatusChip, { region: r.region, state: r.state, accountName: r.accountName, error: r.error })))))),
                    liveSubSummary.length > 1 && (React.createElement("div", { className: "mt-1 flex items-center justify-between gap-2 text-2xs", role: "group", "aria-label": "Live rollup grouping" },
                        React.createElement("span", { className: "font-semibold uppercase tracking-wider text-muted-foreground" }, "Group by"),
                        React.createElement("div", { className: "inline-flex items-center overflow-hidden rounded-md border border-border bg-card", role: "radiogroup", "aria-label": "Group live rollup by" },
                            React.createElement("button", { type: "button", onClick: () => setLiveGrouping("sub"), "aria-pressed": liveGrouping === "sub", "aria-label": "Group by subscription", className: cn("px-2 py-0.5 transition-colors", liveGrouping === "sub"
                                    ? "bg-primary/15 text-primary"
                                    : "text-muted-foreground hover:bg-muted/40") }, "Subscription"),
                            React.createElement("button", { type: "button", onClick: () => setLiveGrouping("region"), "aria-pressed": liveGrouping === "region", "aria-label": "Group by region", className: cn("border-l border-border px-2 py-0.5 transition-colors", liveGrouping === "region"
                                    ? "bg-primary/15 text-primary"
                                    : "text-muted-foreground hover:bg-muted/40") }, "Region")))),
                    liveSubSummary.length > 1 && liveGrouping === "region" && (React.createElement("ul", { className: "mt-1 flex flex-col gap-1", "aria-label": "Per-region live progress" }, liveRegionSummary.map((r) => {
                        const remaining = Math.max(0, r.total - r.created - r.failed);
                        return (React.createElement("li", { key: r.region, className: "flex flex-wrap items-center justify-between gap-2 rounded-sm bg-card/40 px-2 py-1 text-2xs" },
                            React.createElement("span", { className: "inline-flex items-center gap-2" },
                                React.createElement("span", { className: "font-medium text-foreground" }, r.region),
                                isGpuRegion(r.region) && (React.createElement("span", { className: "inline-flex items-center rounded-sm bg-primary/15 px-1 font-mono text-2xs text-primary" }, "GPU")),
                                React.createElement(PerSubSparkline, { created: r.created, failed: r.failed, total: r.total })),
                            React.createElement("span", { className: "inline-flex items-center gap-2 tabular-nums text-muted-foreground" },
                                React.createElement("span", null,
                                    React.createElement("span", { className: "text-success" }, r.created),
                                    " / ",
                                    React.createElement("span", { className: "text-foreground" }, r.total),
                                    r.failed > 0 && (React.createElement(React.Fragment, null,
                                        " · ",
                                        React.createElement("span", { className: "text-destructive" },
                                            r.failed,
                                            " failed")))),
                                remaining > 0 && (React.createElement("span", { className: "text-muted-foreground" },
                                    remaining,
                                    " pending")))));
                    }))),
                    liveSubSummary.length > 1 && liveGrouping === "sub" && (React.createElement("ul", { className: "mt-1 flex flex-col gap-1", "aria-label": "Per-subscription live progress" }, liveSubSummary.map((s) => {
                        const done = s.created + s.failed;
                        const remaining = Math.max(0, s.total - done);
                        const subEtaSec = rollingAvgPerRegionSec !== null && remaining > 0
                            ? rollingAvgPerRegionSec * remaining
                            : null;
                        return (React.createElement("li", { key: s.subscriptionId, className: "flex flex-wrap items-center justify-between gap-2 rounded-sm bg-card/40 px-2 py-1 text-2xs" },
                            React.createElement("span", { className: "inline-flex items-center gap-2" },
                                React.createElement("span", { className: "font-medium text-foreground" }, s.displayName),
                                React.createElement("span", { className: "font-mono text-muted-foreground" },
                                    s.subscriptionId.slice(0, 8),
                                    "\u2026"),
                                React.createElement(PerSubSparkline, { created: s.created, failed: s.failed, total: s.total })),
                            React.createElement("span", { className: "inline-flex items-center gap-2 tabular-nums text-muted-foreground" },
                                React.createElement("span", null,
                                    React.createElement("span", { className: "text-success" }, s.created),
                                    " / ",
                                    React.createElement("span", { className: "text-foreground" }, s.total),
                                    s.failed > 0 && (React.createElement(React.Fragment, null,
                                        " · ",
                                        React.createElement("span", { className: "text-destructive" },
                                            s.failed,
                                            " failed")))),
                                subEtaSec !== null && (React.createElement("span", { className: "inline-flex items-center rounded-full border border-border bg-muted/40 px-1.5 text-2xs text-foreground", title: "Estimated remaining time for this subscription, derived from the rolling average across completed regions" },
                                    "~",
                                    formatEta(subEtaSec))))));
                    }))))),
                React.createElement(Separator, { className: "my-1" }),
                React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                    React.createElement(Button, { type: "button", variant: "outline", onClick: () => setStep("review"), disabled: isRunning, "aria-label": "Back to review" }, "Back"),
                    !isRunning && progressTotal > 0 && (React.createElement(Button, { type: "button", variant: "default", onClick: () => setStep("result"), "aria-label": "View result" }, "View result"))))));
    };
    const renderResult = () => {
        // Three result postures, each with its own banner. Empty = no rows
        // (user landed here without a submission); success = all created,
        // none failed; partial = mix of created + failed; failure = all
        // failed. Visual emphasis is the only behaviour change — handlers
        // remain identical.
        const allSuccess = totalCount > 0 && failedCount === 0 && createdCount === totalCount;
        const allFailed = totalCount > 0 && createdCount === 0 && failedCount > 0;
        const partial = totalCount > 0 && createdCount > 0 && failedCount > 0;
        const successRate = totalCount > 0 ? Math.round((createdCount / totalCount) * 100) : 0;
        const avgPerAccountMs = lastAttemptDurationMs !== null && totalCount > 0
            ? Math.round(lastAttemptDurationMs / totalCount)
            : null;
        // `perSubSummary` is memoized at component scope above so it
        // doesn't recompute every time the operator triggers a re-render
        // on this step.
        return (React.createElement(Card, { className: cn("transition-shadow duration-200 ease-out", allSuccess && "ring-1 ring-success/30", allFailed && "ring-1 ring-destructive/30", partial && "ring-1 ring-warning/30") },
            React.createElement(CardHeader, { className: "pb-3" },
                React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                    React.createElement("div", { className: "flex flex-col gap-0.5" },
                        React.createElement(CardTitle, { className: "text-sm font-semibold uppercase tracking-wider text-muted-foreground" }, "Result"),
                        React.createElement(CardDescription, null,
                            React.createElement("span", { className: "text-foreground font-medium tabular-nums" }, totalCount),
                            " ",
                            "account",
                            totalCount === 1 ? "" : "s",
                            " (",
                            React.createElement("span", { className: "text-success font-medium tabular-nums" },
                                createdCount,
                                " ready"),
                            ",",
                            " ",
                            React.createElement("span", { className: cn("font-medium tabular-nums", failedCount > 0
                                    ? "text-destructive"
                                    : "text-muted-foreground") },
                                failedCount,
                                " failed"),
                            ")")),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        failedCount > 0 && (React.createElement(Button, { type: "button", variant: "outline", onClick: handleRetryFailed, "aria-label": `Retry ${failedCount} failed accounts`, className: "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" },
                            React.createElement(RotateCw, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            "Retry failed (",
                            failedCount,
                            ")")),
                        React.createElement(Button, { type: "button", variant: allSuccess ? "default" : "ghost", onClick: () => {
                                // Wipe the attempt scope before going back to configure
                                // so progress/result counters reset to zero. Without this
                                // reset, the auto-advance effect would immediately bounce
                                // the user back to the result step with the OLD numbers.
                                // Also clear the resume hint + attemptId so the next
                                // submit gets a fresh correlation id.
                                setAttemptStartedAt(null);
                                setAttemptId(null);
                                setResumeHint(null);
                                setSubmitError(null);
                                setSubBatchProgress(null);
                                setLastAttemptDurationMs(null);
                                setStep("configure");
                                auditLog.record({
                                    actor: auditActor,
                                    action: "provision_accounts.new_request",
                                    target: "wizard:reset",
                                    status: "success",
                                    details: { previousAttemptId: attemptId },
                                });
                            }, "aria-label": "Start a new provisioning request" },
                            React.createElement(Plus, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            "New request")))),
            React.createElement(CardContent, { className: "flex flex-col gap-3 pt-0" },
                totalCount > 0 && (React.createElement("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-4" },
                    React.createElement("div", { className: "flex flex-col rounded-md border border-border bg-surface-sunken/40 p-2.5" },
                        React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Success rate"),
                        React.createElement("span", { className: cn("tabular-nums text-lg font-semibold leading-none", allSuccess
                                ? "text-success"
                                : partial
                                    ? "text-warning"
                                    : allFailed
                                        ? "text-destructive"
                                        : "text-foreground") },
                            successRate,
                            "%"),
                        React.createElement("span", { className: "text-2xs text-muted-foreground" },
                            createdCount,
                            " of ",
                            totalCount)),
                    React.createElement("div", { className: "flex flex-col rounded-md border border-border bg-surface-sunken/40 p-2.5" },
                        React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Elapsed"),
                        React.createElement("span", { className: "tabular-nums text-lg font-semibold leading-none text-foreground" }, lastAttemptDurationMs !== null
                            ? formatEta(Math.round(lastAttemptDurationMs / 1000))
                            : "—"),
                        React.createElement("span", { className: "text-2xs text-muted-foreground" }, "wall-clock")),
                    React.createElement("div", { className: "flex flex-col rounded-md border border-border bg-surface-sunken/40 p-2.5" },
                        React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Avg / account"),
                        React.createElement("span", { className: "tabular-nums text-lg font-semibold leading-none text-foreground" }, avgPerAccountMs !== null
                            ? formatEta(Math.round(avgPerAccountMs / 1000))
                            : "—"),
                        React.createElement("span", { className: "text-2xs text-muted-foreground" }, "end-to-end")),
                    React.createElement("div", { className: "flex flex-col rounded-md border border-border bg-surface-sunken/40 p-2.5" },
                        React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Subscriptions"),
                        React.createElement("span", { className: "tabular-nums text-lg font-semibold leading-none text-foreground" }, perSubSummary.length),
                        React.createElement("span", { className: "text-2xs text-muted-foreground" }, "touched")))),
                perSubSummary.length > 1 && (React.createElement("div", { className: "rounded-md border border-border bg-surface-sunken/40 p-3" },
                    React.createElement("h4", { className: "m-0 mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Per-subscription"),
                    React.createElement("ul", { className: "flex flex-col gap-1 text-xs" }, perSubSummary.map((s) => {
                        const allOk = s.failed === 0 && s.created === s.total;
                        const someFailed = s.failed > 0;
                        return (React.createElement("li", { key: s.subscriptionId, className: "flex flex-wrap items-center justify-between gap-2 rounded-sm bg-card/40 px-2 py-1" },
                            React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                                allOk ? (React.createElement(CheckCircle2, { className: "h-3 w-3 text-success", "aria-hidden": true })) : someFailed && s.created === 0 ? (React.createElement(XCircle, { className: "h-3 w-3 text-destructive", "aria-hidden": true })) : (React.createElement(AlertTriangle, { className: "h-3 w-3 text-warning", "aria-hidden": true })),
                                React.createElement("span", { className: "font-medium text-foreground" }, s.displayName),
                                React.createElement("span", { className: "font-mono text-2xs text-muted-foreground" },
                                    s.subscriptionId.slice(0, 8),
                                    "\u2026")),
                            React.createElement("span", { className: "tabular-nums text-2xs text-muted-foreground" },
                                React.createElement("span", { className: "text-success" }, s.created),
                                " / ",
                                React.createElement("span", { className: "text-foreground" }, s.total),
                                s.failed > 0 && (React.createElement(React.Fragment, null,
                                    " · ",
                                    React.createElement("span", { className: "text-destructive" },
                                        s.failed,
                                        " failed"))))));
                    })))),
                allSuccess && (React.createElement(Alert, { variant: "success", className: "px-3 py-2 transition-colors duration-200 ease-out", role: "status" },
                    React.createElement(Sparkles, { className: "h-4 w-4", "aria-hidden": true }),
                    React.createElement(AlertDescription, { className: "text-xs leading-relaxed" },
                        React.createElement("span", { className: "font-semibold" },
                            "All ",
                            createdCount,
                            " account",
                            createdCount === 1 ? "" : "s",
                            " provisioned successfully."),
                        " ",
                        "You can attach pools and nodes from the related views."))),
                partial && (React.createElement(Alert, { variant: "warning", className: "px-3 py-2 transition-colors duration-200 ease-out", role: "status" },
                    React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                    React.createElement(AlertDescription, { className: "text-xs leading-relaxed" },
                        React.createElement("span", { className: "font-semibold" },
                            createdCount,
                            " of ",
                            totalCount,
                            " accounts succeeded;",
                            " ",
                            failedCount,
                            " failed."),
                        " ",
                        "Use Retry failed to re-run only the failed regions."))),
                allFailed && (React.createElement(Alert, { variant: "destructive", className: "px-3 py-2 transition-colors duration-200 ease-out", role: "alert" },
                    React.createElement(AlertCircle, { className: "h-4 w-4", "aria-hidden": true }),
                    React.createElement(AlertDescription, { className: "text-xs leading-relaxed" },
                        React.createElement("span", { className: "font-semibold" },
                            "All ",
                            failedCount,
                            " account",
                            failedCount === 1 ? "" : "s",
                            " failed to provision."),
                        " ",
                        "Inspect each row's error, fix the root cause, and retry."))),
                provisionedRows.length === 0 ? (React.createElement(EmptyState, { icon: Users, title: "No accounts provisioned", description: "Submit a request from the Submit step to populate the result rollup.", action: {
                        label: "Start a new request",
                        onClick: () => {
                            setAttemptStartedAt(null);
                            setAttemptId(null);
                            setResumeHint(null);
                            setSubmitError(null);
                            setStep("configure");
                        },
                        icon: Plus,
                    } })) : (React.createElement(DataTable, { tableId: "account-provisioning-result", rows: provisionedRows, columns: provisionedColumns, rowKey: (r) => r.id, csvFileName: "provisioned-accounts.csv", jsonFileName: "provisioned-accounts.json", empty: React.createElement(EmptyState, { icon: Users, title: "No accounts provisioned", description: "Submit a request to populate the result rollup." }) })))));
    };
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4", role: "region", "aria-label": "Account provisioning page" },
        React.createElement(PageHeader, { title: "Account Provisioning", description: "Create new Azure Batch accounts across regions, or import existing accounts from a subscription." },
            React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh(), needsReauth: armTokenTracker.needsReauth, onReauth: () => void armTokenTracker.reauth() }))),
        validationError && (React.createElement(Alert, { variant: "destructive", role: "alert" },
            React.createElement(AlertCircle, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertDescription, { className: "flex items-center justify-between gap-3" },
                React.createElement("span", null, validationError),
                React.createElement(Button, { type: "button", variant: "ghost", size: "xs", onClick: () => setValidationError(null), "aria-label": "Dismiss validation error" }, "Dismiss")))),
        React.createElement(Tabs, { value: activeTab, onValueChange: (v) => setActiveTab(v === "import" ? "import" : "create"), "aria-label": "Account provisioning flow" },
            React.createElement(TabsList, { className: "h-auto bg-muted/60 p-1" },
                React.createElement(TabsTrigger, { value: "create", className: "gap-1.5 px-3 py-1.5 text-xs" },
                    React.createElement(Plus, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    "Create New"),
                React.createElement(TabsTrigger, { value: "import", className: "gap-1.5 px-3 py-1.5 text-xs" },
                    React.createElement(CloudDownload, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    "Import Existing")),
            React.createElement(TabsContent, { value: "create", className: "mt-4 flex flex-col gap-4" },
                React.createElement(Tabs, { value: currentStep, onValueChange: (v) => setStep(v), "aria-label": "Provisioning workflow steps", orientation: "horizontal" },
                    React.createElement(AnimatedTabs, { size: "sm", "aria-label": "Provisioning steps", value: currentStep, onChange: (id) => setStep(id), tabs: STEP_ORDER.map((s) => ({
                            id: s,
                            label: STEP_LABEL[s],
                            disabled: isStepDisabled(s),
                            badge: s === "result" && failedCount > 0 ? failedCount : undefined,
                        })) }),
                    React.createElement(TabsContent, { value: "configure", className: "mt-4" }, renderConfigure()),
                    React.createElement(TabsContent, { value: "preflight", className: "mt-4" }, renderPreflight()),
                    React.createElement(TabsContent, { value: "review", className: "mt-4" }, renderReview()),
                    React.createElement(TabsContent, { value: "submit", className: "mt-4" }, renderSubmit()),
                    React.createElement(TabsContent, { value: "result", className: "mt-4" }, renderResult()))),
            React.createElement(TabsContent, { value: "import", className: "mt-4" },
                React.createElement(Card, null,
                    React.createElement(CardHeader, { className: "pb-3" },
                        React.createElement(CardTitle, { className: "text-sm font-semibold uppercase tracking-wider text-muted-foreground" }, "Import existing accounts"),
                        React.createElement(CardDescription, null, "Discover all existing Batch accounts in a subscription and import them.")),
                    React.createElement(CardContent, { className: "flex flex-col gap-4" },
                        subscriptionSelector,
                        React.createElement("div", { className: "flex flex-wrap items-end gap-2" },
                            React.createElement(Button, { type: "button", variant: "default", onClick: handleDiscover, disabled: isDiscovering || effectiveSubscriptionIds.length === 0, loading: isDiscovering, "aria-label": "Discover existing Batch accounts" }, isDiscovering ? ("Discovering...") : (React.createElement(React.Fragment, null,
                                React.createElement(Search, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                "Discover Batch Accounts",
                                effectiveSubscriptionIds.length > 1 ? (React.createElement("span", { className: "ml-1 text-2xs opacity-80" },
                                    "(",
                                    effectiveSubscriptionIds.length,
                                    " subs)")) : null))),
                            isDiscovering && (React.createElement(Button, { type: "button", variant: "outline", onClick: handleStopDiscover, "aria-label": "Stop discovery", className: "border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive" },
                                React.createElement(Square, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                "Stop"))),
                        discoverError && (React.createElement(ErrorState, { message: "Failed to discover Batch accounts.", detail: discoverError, onRetry: () => {
                                setDiscoverError(null);
                                handleDiscover();
                            }, size: "compact" })),
                        isDiscovering && (React.createElement("div", { className: "flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken/60 px-3 py-2.5", role: "status", "aria-live": "polite" },
                            React.createElement("span", { className: "text-xs font-medium text-foreground" }, "Discovering Batch accounts from Azure..."),
                            React.createElement(Progress, { indeterminate: true }))),
                        React.createElement(Alert, { variant: "info", className: "px-3 py-2" },
                            React.createElement(Info, { className: "h-4 w-4", "aria-hidden": true }),
                            React.createElement(AlertDescription, { className: "text-xs leading-relaxed" }, "Discovers all existing Batch accounts in the selected subscription and imports them so you can manage quota, pools, and nodes on them.")),
                        state.accounts.length > 0 && (React.createElement(DataTable, { tableId: "account-provisioning-imported", rows: importedRows, columns: provisionedColumns, rowKey: (r) => r.id, csvFileName: "imported-accounts.csv", jsonFileName: "imported-accounts.json" })),
                        !isDiscovering && state.accounts.length === 0 && (React.createElement(EmptyState, { icon: CloudDownload, title: "No accounts imported", description: "Run discovery to import existing Batch accounts from the selected subscription.", action: effectiveSubscriptionIds.length > 0
                                ? {
                                    label: "Discover Batch Accounts",
                                    onClick: handleDiscover,
                                    icon: Search,
                                    loading: isDiscovering,
                                }
                                : undefined })))))),
        React.createElement(ConfirmationDialog, { hidden: confirmHidden, title: "Create Batch accounts?", message: confirmMessage, confirmText: `Create ${totalToCreate} account${totalToCreate === 1 ? "" : "s"}`, cancelText: "Cancel", danger: true, onConfirm: handleConfirmCreate, onCancel: () => setConfirmHidden(true), loading: isRunning }),
        React.createElement(ConfirmationDialog, { hidden: escCancelHidden, title: "Cancel in-flight provisioning?", message: React.createElement("div", { className: "space-y-2 text-sm leading-relaxed" },
                React.createElement("p", { className: "m-0" },
                    "You pressed",
                    " ",
                    React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 font-mono text-2xs" }, "Esc"),
                    " ",
                    "while a",
                    " ",
                    isRunning && isDiscovering
                        ? "provisioning and discovery run"
                        : isRunning
                            ? "provisioning run"
                            : "discovery run",
                    " ",
                    "is in flight."),
                React.createElement("p", { className: "m-0 text-muted-foreground text-xs" }, "Cancelling aborts the inter-subscription wait and signals the orchestrator to stop. ARM PUTs already in flight may still complete server-side.")), confirmText: "Cancel run", cancelText: "Keep running", danger: true, onConfirm: handleEscCancelConfirm, onCancel: () => setEscCancelHidden(true) })));
};
export const AccountProvisioningPage = (props) => React.createElement(AccountProvisioningPageInner, Object.assign({}, props));
//# sourceMappingURL=account-provisioning-page.js.map