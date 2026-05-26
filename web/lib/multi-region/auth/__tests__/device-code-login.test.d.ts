/**
 * Targeted tests for the device-code flow tightening done in 2026-05-25:
 *   - tenant-mismatch on the polled token's `tid` claim
 *   - `interaction_required` is treated as terminal, not "keep polling"
 *
 * device-code-login.ts transitively imports msal-auth.ts (for
 * decodeJwtClaimsUnsafe), which imports @azure/msal-browser. The
 * redirect-bridge submodule is unresolvable under jest's resolver
 * (it ships only at build time via webpack alias), so we stub it.
 */
export {};
//# sourceMappingURL=device-code-login.test.d.ts.map