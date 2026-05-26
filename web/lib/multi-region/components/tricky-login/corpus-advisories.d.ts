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
/** Severity tone for the advisory chip in the UI. */
export type AdvisorySeverity = "info" | "warning" | "danger";
/**
 * Stable advisory identifier — used as a React key, surfaced to the
 * audit log as metadata (e.g. `{ advisoryIds: ["fed-backdoor-suspect"] }`),
 * and used by hide/dismiss code if we ever add that. NOT a free-form
 * string at the call-site — bind to one of these literals.
 */
export type AdvisoryId = "device-code-unexpected-ip" | "device-code-flow-detected" | "fed-backdoor-suspect" | "fed-recent-rollover" | "non-managed-realm-mismatch" | "guest-token-acct-1" | "amr-absent" | "issuer-mismatch";
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
export declare function detectFederationBackdoorSuspect(realm: RealmProbeSummary | null | undefined, upn: string | undefined): OperatorAdvisory | null;
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
export declare function detectDeviceCodeContext(meta: AdvisoryMintMeta): OperatorAdvisory | null;
/**
 * Heuristic: token's `iss` (issuer) doesn't reference the target tenant
 * id we asked for. The page-level validators already catch the common
 * version (post-mint tid validation throws). This advisory catches the
 * narrow case where `tid` happens to match but the issuer URL is from
 * a sovereign cloud the operator may not have expected (gov, china).
 *
 * Cite: `_bypass_login.md` §sovereign-cloud-confusion pivot.
 */
export declare function detectIssuerMismatch(meta: AdvisoryMintMeta): OperatorAdvisory | null;
/**
 * Top-level composer — runs every detector and returns the resulting
 * advisories in stable order. Empty array means "nothing notable".
 *
 * Callers may pass `null` for realm if the probe failed; detectors
 * tolerate it.
 */
export declare function computeOperatorAdvisories(meta: AdvisoryMintMeta, realm: RealmProbeSummary | null | undefined, upn: string | undefined): OperatorAdvisory[];
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
export declare const FLOW_EDUCATION: ReadonlyArray<FlowEducationEntry>;
//# sourceMappingURL=corpus-advisories.d.ts.map