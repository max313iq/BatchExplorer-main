/**
 * Service Principal credential login tab — sibling of the user-account
 * tricky-login flow, mounted under the Tricky Login page as a second
 * top-level Tabs section.
 *
 * Three sub-modes:
 *   1. Client Secret   — `grant_type=client_credentials` (app-only token).
 *   2. Certificate     — out-of-scope for a browser SPA (private-key
 *      assertion signing needs WebCrypto + DER parsing; we surface a
 *      explanation note instead of silently failing).
 *   3. OBO (On-Behalf-Of) — `grant_type=urn:ietf:params:oauth:grant-type:
 *      jwt-bearer` with a user access token as the assertion, exchanged
 *      for a downstream-scoped token via the same client.
 *
 * Both POST flows go through the same dev-server `/api/auth/proxy-token`
 * relay MSAL uses (`x-proxy-target` header → AAD's
 * `/oauth2/v2.0/token`). This dodges AAD's browser CORS reject on direct
 * `client_credentials` POSTs (AAD only sets CORS headers for public-client
 * `authorization_code` + `refresh_token` grants).
 *
 * Audit:
 *   action: tricky_login_sp_mint
 *   details: { tenantId, clientId, scope, mode, durationMs }
 *   NEVER includes the secret, NEVER includes the returned token.
 *
 * The result panel renders decoded claims, a copy button, and an
 * "Import to vault" button that uses the same `previewToken` +
 * `importToken` plumbing as the user-flow result panel.
 */
import * as React from "react";
export declare const SpLoginTab: React.FC;
//# sourceMappingURL=sp-login-tab.d.ts.map