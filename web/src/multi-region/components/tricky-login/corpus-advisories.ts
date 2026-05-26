/**
 * Corpus-grounded operator advisories for the Tricky Login page.
 *
 * These helpers compute defensive-side warnings derived from CLAIM and
 * REALM metadata the page already has. They cite the master research
 * corpus at C:\Users\baimgprodsesa1\Desktop\New folder\ and refer
 * operators to specific playbook sections so the advisory is actionable
 * rather than a vague "something looks off" toast.
 *
 * HARD SECURITY CONSTRAINTS (enforced here by construction):
 *   - These functions accept ONLY metadata (claim values, status flags,
 *     realm protocol strings). They never receive access tokens, refresh
 *     tokens, secrets, or any other credential material as input.
 *   - They return plain advisory objects with TEXT ONLY — no token
 *     fragments, no credential material, no claim payloads passed
 *     through verbatim.
 *   - All payloads are safe to render to the DOM and safe to log to the
 *     audit channel as metadata (operator advisory count + ids only —
 *     callers must NOT pass the raw claim payload into the audit log).
 *
 * Corpus references:
 *   - `_bypass_login.md` §2.5 (skip-MFA endpoint catalog — device-code
 *     timing) and §"Device code phishing" pivots
 *   - `_analysis_aadinternals.md` §2.4 "The Federation Backdoor"
 *   - `_AZURE_LOGIN_METHODS.md` (programmer's reference for the wire
 *     shape of each auth flow)
 */
import type { TrickyAudienceId, TrickyLoginMethod } from "./tricky-login-helpers";

/* ---------------------------------------------------------------------- */
/* Advisory types                                                          */
/* ---------------------------------------------------------------------- */

/** Severity tone for the advisory chip in the UI. */
export type AdvisorySeverity = "info" | "warning" | "danger";

/**
 * Stable advisory identifier — used as a React key, surfaced to the
 * audit log as metadata (e.g. `{ advisoryIds: ["fed-backdoor-suspect"] }`),
 * and used by hide/dismiss code if we ever add that. NOT a free-form
 * string at the call-site — bind to one of these literals.
 */
export type AdvisoryId =
  | "device-code-unexpected-ip"
  | "device-code-flow-detected"
  | "fed-backdoor-suspect"
  | "fed-recent-rollover"
  | "non-managed-realm-mismatch"
  | "guest-token-acct-1"
  | "amr-absent"
  | "issuer-mismatch";

/** A single operator advisory ready to render. */
export interface OperatorAdvisory {
  /** Stable id (bound type — see AdvisoryId). */
  id: AdvisoryId;
  /** Tone for the chip / alert. */
  severity: AdvisorySeverity;
  /** Short headline (under 60 chars). */
  title: string;
  /**
   * One-paragraph explanation. Plain text — no JSX. The page renders it
   * inside an Alert so it can wrap freely.
   */
  body: string;
  /**
   * Authoritative corpus playbook reference (e.g.
   * "_bypass_login.md §2.5"). Operators can grep the corpus root for it.
   */
  corpusRef: string;
  /**
   * Concrete defensive next step — what the operator should DO if this
   * advisory is real. Plain text.
   */
  action: string;
}

/* ---------------------------------------------------------------------- */
/* Inputs                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Realm-probe summary shape — mirrors the page's local RealmProbeResult
 * but lives here so the advisory module can be unit-tested without
 * importing the page module. METADATA ONLY.
 */
export interface RealmProbeSummary {
  status: "managed" | "federated" | "unknown";
  stsUrl?: string;
  federationProtocol?: string;
  authUrl?: string;
  domainName?: string;
}

/**
 * Metadata-only snapshot of a successful mint that the advisory engine
 * inspects. Token strings MUST NOT be passed — callers should pull the
 * claim payload (which is already in memory in the page) and pass it
 * by reference.
 *
 * Why a separate shape: this is the contract the advisory engine
 * commits to. If a future refactor accidentally tries to pass an
 * `accessToken` field, the TypeScript shape rejects it — making
 * accidental token leakage into advisory code a static impossibility.
 */
export interface AdvisoryMintMeta {
  /** Mint method used (auto resolves to the concrete method). */
  methodUsed: TrickyLoginMethod;
  /** Extended audience id (12-audience picker). */
  extendedAudience?: TrickyAudienceId;
  /** Target tenant id (lower-cased GUID). */
  targetTenantId: string;
  /** Source account home tenant id. */
  sourceHomeTenantId?: string;
  /**
   * Decoded JWT claim payload — passed by reference from the page. The
   * advisory engine reads specific named fields (`iss`, `amr`, `acct`,
   * `idp`) and never echoes the payload back to its caller verbatim.
   */
  claims: Readonly<Record<string, unknown>>;
}

/* ---------------------------------------------------------------------- */
/* JWT shape screen — defense in depth                                     */
/* ---------------------------------------------------------------------- */

/**
 * Defensive screen against accidental token capture. The advisory body
 * runs every string we'd quote inside it through this regex; if the
 * value looks like a JWT we replace it with `<jwt-redacted>`.
 *
 * A real AAD JWT is always >>120 chars and matches the 3-segment
 * base64url shape. We deliberately exclude shorter strings (claim
 * values like `oid`, `tid`, `idp` URLs are well below this length).
 */
function looksLikeJwt(value: string): boolean {
  return (
    value.length > 120 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * Sanitize any free-form string we want to quote inside an advisory
 * body. Strips JWT-shaped material and trims to a reasonable length so
 * one bad claim value can't blow up the layout.
 */
function safeQuote(value: string | undefined, maxLen = 80): string {
  if (!value) return "";
  const v = value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  return looksLikeJwt(v) ? "<jwt-redacted>" : v;
}

/* ---------------------------------------------------------------------- */
/* Heuristics                                                              */
/* ---------------------------------------------------------------------- */

/**
 * Heuristic: federation-backdoor suspicion.
 *
 * Cite: `_analysis_aadinternals.md` §2.4 "The Federation Backdoor
 * (`ConvertTo-Backdoor`)".
 *
 * The AnyDomain.com trick adds an attacker-controlled federated domain
 * to a tenant, then accepts SAML assertions signed by the attacker's
 * key claiming `ImmutableID=<existing-user-guid>`. The defensive tells
 * are:
 *
 *   1. realm probe says the operator's UPN is FEDERATED, AND
 *   2. the federation STS URL is NOT one of the well-known providers
 *      (Microsoft-hosted SAML2 STS, common ADFS hostnames), AND
 *   3. either the federation protocol is missing entirely (most ADFS
 *      and Okta deployments emit `WSFed` / `SAMLP`) or the STS URL
 *      doesn't share a domain suffix with the operator's home tenant
 *      verified domain.
 *
 * We can't fetch federationmetadata.xml from the browser (CORS), but
 * we CAN warn loudly when the realm-discovery response shows a
 * heterogeneous federation surface that doesn't match the operator's
 * UPN domain — that's the on-the-wire fingerprint of the backdoor's
 * "second federated domain" trick.
 *
 * False-positive rate is non-zero (some enterprises legitimately
 * federate domains across organisations). The advisory is therefore
 * an `info` chip by default and escalates to `warning` only when the
 * STS URL is on a public dynamic-DNS provider (.duckdns., .ngrok., etc).
 */
export function detectFederationBackdoorSuspect(
  realm: RealmProbeSummary | null | undefined,
  upn: string | undefined,
): OperatorAdvisory | null {
  if (!realm || realm.status !== "federated") return null;
  if (!realm.stsUrl && !realm.authUrl) return null;

  const sts = realm.stsUrl ?? realm.authUrl ?? "";
  let stsHost = "";
  try {
    stsHost = new URL(sts).host.toLowerCase();
  } catch {
    return null;
  }

  // Well-known legitimate STS hosts — these never trigger the suspect
  // advisory. Maintained as a small allowlist; everything else is at
  // least an info chip.
  const wellKnown = [
    "login.microsoftonline.com",
    "login.microsoft.com",
    "sts.windows.net",
    "fs.microsoft.com",
    "login.live.com",
  ];
  if (wellKnown.some((w) => stsHost === w)) return null;

  // Dynamic-DNS providers used in phishing-grade backdoors. If the STS
  // host is on one of these, severity = danger.
  const dynamicDns = [
    "duckdns.org",
    "ngrok.io",
    "ngrok.app",
    "ngrok-free.app",
    "trycloudflare.com",
    "loca.lt",
    "serveo.net",
    "lhr.life",
  ];
  const isDynamic = dynamicDns.some((d) => stsHost.endsWith(d));

  // Does the STS host share the SLD of the operator's UPN domain?
  // (Defender's heuristic — legitimate ADFS at customer.com tends to
  // be hosted at fs.customer.com or sts.customer.com.)
  const upnDomain = (upn ?? "").split("@")[1]?.toLowerCase() ?? "";
  // Extract the second-level "label" we'll compare. A naive split is
  // good enough — we just want a yes/no signal.
  const upnSld = upnDomain.split(".").slice(-2).join(".");
  const stsSld = stsHost.split(".").slice(-2).join(".");
  const sldMismatch = !!upnSld && !!stsSld && upnSld !== stsSld;

  const protocolKnown = !!realm.federationProtocol;
  const protocolWeird =
    protocolKnown &&
    !["wstrust", "wsfed", "samlp", "saml", "ws-fed"].includes(
      (realm.federationProtocol ?? "").toLowerCase(),
    );

  // If the SLD matches AND protocol is normal AND no dynamic DNS, we
  // don't fire — that's a vanilla in-org ADFS.
  if (!sldMismatch && !protocolWeird && !isDynamic) return null;

  const severity: AdvisorySeverity = isDynamic
    ? "danger"
    : sldMismatch
      ? "warning"
      : "info";

  const headline = isDynamic
    ? "Federation STS on a dynamic-DNS provider — possible backdoor"
    : sldMismatch
      ? "Federated STS doesn't match UPN domain — investigate"
      : "Federation protocol is non-standard — note for diagnostics";

  const body =
    `Realm discovery says ${safeQuote(upn) || "this account"} federates to ` +
    `${safeQuote(stsHost)} (${safeQuote(realm.federationProtocol) || "unknown protocol"}). ` +
    `${
      sldMismatch
        ? `The STS host's second-level domain (${safeQuote(stsSld)}) does not match the UPN's (${safeQuote(upnSld)}). `
        : ""
    }${
      isDynamic
        ? "The STS host is on a public dynamic-DNS provider — this is the on-the-wire fingerprint of a federation-backdoor (`ConvertTo-Backdoor`) where the attacker adds a federated domain pointing at their own IdP. "
        : ""
    }Tenant admins should pull \`Get-MsolDomainFederationSettings\` for every federated domain and compare the signing thumbprints against an offline known-good list. If a backdoor is in place, the IssuerUri or IssuerCertificate will be attacker-controlled.`;

  return {
    id: "fed-backdoor-suspect",
    severity,
    title: headline,
    body,
    corpusRef: "_analysis_aadinternals.md §2.4 The Federation Backdoor",
    action:
      "Run `Get-MsolDomainFederationSettings -DomainName <each-federated-domain>` from a trusted admin host. Compare ActiveLogOnUri / IssuerUri / SigningCertificate against your hardware offline reference. If any value is unfamiliar, defederate the domain immediately (Set-MsolDomainAuthentication -Authentication Managed).",
  };
}

/**
 * Heuristic: device-code flow being used from an unexpected client.
 *
 * Cite: `_bypass_login.md` §2.5 — "device-code flow has different CA
 * evaluation timing". The defensive flip is: when a freshly-minted
 * token's claims indicate device-code (i.e. the `appid` / `azp` is a
 * well-known device-code-capable first-party client AND the page did
 * NOT explicitly run a device-code mint), and the audience is one of
 * the privileged ones (ARM / Graph), surface an advisory pointing at
 * device-code-phishing detection guidance.
 *
 * The known device-code-capable first-party app ids that operators
 * sometimes see in operator-side audit logs (Azure CLI, Az PowerShell,
 * Microsoft Authenticator broker, Office device-code helper). If our
 * token came back stamped with one of these AND we didn't mint via a
 * device-code path on this page, the operator should know.
 *
 * Defensive only — no detection countermeasure value is exposed here;
 * the advisory just tells the operator where to look in their
 * sign-in logs.
 */
export function detectDeviceCodeContext(
  meta: AdvisoryMintMeta,
): OperatorAdvisory | null {
  // device-code-capable well-known first-party clients (subset).
  const deviceCodeClients = new Set<string>([
    "04b07795-8ddb-461a-bbee-02f9e1bf7b46", // Azure CLI
    "1950a258-227b-4e31-a9cf-717495945fc2", // Azure PowerShell
    "d3590ed6-52b3-4102-aeff-aad2292ab01c", // Microsoft Office
    "ab9b8c07-8f02-4f72-87fa-80105867a763", // OneDrive iOS
    "29d9ed98-a469-4536-ade2-f981bc1d605e", // MS Authenticator
    "00b41c95-dab0-4487-9791-b9d2c32c80f2", // Office 365 Management
  ]);

  const appid =
    (typeof meta.claims.azp === "string" && meta.claims.azp) ||
    (typeof meta.claims.appid === "string" && meta.claims.appid) ||
    "";
  if (!appid) return null;
  if (!deviceCodeClients.has(appid.toLowerCase())) return null;

  // The page itself never mints via the device-code flow — every flow
  // here is either MSAL silent or FOCI exchange. If the resulting
  // token's appid is on the device-code-capable list, the token was
  // minted somewhere ELSE and imported (via the Token Importer page)
  // and we're now spending a refresh-token derived from it. The
  // device-code-phishing scenario is: a phished user completed an
  // attacker-orchestrated device-code flow, the resulting RT was
  // exfiltrated, and the attacker is now using FOCI exchange (this
  // page's primitive!) to mint downstream audience tokens.
  //
  // We surface this whenever the appid is on the device-code list AND
  // the method used was FOCI exchange — that's the on-the-wire
  // fingerprint of a phished-device-code RT being spent.
  if (meta.methodUsed !== "foci-exchange") return null;

  return {
    id: "device-code-flow-detected",
    severity: "info",
    title:
      "Token issued by a device-code-capable first-party client — verify provenance",
    body:
      `The resulting access token's azp/appid (${safeQuote(appid)}) is one of the well-known first-party clients that supports the OAuth device-code flow. Combined with the FOCI exchange path used here, this is the on-the-wire shape produced when a phished device-code refresh token is exchanged for a downstream audience. ` +
      `If you imported this refresh token from a sign-in YOU initiated, this is benign — the device-code-capable client is a normal byproduct of az/pwsh CLI auth. If the RT came from a screen-share / IT-support session / unsolicited Microsoft Authenticator push, treat this advisory as a sign-in event to correlate against your Entra ID sign-in logs (Audit log → "Authentication method = deviceCode").`,
    corpusRef:
      "_bypass_login.md §2.5 (device-code flow CA-timing skip) and §device-code phishing pivots",
    action:
      "In Entra ID Audit Logs, filter for `appDisplayName eq 'Microsoft Azure CLI'` (or the matching first-party app) and `authenticationMethod eq 'deviceCode'` against the operator's UPN for the last 24h. Any device-code event you didn't initiate is a phishing-grade incident — invalidate the user's refresh tokens via `Revoke-MgUserSign InSession`.",
  };
}

/**
 * Heuristic: token's `iss` (issuer) doesn't reference the target tenant
 * id we asked for. The page-level validators already catch the common
 * version (post-mint tid validation throws). This advisory catches the
 * narrow case where `tid` happens to match but the issuer URL is from
 * a sovereign cloud the operator may not have expected (gov, china).
 *
 * Cite: `_bypass_login.md` §sovereign-cloud-confusion pivot.
 */
export function detectIssuerMismatch(
  meta: AdvisoryMintMeta,
): OperatorAdvisory | null {
  const iss = typeof meta.claims.iss === "string" ? (meta.claims.iss as string) : "";
  if (!iss) return null;
  // Public-cloud issuers we expect for an ARM/Graph token.
  const publicHosts = ["login.microsoftonline.com", "sts.windows.net"];
  let issHost = "";
  try {
    issHost = new URL(iss).host.toLowerCase();
  } catch {
    return null;
  }
  if (publicHosts.some((h) => issHost === h)) return null;
  // Known sovereign issuers we want to call out.
  const sovereign: Record<string, string> = {
    "login.microsoftonline.us": "Azure for US Government",
    "login.microsoftonline.de": "Azure Germany (retired)",
    "login.chinacloudapi.cn": "Azure China (21Vianet)",
  };
  const name = sovereign[issHost] ?? "an unexpected issuer";
  return {
    id: "issuer-mismatch",
    severity: "warning",
    title: `Token issued by ${safeQuote(name)} — sovereign-cloud surface`,
    body:
      `The minted token's iss claim is ${safeQuote(issHost)}, which routes through ${safeQuote(name)} rather than the standard public cloud. If you didn't deliberately target a sovereign tenant, this is a misrouted mint — the resource server you POST against next may reject it with audience-mismatch, OR may silently accept it depending on cross-cloud trust.`,
    corpusRef: "_bypass_login.md §sovereign-cloud confusion",
    action:
      "Verify the target tenant's cloud assignment via `Get-AzContext` / the tenant's Properties blade. If the operator is supposed to be on public cloud but the iss is sovereign, the source account was likely B2B-invited from a sovereign tenant — switch to a native-tenant source account for downstream operations.",
  };
}

/* ---------------------------------------------------------------------- */
/* Compose                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Top-level composer — runs every detector and returns the resulting
 * advisories in stable order. Empty array means "nothing notable".
 *
 * Callers may pass `null` for realm if the probe failed; detectors
 * tolerate it.
 */
export function computeOperatorAdvisories(
  meta: AdvisoryMintMeta,
  realm: RealmProbeSummary | null | undefined,
  upn: string | undefined,
): OperatorAdvisory[] {
  const out: OperatorAdvisory[] = [];
  const fb = detectFederationBackdoorSuspect(realm, upn);
  if (fb) out.push(fb);
  const dc = detectDeviceCodeContext(meta);
  if (dc) out.push(dc);
  const iss = detectIssuerMismatch(meta);
  if (iss) out.push(iss);
  return out;
}

/* ---------------------------------------------------------------------- */
/* Flow-education wizard data                                              */
/* ---------------------------------------------------------------------- */

/**
 * Per-flow education entry — what each Tricky Login flow does, when to
 * use it, and which corpus playbook section the operator should read
 * for deeper grounding. Powers the "Why are you using this flow?"
 * dialog.
 *
 * The dialog is purely informational — no side effects, no telemetry
 * other than a count of opens.
 */
export interface FlowEducationEntry {
  /** The TrickyLoginMethod this entry teaches. */
  method: TrickyLoginMethod;
  /** Short tab label. */
  label: string;
  /** One-sentence "what it does" — operator-facing. */
  whatItDoes: string;
  /** Two-sentence "when to use it". */
  whenToUse: string;
  /**
   * Defensive vs offensive — both framings. The page's stance is
   * defensive admin; the offensive framing is included so operators can
   * recognise it in red-team write-ups.
   */
  defensiveFraming: string;
  offensiveFraming: string;
  /**
   * Wire-shape headline — what an operator running mitmproxy / Burp
   * would see on the wire for this flow. Helps with diagnostics.
   */
  wireShape: string;
  /** Authoritative corpus playbook reference. */
  corpusRef: string;
  /** Source-code reference inside the corpus root, for the curious. */
  corpusSource: string;
}

export const FLOW_EDUCATION: ReadonlyArray<FlowEducationEntry> = Object.freeze([
  {
    method: "msal-silent",
    label: "MSAL Silent (multi-tenant)",
    whatItDoes:
      "Calls acquireTokenSilent against the target tenant's authority using the operator's existing MSAL cache.",
    whenToUse:
      "When the source account already appears as a member or guest in the target tenant. The most common path for an admin who's been B2B-invited into a customer tenant.",
    defensiveFraming:
      "Operator already authenticated; we're asking MSAL to RE-AUDIENCE the existing session for a new tenant. No new credential surface.",
    offensiveFraming:
      "ROADtools' roadtx → `gettokens --tenant <victim>` uses the same primitive against a stolen MSAL cache to enumerate guest tenants.",
    wireShape:
      "MSAL → POST /{targetTenantId}/oauth2/v2.0/token with grant_type=refresh_token, refresh_token=<cached MSAL RT>, client_id=<this app's client id>, scope=<target audience>/.default. Response: JSON access_token (target tid) + optional rotated RT.",
    corpusRef: "_AZURE_LOGIN_METHODS.md §refresh-token grant",
    corpusSource:
      "dirkjanm/ROADtools/roadlib/roadtools/roadlib/auth.py (search: 'acquire_token_with_refresh_token')",
  },
  {
    method: "foci-exchange",
    label: "FOCI refresh-token exchange",
    whatItDoes:
      "POSTs grant_type=refresh_token to the target tenant's /oauth2/v2.0/token using an imported refresh token from a family-of-client-ids (FOCI) member client.",
    whenToUse:
      "When MSAL silent fails (no cached session for the target) or when you need an audience MSAL silent doesn't support (vault, storage, intune, devops, etc.). Requires an imported FOCI-eligible refresh token on the Import Token page.",
    defensiveFraming:
      "Operator imported their OWN refresh token from a legitimate az/pwsh/Authenticator session. We swap it for a downstream audience while keeping the same human identity.",
    offensiveFraming:
      "dafthack/TeamFiltration and dirkjanm/family-of-client-ids-research catalog the 17 FOCI-eligible first-party clients. Stolen RT from one (e.g. Office) trivially exchanges for any other (Azure CLI → ARM token).",
    wireShape:
      "Raw HTTPS → POST https://login.microsoftonline.com/{targetTid}/oauth2/v2.0/token with body grant_type=refresh_token&refresh_token=<imported RT>&client_id=<FOCI target client id>&scope=<audience>/.default. Response: JSON access_token (any audience).",
    corpusRef: "_analysis_dirkjanm.md §FOCI / family-of-client-ids",
    corpusSource:
      "dirkjanm/family-of-client-ids-research/README.md and roadlib/auth.py:exchange_refresh_token",
  },
  {
    method: "auto",
    label: "Auto (MSAL → FOCI)",
    whatItDoes:
      "Tries MSAL silent first; on interaction_required falls back to FOCI exchange if an imported RT is available.",
    whenToUse:
      "Default for most flows. Lets you pick a target audience without worrying about whether MSAL silent supports it — the audience-aware orchestrator picks the right concrete method.",
    defensiveFraming:
      "Convenience wrapper — the page's discovery logic decides which underlying primitive is appropriate. Same audit shape; the resulting `methodUsed` field records which one actually ran.",
    offensiveFraming:
      "ROADtools' roadtx implements the same fallback ladder when it doesn't know the target's tenant-resolution behaviour. Both paths produce the same on-the-wire shape modulo the client_id.",
    wireShape:
      "First attempt: MSAL silent shape (see above). If it returns interaction_required / invalid_grant, second attempt: FOCI exchange shape (see above). Both attempts are surfaced in the auto-attempts panel.",
    corpusRef: "_AZURE_BYPASS_PLAYBOOK.md §multi-tenant token pivot",
    corpusSource:
      "dirkjanm/ROADtools/roadlib + Gerenios/AADInternals/AccessToken.ps1",
  },
]);
