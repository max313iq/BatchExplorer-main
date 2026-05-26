/**
 * Targeted tests for foci-exchange.ts — covers the direct-then-proxy
 * fallback added in 2026-05-25 + the curated FOCI list invariants.
 *
 * foci-exchange.ts transitively imports msal-auth.ts (for
 * decodeJwtClaimsUnsafe), which imports @azure/msal-browser. The
 * redirect-bridge submodule is unresolvable under jest's resolver
 * (it ships only at build time via webpack alias), so we stub it.
 */
export {};
//# sourceMappingURL=foci-exchange.test.d.ts.map