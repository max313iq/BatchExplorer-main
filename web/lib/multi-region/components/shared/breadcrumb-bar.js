/**
 * Route-aware breadcrumb bar. Used in the dashboard shell header. Reads
 * the current URL via `useLocation` and renders a trail derived from the
 * canonical route map (Design Contract §4.1). Deep-link params (account id,
 * pool id) become trailing crumbs.
 */
import * as React from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator, } from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
/**
 * Static map of routes to breadcrumb trails. Dynamic params are appended at
 * runtime (see resolveDynamicCrumbs below).
 */
const ROUTE_CRUMBS = [
    {
        match: /^\/azure-accounts$/,
        crumbs: [{ label: "Azure Accounts" }],
    },
    {
        match: /^\/overview$/,
        crumbs: [{ label: "Overview" }],
    },
    {
        match: /^\/accounts$/,
        crumbs: [{ label: "Accounts" }],
    },
    {
        match: /^\/accounts\/[^/]+$/,
        crumbs: [
            { label: "Accounts", to: "/accounts" },
            { label: "Detail" },
        ],
    },
    {
        match: /^\/account-info\/?$/,
        crumbs: [{ label: "Account Info" }],
    },
    {
        match: /^\/account-info\/[^/]+$/,
        crumbs: [
            { label: "Account Info", to: "/account-info" },
            { label: "Detail" },
        ],
    },
    {
        match: /^\/pools$/,
        crumbs: [{ label: "Pools" }],
    },
    {
        match: /^\/pools\/[^/]+$/,
        crumbs: [
            { label: "Pools", to: "/pools" },
            { label: "Detail" },
        ],
    },
    {
        match: /^\/pool-defaults$/,
        crumbs: [{ label: "Pool Settings" }],
    },
    {
        match: /^\/pool-info\/?$/,
        crumbs: [{ label: "Pool Info" }],
    },
    {
        match: /^\/pool-info\/[^/]+$/,
        crumbs: [
            { label: "Pool Info", to: "/pool-info" },
            { label: "Detail" },
        ],
    },
    {
        match: /^\/nodes$/,
        crumbs: [{ label: "Nodes" }],
    },
    {
        match: /^\/unused-quota$/,
        crumbs: [{ label: "Unused Quota" }],
    },
    {
        match: /^\/monitoring$/,
        crumbs: [{ label: "Monitoring" }],
    },
    {
        match: /^\/gpu-calculator$/,
        crumbs: [{ label: "GPU Calculator" }],
    },
    {
        match: /^\/audit-log$/,
        crumbs: [{ label: "Audit Log" }],
    },
    {
        match: /^\/tenant-users$/,
        crumbs: [{ label: "Tenant Users" }],
    },
    {
        match: /^\/user-creator$/,
        crumbs: [{ label: "Create User" }],
    },
    {
        match: /^\/ea-subscription$/,
        crumbs: [{ label: "Create EA Subscription" }],
    },
    {
        match: /^\/tasks$/,
        crumbs: [{ label: "Task Manager" }],
    },
    {
        match: /^\/throttle$/,
        crumbs: [{ label: "Throttle Status" }],
    },
    {
        match: /^\/vm-catalog$/,
        crumbs: [{ label: "VM Catalog" }],
    },
];
const HOME_CRUMB = { label: "Home", to: "/" };
export const BreadcrumbBar = ({ className, paramLabels, }) => {
    var _a, _b, _c, _d;
    const location = useLocation();
    const params = useParams();
    const def = ROUTE_CRUMBS.find((r) => r.match.test(location.pathname));
    const crumbs = [];
    crumbs.push(HOME_CRUMB);
    if (def) {
        for (const c of def.crumbs) {
            crumbs.push(Object.assign({}, c));
        }
    }
    else {
        crumbs.push({ label: "Unknown" });
    }
    // Replace the trailing "Detail" placeholder with a friendlier label when a
    // param is present (or paramLabels provides one).
    const last = crumbs[crumbs.length - 1];
    if (last && last.label === "Detail") {
        const paramValue = (_c = (_b = (_a = params.poolId) !== null && _a !== void 0 ? _a : params.accountId) !== null && _b !== void 0 ? _b : params.tenantId) !== null && _c !== void 0 ? _c : Object.values(params).find(Boolean);
        if (paramValue) {
            const friendly = (_d = paramLabels === null || paramLabels === void 0 ? void 0 : paramLabels[paramValue]) !== null && _d !== void 0 ? _d : paramValue;
            last.label = friendly;
        }
    }
    return (React.createElement(Breadcrumb, { className: cn("min-w-0", className) },
        React.createElement(BreadcrumbList, null, crumbs.map((c, i) => {
            var _a;
            const isLast = i === crumbs.length - 1;
            const isHome = i === 0;
            return (React.createElement(React.Fragment, { key: `${c.label}-${i}` },
                React.createElement(BreadcrumbItem, null, isLast ? (React.createElement(BreadcrumbPage, { className: "truncate" }, isHome ? (React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                    React.createElement(Home, { className: "h-3 w-3", "aria-hidden": "true" }),
                    React.createElement("span", { className: "sr-only" }, "Home"))) : (c.label))) : (React.createElement(BreadcrumbLink, { asChild: true },
                    React.createElement(Link, { to: (_a = c.to) !== null && _a !== void 0 ? _a : "/" }, isHome ? (React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                        React.createElement(Home, { className: "h-3 w-3", "aria-hidden": "true" }),
                        React.createElement("span", { className: "sr-only" }, "Home"))) : (c.label))))),
                !isLast && (React.createElement(BreadcrumbSeparator, null,
                    React.createElement(ChevronRight, { className: "h-3 w-3" })))));
        }))));
};
//# sourceMappingURL=breadcrumb-bar.js.map