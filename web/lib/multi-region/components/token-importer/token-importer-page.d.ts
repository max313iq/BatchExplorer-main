/**
 * Token Importer — paste a bearer token from any Azure login (e.g.
 * portal.azure.com via DevTools) and use it as the credential for ARM
 * / Graph / Batch calls in this app, bypassing MSAL entirely.
 *
 * Workflow:
 *   1. Operator runs the snippet below in DevTools on portal.azure.com.
 *   2. Copies the JWT it logs to the console.
 *   3. Pastes into the textarea here. We decode + preview the claims.
 *   4. Click "Import" → token cached in localStorage, pseudo-account
 *      pushed into the store so other pages can see it in their pickers.
 *   5. The rest of the app uses the imported token instead of MSAL until
 *      the JWT's own `exp` claim expires.
 *
 * No silent refresh path for raw access-token imports — when an access
 * token expires the operator re-imports. Refresh-token imports DO refresh
 * silently via the auth module's `redeemRefreshToken` round-trip.
 *
 * Hardened for:
 *   - setState-after-unmount via a `mountedRef` guarding every async
 *     completion path (both the redemption flow AND clipboard reads).
 *   - Race conditions on concurrent submits via the `redeemAbortRef`
 *     abort controller plus a `submitGenerationRef` token check on
 *     completion (latest-wins).
 *   - Silent parse failures in the curl/JSON paste auto-extractor — any
 *     swallowed exception is surfaced via an `rtExtractWarning` banner so
 *     the operator knows we tried something and it didn't fit.
 */
import * as React from "react";
import type { AudienceBucket } from "../../auth/imported-tokens";
export declare const TokenImporterPage: React.FC;
export declare const _TokenImporterIcons: {
    Loader2: React.ForwardRefExoticComponent<Omit<import("lucide-react").LucideProps, "ref"> & React.RefAttributes<SVGSVGElement>>;
    AUDIENCE_ORDER: AudienceBucket[];
};
//# sourceMappingURL=token-importer-page.d.ts.map