/**
 * Route-aware breadcrumb bar. Used in the dashboard shell header. Reads
 * the current URL via `useLocation` and renders a trail derived from the
 * canonical route map (Design Contract §4.1). Deep-link params (account id,
 * pool id) become trailing crumbs.
 */
import * as React from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";

import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";

interface CrumbDef {
  /** Path matched by the URL (without trailing slash). */
  match: RegExp;
  /** Crumbs to render. The last one becomes BreadcrumbPage (current). */
  crumbs: ReadonlyArray<{ label: string; to?: string }>;
}

/**
 * Static map of routes to breadcrumb trails. Dynamic params are appended at
 * runtime (see resolveDynamicCrumbs below).
 */
const ROUTE_CRUMBS: CrumbDef[] = [
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

export interface BreadcrumbBarProps {
  className?: string;
  /**
   * Optional mapping from URL param values to friendly labels. Pages that
   * navigate to a deep link can call this once they've resolved the
   * underlying entity name (e.g. account display name).
   */
  paramLabels?: Record<string, string>;
}

export const BreadcrumbBar: React.FC<BreadcrumbBarProps> = ({
  className,
  paramLabels,
}) => {
  const location = useLocation();
  const params = useParams();

  const def = ROUTE_CRUMBS.find((r) => r.match.test(location.pathname));
  const crumbs: Array<{ label: string; to?: string }> = [];
  crumbs.push(HOME_CRUMB);
  if (def) {
    for (const c of def.crumbs) {
      crumbs.push({ ...c });
    }
  } else {
    crumbs.push({ label: "Unknown" });
  }

  // Replace the trailing "Detail" placeholder with a friendlier label when a
  // param is present (or paramLabels provides one).
  const last = crumbs[crumbs.length - 1];
  if (last && last.label === "Detail") {
    const paramValue =
      params.poolId ??
      params.accountId ??
      params.tenantId ??
      Object.values(params).find(Boolean);
    if (paramValue) {
      const friendly = paramLabels?.[paramValue] ?? paramValue;
      last.label = friendly;
    }
  }

  return (
    <Breadcrumb className={cn("min-w-0", className)}>
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          const isHome = i === 0;
          return (
            <React.Fragment key={`${c.label}-${i}`}>
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage className="truncate">
                    {isHome ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Home className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">Home</span>
                      </span>
                    ) : (
                      c.label
                    )}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={c.to ?? "/"}>
                      {isHome ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Home className="h-3 w-3" aria-hidden="true" />
                          <span className="sr-only">Home</span>
                        </span>
                      ) : (
                        c.label
                      )}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && (
                <BreadcrumbSeparator>
                  <ChevronRight className="h-3 w-3" />
                </BreadcrumbSeparator>
              )}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
};
