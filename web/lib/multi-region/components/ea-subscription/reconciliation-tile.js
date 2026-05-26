/**
 * ReconciliationTile — post-batch steady-state check.
 *
 * After a batch completes, this panel reconciles the per-recipient status
 * map against expected steady-state and surfaces rows that need operator
 * attention. Grounded in `_bypass_modify_delete.md` (state-changing
 * operations need explicit follow-up — Azure does not guarantee the
 * caller's view of the new resource matches the destination tenant's
 * view immediately).
 *
 * Definitions of "steady state":
 *   - Same-tenant subscription, state="success" + subscriptionId    → STEADY
 *   - Same-tenant subscription, state="success", no subscriptionId  → ALIAS-ONLY (poll)
 *   - Cross-tenant subscription, state="success" + subscriptionId   → PENDING ACCEPTANCE
 *   - state="failure"                                               → FAILED
 *   - state="pending" / "running" past the end of the submit window → STALE
 */
import * as React from "react";
import { AlertCircle, CheckCircle2, Hourglass, Loader2, RotateCcw, Sparkles, } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { cn } from "@/lib/utils";
function classify(callerTenantId, r, s, submitting) {
    if (!s)
        return null;
    if (s.state === "pending" || s.state === "running") {
        if (submitting)
            return null;
        return {
            key: r.key,
            displayLabel: r.displayLabel,
            bucket: "stale",
            note: "Submit window closed but the row is still pending/running. UI was likely refreshed mid-flight; the Subscription Alias call may still complete server-side.",
        };
    }
    if (s.state === "failure") {
        return {
            key: r.key,
            displayLabel: r.displayLabel,
            bucket: "failed",
            note: s.error,
        };
    }
    // success
    const home = callerTenantId.toLowerCase();
    const target = r.tenantId.toLowerCase();
    if (target !== home) {
        return {
            key: r.key,
            displayLabel: r.displayLabel,
            bucket: "pendingAcceptance",
            note: "Cross-tenant: the destination owner has 7 days to accept ownership in their tenant. Until then, the subscription is provisioned but not yet owned.",
        };
    }
    if (!s.subscriptionId) {
        return {
            key: r.key,
            displayLabel: r.displayLabel,
            bucket: "aliasOnly",
            note: "The alias PUT succeeded but the async polling did not return a subscriptionId before the UI moved on. Refresh or check the alias-status endpoint to retrieve the id.",
        };
    }
    return {
        key: r.key,
        displayLabel: r.displayLabel,
        bucket: "steady",
    };
}
const BUCKET_META = {
    steady: {
        label: "Steady",
        icon: React.createElement(CheckCircle2, { className: "h-3.5 w-3.5 text-success", "aria-hidden": true }),
        tone: "border-success/30 bg-success/5 text-success-foreground",
    },
    aliasOnly: {
        label: "Alias-only (poll)",
        icon: (React.createElement(Loader2, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true })),
        tone: "border-border bg-surface-sunken",
    },
    pendingAcceptance: {
        label: "Awaiting acceptance",
        icon: React.createElement(Hourglass, { className: "h-3.5 w-3.5 text-warning", "aria-hidden": true }),
        tone: "border-warning/30 bg-warning/5",
    },
    failed: {
        label: "Failed",
        icon: (React.createElement(AlertCircle, { className: "h-3.5 w-3.5 text-destructive", "aria-hidden": true })),
        tone: "border-destructive/30 bg-destructive/5",
    },
    stale: {
        label: "Stale",
        icon: (React.createElement(RotateCcw, { className: "h-3.5 w-3.5 text-muted-foreground", "aria-hidden": true })),
        tone: "border-border bg-surface-sunken",
    },
};
export const ReconciliationTile = ({ callerTenantId, recipients, statusMap, submitting, }) => {
    const classified = React.useMemo(() => {
        const out = [];
        for (const r of recipients) {
            const row = classify(callerTenantId, r, statusMap[r.key], submitting);
            if (row)
                out.push(row);
        }
        return out;
    }, [recipients, statusMap, submitting, callerTenantId]);
    const counts = React.useMemo(() => {
        const acc = {
            steady: [],
            aliasOnly: [],
            pendingAcceptance: [],
            failed: [],
            stale: [],
        };
        for (const row of classified)
            acc[row.bucket].push(row);
        return acc;
    }, [classified]);
    if (classified.length === 0)
        return null;
    const allSteady = counts.steady.length === classified.length && classified.length > 0;
    return (React.createElement(Card, { className: cn("transition-colors duration-200 ease-out", allSteady
            ? "border-success/40 bg-success/5"
            : counts.failed.length > 0
                ? "border-destructive/30"
                : "border-border") },
        React.createElement(CardHeader, null,
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                allSteady ? (React.createElement(Sparkles, { className: "h-4 w-4 text-success", "aria-hidden": true })) : (React.createElement(CheckCircle2, { className: "h-4 w-4 text-primary", "aria-hidden": true })),
                "Steady-state reconciliation",
                React.createElement(Badge, { variant: "secondary", className: "text-2xs font-normal" },
                    counts.steady.length,
                    "/",
                    classified.length,
                    " steady")),
            React.createElement(CardDescription, null, allSteady
                ? "All rows reached steady state — subscription IDs are visible in your caller tenant and ready to use."
                : "Outcome breakdown by post-submit state. Use the buckets to triage what still needs the operator's attention.")),
        React.createElement(CardContent, { className: "flex flex-col gap-2" },
            React.createElement("div", { className: "flex flex-wrap gap-1.5 text-2xs" }, Object.keys(BUCKET_META).map((b) => {
                const meta = BUCKET_META[b];
                const count = counts[b].length;
                if (count === 0)
                    return null;
                return (React.createElement("span", { key: b, className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium", meta.tone) },
                    meta.icon,
                    count,
                    " ",
                    meta.label));
            })),
            (counts.aliasOnly.length > 0 ||
                counts.pendingAcceptance.length > 0 ||
                counts.failed.length > 0 ||
                counts.stale.length > 0) && (React.createElement("ul", { className: "mt-1 flex flex-col gap-1 text-2xs" },
                [
                    "failed",
                    "stale",
                    "aliasOnly",
                    "pendingAcceptance",
                ].flatMap((b) => counts[b].slice(0, 3).map((row) => (React.createElement("li", { key: row.key, className: cn("flex items-start gap-2 rounded border px-2 py-1.5", BUCKET_META[b].tone) },
                    BUCKET_META[b].icon,
                    React.createElement("div", { className: "flex min-w-0 flex-1 flex-col" },
                        React.createElement("span", { className: "font-medium text-foreground" }, row.displayLabel),
                        row.note && (React.createElement("span", { className: "text-muted-foreground" }, row.note))),
                    React.createElement("span", { className: "shrink-0 uppercase tracking-wider opacity-70" }, BUCKET_META[b].label))))),
                (counts.aliasOnly.length > 3 ||
                    counts.pendingAcceptance.length > 3 ||
                    counts.failed.length > 3 ||
                    counts.stale.length > 3) && (React.createElement("li", { className: "text-muted-foreground" }, "\u2026more rows in details above (scroll to per-recipient strip).")))),
            React.createElement("p", { className: "mt-1 text-2xs text-muted-foreground" },
                "Cite: ",
                React.createElement("code", { className: "font-mono" }, "_bypass_modify_delete.md"),
                " ",
                "(state-changing ops need explicit follow-up); cross-tenant steady-state per ",
                React.createElement("code", { className: "font-mono" }, "_ea_subscription_cross_tenant.md"),
                " \u00A77."))));
};
//# sourceMappingURL=reconciliation-tile.js.map