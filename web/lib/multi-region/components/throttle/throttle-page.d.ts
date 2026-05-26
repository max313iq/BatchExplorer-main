/**
 * Throttle / Rate-Limit observability page.
 *
 * Renders the live state of the per-(subscription, endpoint-family)
 * token-bucket + circuit-breaker that fronts every Azure API call. The
 * data flow is:
 *
 *   guardedFetch → RequestGuard.observe → setEntry/pushTransition →
 *   MultiRegionStore.throttleStats → this page (subscribed via
 *   useMultiRegionState).
 *
 * Use this page to:
 *   - watch refill-rate degrade as a subscription approaches its quota
 *   - see exactly when a circuit opens, why, and when it'll close
 *   - audit the historical transition log for cascading throttle events
 *   - export the snapshot or history as CSV / JSON for incident reports
 *   - filter by state, endpoint family, or sub id substring
 *
 * The page does not issue any Azure calls of its own — purely a
 * read-only view over the store.
 */
import * as React from "react";
export declare const ThrottlePage: React.FC;
//# sourceMappingURL=throttle-page.d.ts.map