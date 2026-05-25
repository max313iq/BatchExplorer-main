/**
 * Continuous Access Evaluation (CAE) / claims-challenge auto-handler.
 *
 * Background
 * ----------
 * Azure AD issues long-lived (24 h) access tokens to CAE-aware clients but
 * keeps the right to invalidate them mid-session in response to risk
 * signals — revoked sessions, IP location changes, MFA policy bumps,
 * tenant-admin "revoke all", etc. The mechanism it uses is a
 * "claims challenge": the resource server (ARM, Graph, Storage, etc.)
 * responds with `HTTP 401` and a `WWW-Authenticate: Bearer ...` header
 * carrying a `claims="<base64url-encoded JSON>"` parameter. The client is
 * expected to:
 *
 *   1. Parse the `claims` parameter out of the WWW-Authenticate header.
 *   2. base64url-decode it back into a JSON string.
 *   3. Hand the JSON string back to AAD's `/oauth2/v2.0/token` endpoint as
 *      `claims=<...>` so AAD mints a fresh access token that satisfies
 *      whatever the resource server demanded (e.g. step-up MFA).
 *   4. Retry the failed resource request with the new bearer.
 *
 * If the client does not handle the challenge, the 401 surfaces as a
 * generic "auth expired" error to the operator even though the SSO
 * session is actually fine and a silent re-acquire would have succeeded.
 *
 * Integration pattern (opt-in, per call-site)
 * -------------------------------------------
 * `guardedFetch` is intentionally NOT modified — the rate-limit /
 * circuit-breaker layer has no business knowing about token semantics, and
 * baking CAE recovery into every outbound call would force every caller to
 * supply a token re-acquirer even when they don't care.
 *
 * Instead callers wrap their existing fetch in `withCaeRecovery`:
 *
 *   const result = await withCaeRecovery(
 *     async (token) => {
 *       const resp = await guardedFetch(url, {
 *         headers: { Authorization: `Bearer ${token}` },
 *       }, { subscriptionId, family: "arm" });
 *       if (!resp.ok) throw new HttpError(resp);
 *       return resp.json();
 *     },
 *     {
 *       initialToken: armToken,
 *       getFreshTokenWithClaims: (claims) =>
 *         acquireArmTokenSilentWithClaims(account, tenantId, claims),
 *     },
 *   );
 *
 * The `getFreshTokenWithClaims` operator is responsible for calling MSAL's
 * `acquireTokenSilent({ ..., claims })` (or device-code / popup if MSAL
 * raises `InteractionRequired`). This file does not depend on MSAL — it is
 * a pure helper so it can be unit-tested with mock token-acquirers and
 * reused outside MSAL (device-code flow, imported tokens, etc.).
 *
 * Token material is never logged. The CAE challenge JSON itself is safe
 * to log (it carries policy ids, not credentials) but we don't bother;
 * structured logging is the caller's choice.
 */

/* ------------------------------------------------------------------ */
/*  parseCaeChallenge                                                  */
/* ------------------------------------------------------------------ */

/**
 * Extract the `claims="..."` parameter from a `WWW-Authenticate: Bearer`
 * header and return its base64url-decoded JSON string.
 *
 * Returns `null` when:
 *   - The header is missing / empty.
 *   - The header does not contain a `claims=...` parameter.
 *   - The encoded value can't be base64-decoded.
 *
 * The returned string is the verbatim JSON challenge — the caller forwards
 * it as the `claims=` form field on the token request. We deliberately do
 * NOT JSON.parse it; AAD wants the raw string back and re-serializing
 * could change whitespace / key ordering in a way that breaks the
 * downstream policy check.
 *
 * RFC 7235 section 4.1 permits parameters in any order, with optional
 * whitespace, and quoted-string values can contain escaped quotes. The
 * regex below is loose by design — it tolerates `claims=...` (unquoted),
 * `claims="..."` (quoted), and `Claims=...` (case-insensitive), and it
 * stops at the next `,` outside the quoted string. Real-world AAD
 * responses always emit `claims="<b64url>"` (quoted) so the unquoted path
 * is more defensive than necessary.
 */
export function parseCaeChallenge(wwwAuthHeader: string): string | null {
  if (!wwwAuthHeader) return null;

  // Quoted form: claims="<value>". Allow whitespace around the `=`,
  // honor backslash-escaped quotes inside (AAD never uses them today but
  // the RFC permits them).
  const quoted = /claims\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(wwwAuthHeader);
  let encoded: string | null = null;
  if (quoted) {
    encoded = quoted[1].replace(/\\(.)/g, "$1");
  } else {
    // Unquoted form: claims=<token> — token ends at whitespace, comma, or
    // end-of-header per RFC 7235 token68 grammar.
    const unquoted = /claims\s*=\s*([^\s,]+)/i.exec(wwwAuthHeader);
    if (unquoted) encoded = unquoted[1];
  }
  if (!encoded) return null;

  return base64UrlDecodeToString(encoded);
}

/**
 * Browser-safe base64url → UTF-8 string. Handles missing padding and the
 * `-` / `_` url-safe variants. Returns null on malformed input.
 */
function base64UrlDecodeToString(input: string): string | null {
  if (!input) return null;
  try {
    // Normalize url-safe variant to plain base64 + add padding.
    let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad === 2) b64 += "==";
    else if (pad === 3) b64 += "=";
    else if (pad !== 0) return null;

    const binary = atob(b64);
    // atob() returns a binary string. The CAE challenge body is always
    // ASCII JSON, so a simple charCode roundtrip via decodeURIComponent
    // works AND avoids the TextDecoder dependency (jsdom in some Jest
    // setups doesn't expose `TextDecoder` as a global — we use the
    // universally-available `decodeURIComponent(escape(...))` trick).
    if (typeof TextDecoder === "function") {
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    // Fallback: percent-encode then decode. The CAE challenge is always
    // pure-ASCII JSON in practice, so this is exact for the realistic
    // input set; falls back to a best-effort byte string for hypothetical
    // non-ASCII tails.
    try {
      return decodeURIComponent(escape(binary));
    } catch {
      return binary;
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  withCaeRecovery                                                    */
/* ------------------------------------------------------------------ */

/**
 * Special error shape that the caller throws from inside the fetch
 * callback so `withCaeRecovery` can inspect the original `WWW-Authenticate`
 * header without us assuming a specific Response wrapper type.
 *
 * Usage: when the resource call returns a 401, the caller MUST throw an
 * error whose `status === 401` AND `wwwAuthenticate` is set to the raw
 * header value. Other 401 shapes are NOT auto-recovered — they bubble
 * unchanged (correct behavior for "token expired" / "no policy challenge"
 * which is what a stale-token error looks like).
 */
export interface CaeChallengeError extends Error {
  status: number;
  wwwAuthenticate: string;
}

/**
 * Type guard for the shape above. Defensive — `error instanceof Error`
 * isn't reliable across realms (microfrontends, iframes) so we duck-type.
 */
function isCaeChallengeError(err: unknown): err is CaeChallengeError {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    e.status === 401 &&
    typeof e.wwwAuthenticate === "string" &&
    (e.wwwAuthenticate as string).length > 0
  );
}

export interface WithCaeRecoveryOptions {
  /**
   * Token to use on the first attempt. After a successful recovery the
   * fresh token is passed to the retry — callers do NOT need to update
   * any external state, but they may choose to (e.g. write the new token
   * back into a per-account cache so the next call uses it directly).
   */
  initialToken: string;

  /**
   * Operator-supplied token re-acquirer. Receives the decoded JSON
   * challenge (verbatim — pass it straight through to MSAL or to the
   * /oauth2/v2.0/token endpoint as the `claims` parameter).
   *
   * Must resolve to a fresh access token that satisfies the challenge.
   * If the re-acquire itself fails (network, interaction-required,
   * cancelled popup, etc.) the caller should let the error propagate —
   * we do not retry the recovery itself.
   */
  getFreshTokenWithClaims: (claimsJson: string) => Promise<string>;

  /**
   * Optional callback fired after a successful recovery, before the retry.
   * Use it to e.g. persist the new token, log the event, or bump an
   * audit-log entry. Does NOT receive the token (intentional — surface
   * area for accidental log leaks should be zero).
   */
  onRecovered?: (info: { challengeJson: string }) => void;
}

/**
 * Run a resource fetch and transparently recover from a single CAE
 * claims-challenge if one occurs. On any other error the original error
 * is re-thrown without modification.
 *
 * Retry count is hard-capped at ONE — if the resource server returns
 * another claims challenge after we just supplied fresh `claims=` we
 * surface the second 401 so the operator can intervene. This guards
 * against infinite-loop pathologies where AAD and the resource server
 * disagree about what challenge is "satisfied".
 *
 * Generic over `T` so JSON / blob / void responses all flow through
 * unchanged.
 */
export async function withCaeRecovery<T>(
  fn: (token: string) => Promise<T>,
  opts: WithCaeRecoveryOptions,
): Promise<T> {
  try {
    return await fn(opts.initialToken);
  } catch (err: unknown) {
    if (!isCaeChallengeError(err)) {
      throw err;
    }
    const challenge = parseCaeChallenge(err.wwwAuthenticate);
    if (!challenge) {
      // 401 was a vanilla auth failure with no claims= parameter. Nothing
      // we can do without prompting the user — let the caller handle it
      // (typically by calling acquireTokenSilent without claims, which
      // will surface InteractionRequired if the session has actually
      // ended).
      throw err;
    }
    const freshToken = await opts.getFreshTokenWithClaims(challenge);
    opts.onRecovered?.({ challengeJson: challenge });
    return await fn(freshToken);
  }
}

/* ------------------------------------------------------------------ */
/*  Helper for converting a Response into a CaeChallengeError          */
/* ------------------------------------------------------------------ */

/**
 * Convenience builder: given a 401 Response, returns a `CaeChallengeError`
 * shape suitable for `throw` inside the fetch callback. Returns null if
 * the response is not a 401 OR has no `WWW-Authenticate` header.
 *
 * Callers can ignore this helper and construct the error themselves
 * (useful when the network layer already wraps Response in a typed
 * error). It exists so the documented pattern stays one line.
 */
export function buildCaeChallengeError(
  response: Response,
  fallbackMessage?: string,
): CaeChallengeError | null {
  if (response.status !== 401) return null;
  const wwwAuth = response.headers.get("WWW-Authenticate");
  if (!wwwAuth) return null;
  const err = new Error(
    fallbackMessage ?? `HTTP 401 (CAE claims challenge)`,
  ) as CaeChallengeError;
  err.status = 401;
  err.wwwAuthenticate = wwwAuth;
  return err;
}
