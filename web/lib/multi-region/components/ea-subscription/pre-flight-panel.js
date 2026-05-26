/**
 * PreFlightPanel — surfaces corpus-grounded signatures and a pre-create
 * simulation BEFORE the operator clicks submit. Read-only, never mutates
 * the form; it exists so the audit trail / SIEM picture the operator
 * expects matches what will actually fire.
 *
 * Grounded in `_ea_subscription_cross_tenant.md` (cross-tenant attack
 * shape) and `_bypass_role_grant.md` (billing-role chain effects).
 *
 * Renders nothing when there are no recipients yet — keeps the page
 * quiet during the early scope-pick phase.
 */
import * as React from "react";
import { AlertTriangle, Eye, ListTree, ShieldAlert, ShieldCheck, Sparkles, } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { computeSignatures, simulatePreCreate, } from "./corpus-signatures";
const severityClass = (sev) => {
    switch (sev) {
        case "critical":
            return "border-destructive/40 bg-destructive/5";
        case "warning":
            return "border-warning/40 bg-warning/5";
        case "notice":
            return "border-info/40 bg-info/5";
        case "info":
        default:
            return "border-border bg-surface-sunken";
    }
};
const severityIcon = (sev) => {
    switch (sev) {
        case "critical":
            return (React.createElement(ShieldAlert, { className: "h-3.5 w-3.5 shrink-0 text-destructive", "aria-hidden": true }));
        case "warning":
            return (React.createElement(AlertTriangle, { className: "h-3.5 w-3.5 shrink-0 text-warning", "aria-hidden": true }));
        case "notice":
            return React.createElement(Eye, { className: "h-3.5 w-3.5 shrink-0 text-info", "aria-hidden": true });
        case "info":
        default:
            return (React.createElement(ShieldCheck, { className: "h-3.5 w-3.5 shrink-0 text-success", "aria-hidden": true }));
    }
};
const tenantBadgeTone = (scope) => {
    if (scope === "destination")
        return "outline";
    if (scope === "azure-activity")
        return "outline";
    return "secondary";
};
export const PreFlightPanel = ({ callerTenantId, callerTenantLabel, callerUpn, recipients, }) => {
    const findings = React.useMemo(() => computeSignatures({
        callerTenantId,
        callerUpn,
        recipients,
    }), [callerTenantId, callerUpn, recipients]);
    const crossTenantCount = React.useMemo(() => {
        const home = callerTenantId.toLowerCase();
        return recipients.reduce((acc, r) => acc + (r.tenantId.toLowerCase() !== home ? 1 : 0), 0);
    }, [recipients, callerTenantId]);
    const simulated = React.useMemo(() => simulatePreCreate({
        recipientCount: recipients.length,
        crossTenantCount,
        callerTenantLabel,
    }), [recipients.length, crossTenantCount, callerTenantLabel]);
    if (recipients.length === 0)
        return null;
    const headlineSeverity = findings.find((f) => f.severity === "critical")
        ? "critical"
        : findings.find((f) => f.severity === "warning")
            ? "warning"
            : findings.find((f) => f.severity === "notice")
                ? "notice"
                : "info";
    return (React.createElement(Card, { className: cn("transition-colors duration-200 ease-out", severityClass(headlineSeverity)) },
        React.createElement(CardHeader, null,
            React.createElement(CardTitle, { className: "flex items-center gap-2 text-sm" },
                React.createElement(Sparkles, { className: "h-4 w-4 text-primary", "aria-hidden": true }),
                "Pre-flight Cross-Tenant Signature",
                findings.length > 0 && (React.createElement(Badge, { variant: "secondary", className: cn("text-2xs font-normal", headlineSeverity === "critical" &&
                        "bg-destructive/10 text-destructive", headlineSeverity === "warning" &&
                        "bg-warning/15 text-warning", headlineSeverity === "notice" && "bg-info/10 text-info") },
                    findings.length,
                    " finding",
                    findings.length === 1 ? "" : "s"))),
            React.createElement(CardDescription, null, "Corpus-grounded shape checks (read-only). These never block the submit \u2014 they highlight batches that look like documented EA abuse patterns so you can confirm intent before committing irreversible billing operations.")),
        React.createElement(CardContent, { className: "flex flex-col gap-3" },
            findings.length === 0 ? (React.createElement("div", { className: "flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-2xs", role: "status" },
                React.createElement(ShieldCheck, { className: "h-3.5 w-3.5 shrink-0 text-success", "aria-hidden": true }),
                React.createElement("p", null, "No suspicious signatures detected in the proposed batch. The shape matches typical operator workflow (low cross-tenant count, owners well-resolved, sources consistent)."))) : (React.createElement("ul", { className: "flex flex-col gap-2", role: "list", "aria-label": "Pre-flight signature findings" }, findings.map((f) => (React.createElement("li", { key: f.id, className: cn("flex items-start gap-2 rounded-md border px-3 py-2 text-2xs", severityClass(f.severity)) },
                severityIcon(f.severity),
                React.createElement("div", { className: "flex min-w-0 flex-1 flex-col gap-1" },
                    React.createElement("p", { className: "text-xs font-medium text-foreground" }, f.title),
                    React.createElement("p", { className: "text-muted-foreground" }, f.detail),
                    React.createElement("p", { className: "font-mono text-2xs text-muted-foreground/80" },
                        "cite: ",
                        f.citation))))))),
            React.createElement("details", { className: "rounded-md border border-border bg-card px-3 py-2 text-2xs" },
                React.createElement("summary", { className: "flex cursor-pointer items-center gap-1.5 text-xs font-medium text-foreground" },
                    React.createElement(ListTree, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                    "Simulate audit events (",
                    simulated.length,
                    " expected)"),
                React.createElement("ol", { className: "mt-2 flex flex-col gap-1.5 pl-1" }, simulated.map((s) => (React.createElement("li", { key: s.order, className: "flex items-start gap-2 rounded border border-border/50 bg-background/60 px-2 py-1.5" },
                    React.createElement("span", { className: "tabular-nums font-mono text-muted-foreground" },
                        s.order,
                        "."),
                    React.createElement("div", { className: "flex min-w-0 flex-1 flex-col gap-0.5" },
                        React.createElement("span", { className: "flex flex-wrap items-center gap-1.5" },
                            React.createElement("code", { className: "font-mono text-foreground" }, s.event),
                            React.createElement(Badge, { variant: tenantBadgeTone(s.tenant), className: "text-2xs font-normal" }, s.tenant === "caller"
                                ? "caller tenant"
                                : s.tenant === "destination"
                                    ? "destination tenant"
                                    : "Azure Activity")),
                        React.createElement("span", { className: "text-muted-foreground" }, s.detail)))))),
                React.createElement("p", { className: "mt-2 text-muted-foreground" },
                    "Tip: the per-recipient and batch-level event names above match the actual ",
                    React.createElement("code", null, "auditLog.record"),
                    " calls in this page, so an SIEM filter built against these names will match real events.")))));
};
//# sourceMappingURL=pre-flight-panel.js.map