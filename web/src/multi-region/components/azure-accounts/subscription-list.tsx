/**
 * Subscription list — displays an account's subscriptions inside the
 * Azure Accounts drawer's "Subscriptions" tab.
 *
 * Extracted from `azure-accounts-page.tsx` (which was ~3,150 lines and
 * had several disjoint sub-features mixed together) to keep the parent
 * file focused on accounts-level orchestration. Behavior is
 * byte-identical to the in-file version it replaced — only the import
 * site changed.
 */
import * as React from "react";
import { Database, Layers, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

import { CopyButton } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import type {
  AzureLoginAccount,
  AzureLoginSubscription,
} from "../../store/store-types";

const SUB_SEARCH_DEBOUNCE_MS = 150;

function truncateMiddle(value: string, head = 8, tail = 4): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export interface SubscriptionListProps {
  account: AzureLoginAccount;
}

export const SubscriptionList: React.FC<SubscriptionListProps> = ({
  account,
}) => {
  const [subSearch, setSubSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [showDisabledSubs, setShowDisabledSubs] = React.useState(false);

  // Debounce so each keystroke doesn't re-filter the entire list while
  // the operator is typing. 150ms feels instant.
  React.useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(subSearch),
      SUB_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [subSearch]);

  const enabledSubs = React.useMemo(
    () =>
      account.subscriptions.filter(
        (s) => (s.state ?? "Enabled") === "Enabled",
      ),
    [account.subscriptions],
  );
  const disabledSubs = React.useMemo(
    () =>
      account.subscriptions.filter(
        (s) => (s.state ?? "Enabled") !== "Enabled",
      ),
    [account.subscriptions],
  );

  const filteredEnabledSubs = React.useMemo(() => {
    if (!debouncedSearch) return enabledSubs;
    const term = debouncedSearch.toLowerCase();
    return enabledSubs.filter(
      (sub) =>
        (sub.displayName ?? "").toLowerCase().includes(term) ||
        (sub.subscriptionId ?? "").toLowerCase().includes(term),
    );
  }, [enabledSubs, debouncedSearch]);

  const filteredDisabledSubs = React.useMemo(() => {
    if (!debouncedSearch) return disabledSubs;
    const term = debouncedSearch.toLowerCase();
    return disabledSubs.filter(
      (sub) =>
        (sub.displayName ?? "").toLowerCase().includes(term) ||
        (sub.subscriptionId ?? "").toLowerCase().includes(term),
    );
  }, [disabledSubs, debouncedSearch]);

  if (account.status === "loading") {
    return (
      <div
        className="flex flex-col gap-2 py-1"
        role="progressbar"
        aria-label="Loading subscriptions"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-border/40 py-1.5 last:border-b-0"
          >
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-2.5 w-2/3" />
            </div>
            <Skeleton className="h-4 w-12" />
          </div>
        ))}
      </div>
    );
  }

  if (account.status === "error") {
    return (
      <ErrorState
        message="Failed to load subscriptions."
        detail={account.error ?? undefined}
        size="compact"
      />
    );
  }

  if (account.subscriptions.length === 0) {
    return (
      <EmptyState
        icon={Database}
        title="No subscriptions"
        description="This tenant has no subscriptions visible to this account."
      />
    );
  }

  return (
    <div>
      <div className="relative mb-2 max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Filter subscriptions..."
          value={subSearch}
          aria-label="Filter subscriptions"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setSubSearch(e.target.value)
          }
          className="h-8 pl-8 text-xs"
        />
      </div>
      <p className="mb-1 text-2xs text-muted-foreground">
        {debouncedSearch ? (
          <>
            {filteredEnabledSubs.length} of {enabledSubs.length} active matches
          </>
        ) : (
          <>
            {enabledSubs.length} active
            {disabledSubs.length > 0 && ` · ${disabledSubs.length} disabled`}
          </>
        )}
      </p>
      {filteredEnabledSubs.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          {debouncedSearch
            ? "No matching active subscriptions"
            : "No active subscriptions in this tenant"}
        </p>
      ) : (
        <ul role="list" className="flex flex-col">
          {filteredEnabledSubs.map((sub: AzureLoginSubscription) => (
            <li
              key={sub.subscriptionId}
              role="listitem"
              className="group/copy flex items-center gap-3 border-b border-border/60 py-1.5 last:border-b-0"
            >
              <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground">
                  {sub.displayName}
                </p>
                <div
                  className="flex items-center gap-1.5"
                  title={sub.subscriptionId}
                >
                  <p className="truncate font-mono text-2xs text-muted-foreground">
                    {truncateMiddle(sub.subscriptionId, 12, 6)}
                  </p>
                  <CopyButton
                    value={sub.subscriptionId}
                    ariaLabel={`Copy subscription id ${sub.displayName}`}
                  />
                </div>
              </div>
              <Badge
                variant="success"
                role="status"
                aria-label={`Subscription state: ${sub.state}`}
                title="Subscription is active"
              >
                {sub.state}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {disabledSubs.length > 0 && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <button
            type="button"
            onClick={() => setShowDisabledSubs((v) => !v)}
            aria-expanded={showDisabledSubs}
            aria-controls={`disabled-subs-${account.homeAccountId}`}
            className="flex items-center gap-1.5 text-2xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-reduce:transition-none"
          >
            <span>
              {showDisabledSubs ? "Hide" : "Show"} {disabledSubs.length} disabled
              subscription
              {disabledSubs.length === 1 ? "" : "s"}
            </span>
          </button>
          {showDisabledSubs && (
            <ul
              role="list"
              id={`disabled-subs-${account.homeAccountId}`}
              className="mt-1.5 flex flex-col"
            >
              {filteredDisabledSubs.map((sub: AzureLoginSubscription) => (
                <li
                  key={sub.subscriptionId}
                  role="listitem"
                  className="group/copy flex items-center gap-3 border-b border-border/40 py-1.5 opacity-60 last:border-b-0"
                >
                  <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-muted-foreground">
                      {sub.displayName}
                    </p>
                    <div
                      className="flex items-center gap-1.5"
                      title={sub.subscriptionId}
                    >
                      <p className="truncate font-mono text-2xs text-muted-foreground/70">
                        {truncateMiddle(sub.subscriptionId, 12, 6)}
                      </p>
                      <CopyButton
                        value={sub.subscriptionId}
                        ariaLabel={`Copy disabled subscription id ${sub.displayName}`}
                      />
                    </div>
                  </div>
                  <Badge
                    variant="secondary"
                    role="status"
                    aria-label={`Subscription state: ${sub.state}`}
                    title={`Subscription is ${sub.state}. Skipped — only Enabled subscriptions are used.`}
                  >
                    {sub.state}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
