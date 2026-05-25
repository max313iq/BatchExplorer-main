/**
 * Tricky Login — defensive admin flip of red-team cross-tenant token
 * tricks (ROADtools `roadtx`, AADInternals `Get-AADIntAccessTokenWith*`,
 * Stormspotter silent pivot).
 *
 * Legitimate use case:
 *   Tenant admins who are ALREADY signed in with account X want to mint a
 *   token for tenant Y (where X is a guest, partner, or B2B member)
 *   WITHOUT re-entering credentials, then optionally use the result as a
 *   "duplicate" account context they can switch between.
 *
 * Why this is NOT an offensive primitive: every operation here only
 * succeeds when the operator has already authenticated AND the target
 * tenant has granted them access. We never POP a credential prompt, we
 * never extract credentials from the browser keychain, and we never
 * touch the operator's PRT / device cert. The page is constrained to:
 *
 *   1. MSAL silent multi-tenant — `acquireTokenSilent` with the target
 *      tenant authority. Works for the operator's OWN session.
 *   2. FOCI refresh-token exchange — POST `grant_type=refresh_token` to
 *      `/{targetTenantId}/oauth2/v2.0/token` with a refresh token the
 *      operator already imported via the Token Importer page.
 *   3. Auto — try MSAL first, fall back to FOCI on InteractionRequired.
 *
 * Every mint goes to the audit log (`tricky_login_mint`); token material
 * is NEVER logged or audited.
 *
 * Files in this folder:
 *   - tricky-login-helpers.ts — pure helpers (this page imports them)
 *   - tricky-login-page.tsx   — THIS file
 *
 * The page deliberately consumes EXISTING auth / store / shared-UI APIs
 * and does not modify any service / auth / store / page-router / sidebar-
 * nav file (per the spec's hard constraints).
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  Loader2,
  Lock,
  RefreshCcw,
  Repeat2,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
  Wand2,
  XCircle,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn, formatDateTime, formatRelativeTime } from "@/lib/utils";

import {
  decodeJwtClaimsUnsafe,
  getArmTokenForAccount,
  getBatchTokenForAccount,
  getGraphTokenForAccount,
  listAccessibleTenants,
  loginAccount,
} from "../../auth/msal-auth";
import { useArmToken } from "../../auth/use-arm-token";
import {
  exchangeRefreshTokenForClient,
  getFociClientByAppId,
  type FociExchangeResult,
} from "../../auth/foci-exchange";
import {
  classifyAudience,
  getRefreshTokenEntry,
  importRefreshToken,
  importToken,
  previewToken,
  type AudienceBucket,
  type ImportedRefreshTokenEntry,
} from "../../auth/imported-tokens";
import { performTenantSwitch } from "../../auth/perform-tenant-switch";
import { auditLog } from "../../services/audit-log";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import type { AzureLoginAccount } from "../../store/store-types";
import type { TenantInfo } from "../../services/types";

import { CopyButton, CopyableText } from "../shared/copy-button";
import { EmptyState } from "../shared/empty-state";
import { InfoTooltip } from "../shared/info-tooltip";
import { PageHeader } from "../shared/page-header";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";

import {
  AUDIENCE_CHOICES,
  audienceForScope,
  BATCH_MINT_AUDIENCES,
  CLAIM_EXPLAIN,
  detectMethodAvailability,
  extendedAudienceForScope,
  extractAadErrorCode,
  findTenantLabel,
  fmtDuration,
  formatExpiresIn,
  getAudienceChoice,
  HISTORY_MAX_ENTRIES,
  loadHistory,
  maskToken,
  methodLabel,
  methodShortLabel,
  saveHistory,
  toHistoryRow,
  TOKEN_IMPORTER_SESSION_KEY,
  type MethodAvailabilityMap,
  type TrickyAudienceId,
  type TrickyLoginHistoryRow,
  type TrickyLoginMethod,
  type TrickyLoginMintResult,
} from "./tricky-login-helpers";
import { SpLoginTab } from "./sp-login-tab";

/* ---------------------------------------------------------------------- */
/* Small render helpers — kept inline (no JSX dependency to surface).      */
/* ---------------------------------------------------------------------- */

/** Map an audience choice to a badge variant for the radio chip. */
function audienceChipAccent(id: TrickyAudienceId): {
  badge: "default" | "info" | "success" | "warning" | "outline" | "secondary";
} {
  switch (id) {
    case "arm":
      return { badge: "info" };
    case "graph":
      return { badge: "default" };
    case "batch":
      return { badge: "warning" };
    case "vault":
    case "keyvault":
      return { badge: "warning" };
    case "storage":
      return { badge: "info" };
    case "intune":
    case "monitor":
      return { badge: "secondary" };
    case "substrate":
    case "powerbi":
    case "yammer":
      return { badge: "default" };
    case "devops":
      return { badge: "info" };
    case "custom":
      return { badge: "outline" };
    default:
      return { badge: "secondary" };
  }
}

/** Format a JWT claim value for the per-claim row in the result panel. */
function formatClaimValue(name: string, value: unknown): string {
  if (value == null) return "(null)";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (name === "iat" || name === "nbf" || name === "exp") {
      try {
        const iso = new Date(value * 1000).toISOString();
        return `${value} (${iso})`;
      } catch {
        return String(value);
      }
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* ---------------------------------------------------------------------- */
/* Page component                                                         */
/* ---------------------------------------------------------------------- */

export const TrickyLoginPage: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const navigate = useNavigate();

  /* --- Mount lifecycle: every async path checks this so we don't
   * setState-after-unmount when an operator navigates away mid-mint. */
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ----------------------------------------------------------------
   * A. Source account + target tenant pickers
   * ---------------------------------------------------------------- */
  const azureAccounts = state.azureAccounts ?? [];

  // Default source account = first signed-in account (most operators have one).
  const [sourceAccountId, setSourceAccountId] = React.useState<string>(
    () => azureAccounts[0]?.homeAccountId ?? "",
  );
  // Keep selection synced if the account list shrinks (e.g. operator signs
  // out the selected account on Azure Accounts).
  React.useEffect(() => {
    if (
      sourceAccountId &&
      !azureAccounts.some((a) => a.homeAccountId === sourceAccountId)
    ) {
      setSourceAccountId(azureAccounts[0]?.homeAccountId ?? "");
    }
  }, [azureAccounts, sourceAccountId]);

  const sourceAccount: AzureLoginAccount | undefined = React.useMemo(
    () => azureAccounts.find((a) => a.homeAccountId === sourceAccountId),
    [azureAccounts, sourceAccountId],
  );

  // Lazy tenant fetch — the spec wants us to read account.tenants if
  // already populated, else fetch on demand. We mirror the same in-flight
  // ref pattern the Azure Accounts page uses so a re-render doesn't fire
  // duplicate fetches.
  const [lazyTenants, setLazyTenants] = React.useState<TenantInfo[] | null>(
    null,
  );
  const [tenantsLoading, setTenantsLoading] = React.useState(false);
  const [tenantsError, setTenantsError] = React.useState<string | null>(null);
  const tenantsInFlightRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    // Reset lazy state when the source account changes — what was lazy-
    // loaded for account A doesn't apply to account B.
    setLazyTenants(null);
    setTenantsError(null);
  }, [sourceAccountId]);

  const fetchTenants = React.useCallback(
    async (homeAccountId: string) => {
      if (!homeAccountId) return;
      if (tenantsInFlightRef.current === homeAccountId) return;
      tenantsInFlightRef.current = homeAccountId;
      setTenantsLoading(true);
      setTenantsError(null);
      try {
        const list = await listAccessibleTenants(homeAccountId);
        if (!mountedRef.current) return;
        if (tenantsInFlightRef.current !== homeAccountId) return;
        setLazyTenants(list);
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setTenantsError(msg);
      } finally {
        if (tenantsInFlightRef.current === homeAccountId) {
          tenantsInFlightRef.current = null;
        }
        if (mountedRef.current) setTenantsLoading(false);
      }
    },
    [],
  );

  // Tenant choices come from account.tenants if already populated,
  // otherwise the lazy fetch state. We never modify account.tenants from
  // here — that's owned by Azure Accounts.
  const tenantChoices: TenantInfo[] = React.useMemo(() => {
    const fromAccount = sourceAccount?.tenants ?? [];
    if (fromAccount.length > 0) return fromAccount;
    return lazyTenants ?? [];
  }, [sourceAccount, lazyTenants]);

  // Default target tenant: first tenant that ISN'T the active one.
  const activeTenantId =
    sourceAccount?.activeTenantId ?? sourceAccount?.tenantId ?? undefined;
  const [targetTenantId, setTargetTenantId] = React.useState<string>("");

  // When the tenant choices change, reset to the first non-active option.
  React.useEffect(() => {
    if (!tenantChoices.length) {
      setTargetTenantId("");
      return;
    }
    setTargetTenantId((prev) => {
      const stillValid = tenantChoices.some(
        (t) => (t.tenantId ?? "").toLowerCase() === prev.toLowerCase(),
      );
      if (stillValid) return prev;
      const firstNonActive = tenantChoices.find(
        (t) =>
          !activeTenantId ||
          (t.tenantId ?? "").toLowerCase() !== activeTenantId.toLowerCase(),
      );
      return firstNonActive?.tenantId ?? tenantChoices[0]?.tenantId ?? "";
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantChoices, activeTenantId]);

  /* ----------------------------------------------------------------
   * B. Method selector + tricks discovery
   * ---------------------------------------------------------------- */
  const [method, setMethod] = React.useState<TrickyLoginMethod>("auto");

  // Imported RT lookup for the FOCI path. We expose its originating client
  // label in the discovery row so the operator knows which RT we'd spend.
  const importedRt: ImportedRefreshTokenEntry | null = React.useMemo(() => {
    if (!sourceAccountId) return null;
    return getRefreshTokenEntry(sourceAccountId);
  }, [sourceAccountId]);

  const importedRtClient = React.useMemo(() => {
    if (!importedRt) return undefined;
    const c = getFociClientByAppId(importedRt.clientId);
    return c?.name ?? importedRt.clientId;
  }, [importedRt]);

  const availability: MethodAvailabilityMap = React.useMemo(
    () =>
      detectMethodAvailability({
        accountTenants: tenantChoices,
        activeTenantId,
        targetTenantId,
        hasImportedRefreshToken: !!importedRt,
        importedRefreshTokenClientLabel: importedRtClient,
      }),
    [
      tenantChoices,
      activeTenantId,
      targetTenantId,
      importedRt,
      importedRtClient,
    ],
  );

  /* ----------------------------------------------------------------
   * C. Audience picker
   * ---------------------------------------------------------------- */
  const [audienceId, setAudienceId] = React.useState<TrickyAudienceId>("arm");
  const [customScope, setCustomScope] = React.useState<string>(
    "https://management.azure.com/.default",
  );
  const activeScope =
    audienceId === "custom" ? customScope : getAudienceChoice(audienceId).scope;
  const effectiveAudience = audienceForScope(activeScope);
  const effectiveExtendedAudience: TrickyAudienceId =
    audienceId === "custom"
      ? extendedAudienceForScope(customScope)
      : audienceId;

  /* ----------------------------------------------------------------
   * D. Mint action state
   * ---------------------------------------------------------------- */
  const [minting, setMinting] = React.useState(false);
  const [mintSubStep, setMintSubStep] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<TrickyLoginMintResult | null>(
    null,
  );
  // For Auto mode we also surface BOTH attempts so the operator can see
  // why MSAL silent rejected if FOCI ended up serving the request.
  const [autoAttempts, setAutoAttempts] = React.useState<
    Array<{ method: TrickyLoginMethod; status: "success" | "failure"; detail: string }>
  >([]);

  // Reveal/copy state for the token panel.
  const [tokenRevealed, setTokenRevealed] = React.useState(false);
  const [rtRevealed, setRtRevealed] = React.useState(false);

  /**
   * Auto-activate toggle. When ON (default), every successful mint
   * fires `handleImportToVault` + `handleSetActive` automatically so
   * the new context becomes the operator's live ARM/Graph/Batch
   * identity across every page in the app:
   *
   *   1. Import to vault → next `getArmTokenForAccount(synthetic-id,
   *      tenantId)` call short-circuits to the cached token.
   *   2. Set as active → `performTenantSwitch` writes MSAL + store +
   *      fires TENANT_CHANGED_EVENT → every page using `useArmToken`
   *      re-mints, every page with `useTenantChange` re-fetches.
   *
   * Operator turns this OFF when batch-minting (e.g. ARM + Graph +
   * Batch for the same target) — they want all three tokens in the
   * vault but only ONE active-tenant switch at the end. Persisted in
   * sessionStorage so the choice carries across page reloads.
   */
  const [autoActivateOnSuccess, setAutoActivateOnSuccess] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.sessionStorage.getItem(
      "tricky-login:auto-activate",
    );
    if (stored === null) return true; // default ON
    return stored === "1";
  });
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(
      "tricky-login:auto-activate",
      autoActivateOnSuccess ? "1" : "0",
    );
  }, [autoActivateOnSuccess]);

  /* ----------------------------------------------------------------
   * E. History (session-scoped, capped at 20)
   * ---------------------------------------------------------------- */
  const [history, setHistory] = React.useState<TrickyLoginHistoryRow[]>(() =>
    loadHistory(),
  );

  // Persist whenever it changes.
  React.useEffect(() => {
    saveHistory(history);
  }, [history]);

  const pushHistory = React.useCallback((row: TrickyLoginHistoryRow) => {
    setHistory((prev) => [row, ...prev].slice(0, HISTORY_MAX_ENTRIES));
  }, []);

  /* ----------------------------------------------------------------
   * F. Federation / ADFS pre-flight probe
   * ----------------------------------------------------------------
   *
   * Whenever (sourceAccount, targetTenantId) becomes valid, we GET
   *   https://login.microsoftonline.com/getuserrealm.srf?login=<UPN>&xml=1
   * and parse the <NameSpaceType> element from the XML response. AAD's
   * realm discovery endpoint is intentionally CORS-permissive (it's used
   * by client-side ADAL.js sample apps), so a direct fetch usually
   * succeeds. If it doesn't (corp proxy, CSP, etc.) we surface the probe
   * as `error` and let the page render a soft info chip instead of a
   * blocking alert.
   *
   * The probe is keyed on `username` so re-render cycles don't fire
   * duplicate requests. The cache is module-instance scoped — clearing
   * it requires switching the source account (which is the natural
   * trigger anyway).
   *
   * Why this matters: when an account is FEDERATED, the password the
   * operator might type during an MFA re-elevation is sent to the
   * federated STS (e.g. ADFS at customer.com), not directly to
   * login.microsoftonline.com. Operators handling B2B accounts should
   * know this BEFORE clicking re-authenticate.
   */
  type RealmStatus = "managed" | "federated" | "unknown";
  interface RealmProbeResult {
    status: RealmStatus;
    /** Federated only — the federation metadata / STS URL. */
    stsUrl?: string;
    /** Federation type, e.g. "WSTrust" / "SAMLP" — informational. */
    federationProtocol?: string;
    /** Federation auth URL — useful for diagnostics. */
    authUrl?: string;
    /** Domain name from realm discovery (mirrors the @-suffix of UPN). */
    domainName?: string;
  }
  const realmCacheRef = React.useRef<Map<string, RealmProbeResult>>(
    new Map(),
  );
  const [realmProbe, setRealmProbe] = React.useState<RealmProbeResult | null>(
    null,
  );
  const [realmLoading, setRealmLoading] = React.useState(false);
  const [realmError, setRealmError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setRealmProbe(null);
    setRealmError(null);
    setRealmLoading(false);
    if (!sourceAccount || !targetTenantId) return;
    const upn = sourceAccount.username;
    if (!upn || !upn.includes("@")) return;
    const cacheKey = upn.toLowerCase();
    const cached = realmCacheRef.current.get(cacheKey);
    if (cached) {
      setRealmProbe(cached);
      return;
    }
    let cancelled = false;
    setRealmLoading(true);
    const url = `https://login.microsoftonline.com/getuserrealm.srf?login=${encodeURIComponent(
      upn,
    )}&xml=1`;
    // Cheap CORS-permissive endpoint. If the browser blocks it (privacy
    // extension, corp proxy), fall through to a soft error.
    fetch(url, { method: "GET", credentials: "omit" })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then((xml) => {
        if (cancelled) return;
        // Tag-extraction via regex — DOMParser would be cleaner but the
        // realm-discovery XML is tiny, well-formed, and we only need a
        // handful of leaf elements. Keeping it regex-based avoids
        // shipping a DOMParser dependency into the page module.
        const tag = (name: string): string | undefined => {
          const m = new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml);
          return m ? m[1].trim() : undefined;
        };
        const nsType = (tag("NameSpaceType") ?? "").toLowerCase();
        const result: RealmProbeResult = {
          status:
            nsType === "managed"
              ? "managed"
              : nsType === "federated"
                ? "federated"
                : "unknown",
          stsUrl: tag("STSAuthURL") ?? tag("AuthURL"),
          federationProtocol: tag("FederationProtocol"),
          authUrl: tag("AuthURL"),
          domainName: tag("DomainName"),
        };
        realmCacheRef.current.set(cacheKey, result);
        if (mountedRef.current) {
          setRealmProbe(result);
          setRealmLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (mountedRef.current) {
          setRealmError(
            err instanceof Error ? err.message : String(err),
          );
          setRealmLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceAccount?.username, targetTenantId]);

  /* ----------------------------------------------------------------
   * Token tracker for the page header — driven by the source account.
   * Matches the pattern used by every other tenant-aware page.
   * ---------------------------------------------------------------- */
  const tokenState = useArmToken(
    sourceAccountId || undefined,
    activeTenantId,
  );

  /* ----------------------------------------------------------------
   * Mint actions
   * ---------------------------------------------------------------- */

  /**
   * MSAL silent multi-tenant: the bread-and-butter `acquireTokenSilent`
   * with `authority=https://login.microsoftonline.com/{targetTenantId}`.
   * Routes through audience-aware getters so imported access tokens for
   * the same (account, audience) pair short-circuit naturally — same as
   * every other ARM/Graph/Batch read in the app.
   */
  async function mintViaMsalSilent(
    homeAccountId: string,
    targetTid: string,
    audience: AudienceBucket,
    scope: string,
    /**
     * Extended audience id (12 + custom) — only used to construct a more
     * specific error message when the audience is one of the new ones
     * (vault, storage, intune, substrate, monitor, powerbi, yammer,
     * devops) and the MSAL helpers can't service it.
     */
    extended?: TrickyAudienceId,
  ): Promise<{ accessToken: string }> {
    setMintSubStep(
      `Calling MSAL acquireTokenSilent for ${targetTid.slice(0, 8)}… (forceRefresh)`,
    );
    let token: string;
    // forceRefresh: true is REQUIRED for cross-tenant Tricky Login
    // mints. Without it, MSAL's silent cache may return a cached
    // home-tenant token whose scopes match, ignoring the authority
    // we just specified — producing a token with the WRONG tid.
    // This is the most common cause of "I asked for tenant X but
    // got a token for tenant Y" reports.
    const opts = { forceRefresh: true };
    if (audience === "graph") {
      token = await getGraphTokenForAccount(homeAccountId, targetTid, opts);
    } else if (audience === "batch") {
      token = await getBatchTokenForAccount(homeAccountId, targetTid, opts);
    } else if (audience === "arm") {
      token = await getArmTokenForAccount(homeAccountId, targetTid, opts);
    } else {
      // For the extended audiences (vault / storage / intune / substrate
      // / monitor / powerbi / yammer / devops) and any custom scope, the
      // MSAL silent helpers don't expose a generic acquire — adding one
      // would cross the "no service-layer edits" line of this task. We
      // surface a specific hint pointing the operator at the FOCI
      // exchange method, which IS audience-agnostic.
      const hint =
        extended && extended !== "custom"
          ? `MSAL silent doesn't support the ${extended.toUpperCase()} audience here — only ARM / Graph / Batch are wired through the silent helpers. ` +
            `Switch the method to "FOCI exchange" (this audience is natively serviceable that way) or pick ARM / Graph / Batch instead.`
          : `Custom scope "${scope}" is not supported via MSAL silent — pick ARM / Graph / Batch or use the FOCI exchange path.`;
      throw new Error(hint);
    }
    // Post-mint tid validation. Defense in depth — even with
    // forceRefresh, MSAL has been observed returning a home-tenant
    // token in edge cases (login-mode mismatch, broker quirks, etc.).
    // If the returned tid doesn't match what we requested, throw —
    // the Auto-mode fallback will then try FOCI exchange which uses a
    // raw HTTP POST and is guaranteed to mint for the right tenant.
    const claims = decodeJwtClaimsUnsafe(token) ?? {};
    const actualTid =
      typeof claims.tid === "string" ? (claims.tid as string) : null;
    if (actualTid && actualTid.toLowerCase() !== targetTid.toLowerCase()) {
      throw new Error(
        `MSAL returned a token for the WRONG tenant — got tid=${actualTid} but requested ${targetTid}. ` +
          `This typically happens when MSAL's silent cache returns a cached token whose authority differs ` +
          `from the requested one. Use the FOCI Exchange method instead — it's a raw /oauth2/v2.0/token POST ` +
          `against the target tenant's authority and is guaranteed to mint for the requested tid.`,
      );
    }
    return { accessToken: token };
  }

  /**
   * FOCI refresh-token exchange: POST `grant_type=refresh_token` to the
   * target tenant's /oauth2/v2.0/token with the operator's imported RT
   * and the target FOCI client id. AAD honours the swap because both
   * source + target are family-of-client-ids members.
   *
   * Pre-flight checks:
   *   1. An imported RT exists for the source account.
   *   2. The RT's originating client id is FOCI-eligible.
   */
  async function mintViaFociExchange(
    homeAccountId: string,
    targetTid: string,
    audience: AudienceBucket,
    scope: string,
  ): Promise<{ accessToken: string; refreshToken?: string; raw: FociExchangeResult }> {
    const rt = getRefreshTokenEntry(homeAccountId);
    if (!rt) {
      throw new Error(
        "FOCI exchange unavailable: no imported refresh token for this account. Paste one on the Import Token page first.",
      );
    }
    // Detect the FOCI client behind the imported RT. detectFociEligibility
    // expects decoded claims — for an RT we don't have those, so we look
    // the client id up directly.
    const sourceClient = getFociClientByAppId(rt.clientId);
    if (!sourceClient) {
      throw new Error(
        `FOCI exchange unavailable: imported RT was issued to client ${rt.clientId}, which is not in our curated FOCI list.`,
      );
    }
    setMintSubStep(
      `POST /${targetTid}/oauth2/v2.0/token (FOCI: ${sourceClient.name} → ${audience.toUpperCase()})…`,
    );
    // Default to the source-client id as the TARGET — operators usually
    // want to keep the same client persona on the new tenant. They can
    // pick a different target via the Token Importer FOCI panel.
    const targetClientId = rt.clientId;
    const exchange = await exchangeRefreshTokenForClient({
      refreshToken: rt.refreshToken,
      targetClientId,
      tenantId: targetTid,
      scope,
    });
    // If AAD rotated the RT, persist the new one — keeps subsequent
    // tricky-login mints from invalidating each other.
    if (exchange.refresh_token && exchange.refresh_token !== rt.refreshToken) {
      importRefreshToken({
        homeAccountId: rt.homeAccountId,
        tenantId: rt.tenantId,
        oid: rt.oid,
        upn: rt.upn,
        name: rt.name,
        clientId: rt.clientId,
        refreshToken: exchange.refresh_token,
      });
    }
    // Defense-in-depth tid check. The FOCI exchange URL contains
    // targetTid so AAD MUST mint for it, but operators have reported
    // edge cases with B2B guest principals where AAD returns a home-
    // tenant token anyway. Throwing here lets Auto mode surface the
    // condition + log it for diagnostics.
    const claims = decodeJwtClaimsUnsafe(exchange.access_token) ?? {};
    const actualTid =
      typeof claims.tid === "string" ? (claims.tid as string) : null;
    if (actualTid && actualTid.toLowerCase() !== targetTid.toLowerCase()) {
      throw new Error(
        `FOCI exchange returned a token for the WRONG tenant — got tid=${actualTid} but requested ${targetTid}. ` +
          `This typically means the source RT was minted for a B2B guest principal whose home directory ` +
          `is being preferred by AAD's tenant resolver. Try minting directly from an account that's a NATIVE ` +
          `member of the target tenant.`,
      );
    }
    return {
      accessToken: exchange.access_token,
      refreshToken: exchange.refresh_token,
      raw: exchange,
    };
  }

  /**
   * Top-level mint orchestrator. Picks the right concrete mint based on
   * `method` (or Auto's MSAL → FOCI sequence) and assembles a
   * `TrickyLoginMintResult` either way. Writes the audit log AFTER the
   * mint has resolved so audit shape lines up with success/failure.
   */
  const doMint = React.useCallback(
    async (
      overrideMethod?: TrickyLoginMethod,
      fromReplay = false,
      // Audience override for batch-mint loops. When omitted, uses
      // the current `audienceId` state. Pass `{ audience }` to mint a
      // specific audience without forcing the operator to re-select.
      overrideAudience?: TrickyAudienceId,
    ) => {
      if (!sourceAccount || !targetTenantId) return;
      const startedAt = performance.now();
      setMinting(true);
      setMintSubStep("Preparing mint…");
      setResult(null);
      setTokenRevealed(false);
      setRtRevealed(false);
      setAutoAttempts([]);
      // Recompute audience + scope locally — when overrideAudience is
      // supplied we ignore the `audienceId` state value entirely
      // (this is the batch-mint path; ignoring state lets us run the
      // loop sequentially without waiting for re-renders).
      const localAudienceId: TrickyAudienceId =
        overrideAudience ?? audienceId;
      const localActiveScope =
        localAudienceId === "custom"
          ? customScope
          : getAudienceChoice(localAudienceId).scope;
      const localEffectiveAudience = audienceForScope(localActiveScope);
      const localChoice = getAudienceChoice(localAudienceId);

      const useMethod: TrickyLoginMethod = overrideMethod ?? method;
      const tenantLabel = findTenantLabel(tenantChoices, targetTenantId);

      const baseResult: Pick<
        TrickyLoginMintResult,
        | "sourceAccountId"
        | "sourceAccountLabel"
        | "targetTenantId"
        | "targetTenantLabel"
        | "audience"
        | "extendedAudience"
        | "scope"
      > = {
        sourceAccountId: sourceAccount.homeAccountId,
        sourceAccountLabel: sourceAccount.username || sourceAccount.homeAccountId,
        targetTenantId,
        targetTenantLabel: tenantLabel,
        audience: localEffectiveAudience,
        extendedAudience: localAudienceId,
        scope: localActiveScope,
      };

      try {
        let attemptToken: string | undefined;
        let attemptRt: string | undefined;
        let attemptMethod: TrickyLoginMethod = useMethod;

        if (useMethod === "msal-silent") {
          const r = await mintViaMsalSilent(
            sourceAccount.homeAccountId,
            targetTenantId,
            localEffectiveAudience,
            localActiveScope,
            localAudienceId,
          );
          attemptToken = r.accessToken;
        } else if (useMethod === "foci-exchange") {
          const r = await mintViaFociExchange(
            sourceAccount.homeAccountId,
            targetTenantId,
            localEffectiveAudience,
            localActiveScope,
          );
          attemptToken = r.accessToken;
          attemptRt = r.refreshToken;
        } else {
          // Auto: try MSAL silent first IF the audience can be serviced
          // by it. For the 9 extended audiences (vault / storage /
          // intune / etc.) the MSAL helpers throw immediately — skip
          // straight to FOCI to avoid the wasted round trip + the
          // confusing "MSAL doesn't support X" entry in the auto-
          // attempts panel.
          if (!localChoice.msalSilentSupported) {
            const rt = getRefreshTokenEntry(sourceAccount.homeAccountId);
            if (!rt) {
              throw new Error(
                `Audience "${localAudienceId.toUpperCase()}" requires the FOCI exchange method (MSAL silent doesn't cover it), but no imported refresh token is available for this account. Paste one on the Import Token page first.`,
              );
            }
            const r = await mintViaFociExchange(
              sourceAccount.homeAccountId,
              targetTenantId,
              localEffectiveAudience,
              localActiveScope,
            );
            attemptToken = r.accessToken;
            attemptRt = r.refreshToken;
            attemptMethod = "foci-exchange";
            if (mountedRef.current) {
              setAutoAttempts((prev) => [
                ...prev,
                {
                  method: "foci-exchange",
                  status: "success",
                  detail: `FOCI exchange succeeded (audience "${localAudienceId.toUpperCase()}" not serviceable via MSAL silent).`,
                },
              ]);
            }
          } else {
          try {
            const r = await mintViaMsalSilent(
              sourceAccount.homeAccountId,
              targetTenantId,
              localEffectiveAudience,
              localActiveScope,
              localAudienceId,
            );
            attemptToken = r.accessToken;
            attemptMethod = "msal-silent";
            if (mountedRef.current) {
              setAutoAttempts((prev) => [
                ...prev,
                {
                  method: "msal-silent",
                  status: "success",
                  detail: "MSAL silent succeeded.",
                },
              ]);
            }
          } catch (msalErr) {
            const msg =
              msalErr instanceof Error ? msalErr.message : String(msalErr);
            if (mountedRef.current) {
              setAutoAttempts((prev) => [
                ...prev,
                {
                  method: "msal-silent",
                  status: "failure",
                  detail: msg,
                },
              ]);
            }
            // Fall back to FOCI if available.
            const rt = getRefreshTokenEntry(sourceAccount.homeAccountId);
            if (!rt) {
              throw new Error(
                `MSAL silent failed (${msg}) and no imported refresh token is available for FOCI fallback.`,
              );
            }
            const r = await mintViaFociExchange(
              sourceAccount.homeAccountId,
              targetTenantId,
              localEffectiveAudience,
              localActiveScope,
            );
            attemptToken = r.accessToken;
            attemptRt = r.refreshToken;
            attemptMethod = "foci-exchange";
            if (mountedRef.current) {
              setAutoAttempts((prev) => [
                ...prev,
                {
                  method: "foci-exchange",
                  status: "success",
                  detail: "FOCI exchange succeeded after MSAL fallback.",
                },
              ]);
            }
          }
          }
        }

        if (!attemptToken) {
          throw new Error("Mint returned no access token (unexpected).");
        }

        const claims = decodeJwtClaimsUnsafe(attemptToken) ?? {};
        const exp =
          typeof claims.exp === "number" ? (claims.exp as number) : undefined;
        const durationMs = Math.round(performance.now() - startedAt);
        const finalResult: TrickyLoginMintResult = {
          ...baseResult,
          status: "success",
          methodUsed: attemptMethod,
          durationMs,
          accessToken: attemptToken,
          refreshToken: attemptRt,
          claims,
          expiresAt: exp,
          finishedAt: new Date().toISOString(),
        };
        if (mountedRef.current) {
          setResult(finalResult);
          setMintSubStep(null);
          pushHistory(toHistoryRow(finalResult));
        }
        // Audit: never log token material — only metadata.
        auditLog.record({
          actor: sourceAccount.username || sourceAccount.homeAccountId,
          action: "tricky_login_mint",
          target: `${tenantLabel} (${targetTenantId})`,
          status: "success",
          details: {
            sourceAccountId: sourceAccount.homeAccountId,
            targetTenantId,
            method: attemptMethod,
            audience: localEffectiveAudience,
            scope: localActiveScope,
            durationMs,
            tokenAudience:
              typeof claims.aud === "string" ? (claims.aud as string) : null,
            replay: fromReplay,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = extractAadErrorCode(msg);
        const durationMs = Math.round(performance.now() - startedAt);
        const finalResult: TrickyLoginMintResult = {
          ...baseResult,
          status: "failure",
          methodUsed: useMethod,
          durationMs,
          errorCode: code,
          errorMessage: msg,
          finishedAt: new Date().toISOString(),
        };
        if (mountedRef.current) {
          setResult(finalResult);
          setMintSubStep(null);
          pushHistory(toHistoryRow(finalResult));
        }
        auditLog.record({
          actor: sourceAccount.username || sourceAccount.homeAccountId,
          action: "tricky_login_mint",
          target: `${tenantLabel} (${targetTenantId})`,
          status: "failure",
          error: msg,
          details: {
            sourceAccountId: sourceAccount.homeAccountId,
            targetTenantId,
            method: useMethod,
            audience: localEffectiveAudience,
            scope: localActiveScope,
            durationMs,
            errorCode: code ?? null,
            replay: fromReplay,
          },
        });
      } finally {
        if (mountedRef.current) {
          setMinting(false);
          setMintSubStep(null);
        }
      }
    },
    // We deliberately only depend on the things that change the mint call
    // surface. Including `result` would cause an unnecessary re-bind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sourceAccount,
      targetTenantId,
      method,
      audienceId,
      customScope,
      tenantChoices,
    ],
  );

  /**
   * Batch mint — ROADtools-style "give me everything for this tenant
   * in one shot". Mints ARM + Graph + Batch tokens sequentially for
   * the SAME target tenant using the SAME source account, with the
   * tenant-tid validators on each. Auto-activate is automatically
   * SUPPRESSED for the first two and FIRED for the last so the
   * operator only suffers one tenant-switch event at the end.
   *
   * Results are collected in `batchMintResults` and rendered in a
   * separate panel — they don't replace the single-mint `result`.
   * Each token is auto-imported into the vault on success so they
   * are immediately usable for the rest of the app.
   */
  interface BatchMintRowResult {
    /** Extended audience id (12-audience batch can hit any of them). */
    audience: TrickyAudienceId;
    /** Vault-friendly bucket (arm/graph/batch/unknown) derived from scope. */
    bucket: AudienceBucket;
    status: "success" | "failure";
    methodUsed?: TrickyLoginMethod;
    durationMs: number;
    error?: string;
    accessToken?: string;
    refreshToken?: string;
    actualTid?: string;
    tokenAudience?: string;
  }
  const [batchMinting, setBatchMinting] = React.useState(false);
  const [batchMintResults, setBatchMintResults] = React.useState<
    BatchMintRowResult[]
  >([]);
  const doBatchMint = React.useCallback(async () => {
    if (!sourceAccount || !targetTenantId) return;
    setBatchMinting(true);
    setBatchMintResults([]);
    const rows: BatchMintRowResult[] = [];
    // Expanded set: ARM + Graph + Batch + 9 additional audiences. The
    // additional ones can ONLY be serviced by the FOCI exchange path —
    // MSAL silent helpers in msal-auth.ts only cover ARM/Graph/Batch,
    // and adding new ones would cross the "no service-layer edits" line.
    const audiences: ReadonlyArray<TrickyAudienceId> = BATCH_MINT_AUDIENCES;
    for (const aud of audiences) {
      const startedAt = performance.now();
      const audienceChoice = getAudienceChoice(aud);
      const bucket = audienceForScope(audienceChoice.scope);
      try {
        // Method selection: ARM/Graph/Batch can try Auto (MSAL → FOCI).
        // Everything else MUST go straight to FOCI (skipping MSAL entirely
        // avoids the wasted call + the confusing "MSAL doesn't support X"
        // error before fallback). If the operator pinned the picker to
        // "foci-exchange" we respect that for the supported audiences too.
        const useM: TrickyLoginMethod = !audienceChoice.msalSilentSupported
          ? "foci-exchange"
          : method === "foci-exchange"
            ? "foci-exchange"
            : "auto";
        let attemptToken: string | undefined;
        let attemptRt: string | undefined;
        let attemptMethod: TrickyLoginMethod = useM;
        if (useM === "foci-exchange") {
          const r = await mintViaFociExchange(
            sourceAccount.homeAccountId,
            targetTenantId,
            bucket,
            audienceChoice.scope,
          );
          attemptToken = r.accessToken;
          attemptRt = r.refreshToken;
        } else {
          try {
            const r = await mintViaMsalSilent(
              sourceAccount.homeAccountId,
              targetTenantId,
              bucket,
              audienceChoice.scope,
              aud,
            );
            attemptToken = r.accessToken;
            attemptMethod = "msal-silent";
          } catch {
            const rt = getRefreshTokenEntry(sourceAccount.homeAccountId);
            if (!rt) throw new Error(`MSAL silent failed for ${aud.toUpperCase()} and no FOCI RT available.`);
            const r = await mintViaFociExchange(
              sourceAccount.homeAccountId,
              targetTenantId,
              bucket,
              audienceChoice.scope,
            );
            attemptToken = r.accessToken;
            attemptRt = r.refreshToken;
            attemptMethod = "foci-exchange";
          }
        }
        if (!attemptToken) throw new Error("Mint returned no access token.");
        const claims = decodeJwtClaimsUnsafe(attemptToken) ?? {};
        const durationMs = Math.round(performance.now() - startedAt);
        rows.push({
          audience: aud,
          bucket,
          status: "success",
          methodUsed: attemptMethod,
          durationMs,
          accessToken: attemptToken,
          refreshToken: attemptRt,
          actualTid: typeof claims.tid === "string" ? (claims.tid as string) : undefined,
          tokenAudience: typeof claims.aud === "string" ? (claims.aud as string) : undefined,
        });
        // Auto-import each into the vault so they are usable. NOTE:
        // for non-arm/graph/batch audiences the vault stores the entry
        // with `audience: "unknown"` — that's fine, it just means the
        // silent-cache short-circuits for ARM/Graph/Batch keep working
        // and the extras are accessible via the listImportedTokens view.
        const preview = previewToken(attemptToken);
        if (preview) {
          const entry = importToken(preview);
          if (attemptRt) {
            importRefreshToken({
              homeAccountId: entry.homeAccountId,
              tenantId: entry.tenantId,
              oid: entry.oid,
              upn: entry.upn,
              name: entry.name,
              clientId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
              refreshToken: attemptRt,
            });
          }
        }
        auditLog.record({
          actor: sourceAccount.username || sourceAccount.homeAccountId,
          action: "tricky_login_mint",
          target: `${findTenantLabel(tenantChoices, targetTenantId)} (${targetTenantId})`,
          status: "success",
          details: {
            sourceAccountId: sourceAccount.homeAccountId,
            targetTenantId,
            method: attemptMethod,
            audience: aud,
            audienceBucket: bucket,
            durationMs,
            batchMint: true,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rows.push({
          audience: aud,
          bucket,
          status: "failure",
          durationMs: Math.round(performance.now() - startedAt),
          error: msg,
        });
        auditLog.record({
          actor: sourceAccount.username || sourceAccount.homeAccountId,
          action: "tricky_login_mint",
          target: `${findTenantLabel(tenantChoices, targetTenantId)} (${targetTenantId})`,
          status: "failure",
          error: msg,
          details: {
            sourceAccountId: sourceAccount.homeAccountId,
            targetTenantId,
            audience: aud,
            audienceBucket: bucket,
            batchMint: true,
          },
        });
      }
      // Update results incrementally so the UI shows progress.
      if (mountedRef.current) {
        setBatchMintResults([...rows]);
      }
    }
    setBatchMinting(false);
    // Auto-activate the new tenant context at the END of the batch
    // (only ONE tenant-switch event for the entire batch).
    if (autoActivateOnSuccess && rows.some((r) => r.status === "success")) {
      try {
        await performTenantSwitch(
          sourceAccount,
          targetTenantId,
          store,
          { source: "external" },
        );
      } catch {
        /* surfaced as notification by the helper */
      }
    }
    const okCount = rows.filter((r) => r.status === "success").length;
    store.addNotification({
      type: okCount > 0 ? "success" : "error",
      message: `Batch mint: ${okCount}/${rows.length} audiences succeeded against ${findTenantLabel(tenantChoices, targetTenantId)}.`,
    });
  }, [
    sourceAccount,
    targetTenantId,
    method,
    autoActivateOnSuccess,
    store,
    tenantChoices,
  ]);

  /* ----------------------------------------------------------------
   * Per-result actions
   * ---------------------------------------------------------------- */

  /** Import the newly-minted token into the local vault. */
  const handleImportToVault = React.useCallback(async () => {
    if (!result || result.status !== "success" || !result.accessToken) return;
    try {
      const preview = previewToken(result.accessToken);
      if (!preview) {
        store.addNotification({
          type: "error",
          message: "Could not decode the new token — refusing to import.",
        });
        return;
      }
      const entry = importToken(preview);
      // If we also have a refresh token, persist it under the same
      // synthetic homeAccountId so the next silent acquire for this
      // audience pair self-refreshes.
      if (result.refreshToken) {
        importRefreshToken({
          homeAccountId: entry.homeAccountId,
          tenantId: entry.tenantId,
          oid: entry.oid,
          upn: entry.upn,
          name: entry.name,
          // Use ARM CLI's client id as the "issuer" — operators can
          // refine on the Token Importer page if they care.
          clientId: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
          refreshToken: result.refreshToken,
        });
      }
      store.addNotification({
        type: "success",
        message: `Imported ${classifyAudience(preview.rawAudience)} token for ${preview.upn ?? preview.oid} → ${preview.tenantId}.`,
      });
      auditLog.record({
        actor: result.sourceAccountLabel,
        action: "tricky_login_import_to_vault",
        target: `${result.targetTenantLabel} (${result.targetTenantId})`,
        status: "success",
        details: {
          sourceAccountId: result.sourceAccountId,
          targetTenantId: result.targetTenantId,
          audience: result.audience,
          importedHomeAccountId: entry.homeAccountId,
          withRefreshToken: !!result.refreshToken,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addNotification({
        type: "error",
        message: `Import failed: ${msg}`,
      });
    }
  }, [result, store]);

  /** Set the source account's active tenant to the just-minted target. */
  const handleSetActive = React.useCallback(async () => {
    if (!result || result.status !== "success") return;
    if (!sourceAccount) {
      store.addNotification({
        type: "error",
        message: "Source account no longer signed in — cannot switch.",
      });
      return;
    }
    try {
      await performTenantSwitch(
        sourceAccount,
        result.targetTenantId,
        store,
        // performTenantSwitch's source union doesn't include "tricky-login",
        // so we use the catch-all "external" — the audit still records the
        // detail via `from: "external"` and our own audit entry below tags
        // the action as `tricky_login_set_as_active` for unambiguous lookup.
        { source: "external" },
      );
      auditLog.record({
        actor: result.sourceAccountLabel,
        action: "tricky_login_set_as_active",
        target: `${result.targetTenantLabel} (${result.targetTenantId})`,
        status: "success",
        details: {
          sourceAccountId: result.sourceAccountId,
          targetTenantId: result.targetTenantId,
          previousActiveTenantId: activeTenantId ?? null,
          methodUsed: result.methodUsed,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addNotification({
        type: "error",
        message: `Set-active failed: ${msg}`,
      });
    }
  }, [result, sourceAccount, store, activeTenantId]);

  /**
   * Auto-activate side-effect for fresh successful mints.
   *
   * Without this, the operator hits Mint, sees a green result, then
   * has to click TWO more buttons (Import to vault + Set as active)
   * to make the new context visible across the rest of the app.
   * The whole point of "Tricky Login" is silent acquisition + global
   * propagation — making the operator chase three buttons per mint
   * defeats it.
   *
   * Keyed on `result.finishedAt` via a ref so re-renders don't
   * re-fire. Only fires once per successful mint, only when the
   * autoActivate toggle is ON. Errors in either step surface as
   * notifications but never block the other (e.g. if Import succeeds
   * but Set-active fails because performTenantSwitch races a
   * concurrent switch, the import still landed).
   */
  const autoActivatedForRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!autoActivateOnSuccess) return;
    if (!result || result.status !== "success") return;
    const fingerprint = result.finishedAt ?? null;
    if (!fingerprint || autoActivatedForRef.current === fingerprint) return;
    autoActivatedForRef.current = fingerprint;
    // Fire both in sequence — import first (synchronous local state)
    // so the vault is hot BEFORE performTenantSwitch pre-warms the
    // ARM token (which short-circuits to the vault entry).
    void (async () => {
      try {
        await handleImportToVault();
      } catch {
        /* import errors already surfaced as notifications */
      }
      try {
        await handleSetActive();
      } catch {
        /* set-active errors already surfaced as notifications */
      }
    })();
  }, [
    result,
    autoActivateOnSuccess,
    handleImportToVault,
    handleSetActive,
  ]);

  /**
   * Re-authenticate via popup, then retry the mint.
   *
   * Triggered when MSAL silent failed with `interaction_required` or
   * `invalid_grant` — the account's MSAL refresh token in the cache
   * is gone (expired, revoked, or wiped by a "Clear sign-in cache"
   * action elsewhere). A popup with `loginHint: source.username`
   * makes AAD pick the right account automatically, and routing the
   * popup AT the target tenant's authority means the same gesture
   * also adds the operator as a (guest) member of that tenant if
   * they aren't one already — exactly what the operator wants
   * post-failure.
   *
   * Tied to the FAILURE result so re-auth only re-targets the
   * specific (account, target tenant, audience) combo that just
   * failed.
   */
  const [reAuthing, setReAuthing] = React.useState(false);
  const handleReAuthenticateAndRetry = React.useCallback(async () => {
    if (!result || result.status !== "failure") return;
    if (!sourceAccount) {
      store.addNotification({
        type: "error",
        message: "Source account no longer signed in — cannot re-authenticate.",
      });
      return;
    }
    setReAuthing(true);
    try {
      // Popup against the TARGET tenant's authority — refreshes the
      // account's MSAL session AND seeds a token for the target
      // tenant in one user gesture. loginHint pre-selects the right
      // account in the AAD picker.
      await loginAccount({
        tenantId: result.targetTenantId,
        loginHint: sourceAccount.username,
        prompt: "select_account",
      });
      store.addNotification({
        type: "success",
        message: `Re-authenticated ${sourceAccount.username} against ${result.targetTenantLabel}. Retrying mint…`,
      });
      auditLog.record({
        actor: sourceAccount.username || sourceAccount.homeAccountId,
        action: "tricky_login_reauth",
        target: `${result.targetTenantLabel} (${result.targetTenantId})`,
        status: "success",
        details: {
          sourceAccountId: sourceAccount.homeAccountId,
          targetTenantId: result.targetTenantId,
        },
      });
      // Re-run the mint with the same audience + method that failed.
      // The fresh MSAL session should now allow silent acquire.
      await doMint(undefined, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addNotification({
        type: "error",
        message: `Re-authentication failed: ${msg}`,
      });
      auditLog.record({
        actor: sourceAccount.username || sourceAccount.homeAccountId,
        action: "tricky_login_reauth",
        target: `${result.targetTenantLabel} (${result.targetTenantId})`,
        status: "failure",
        error: msg,
        details: {
          sourceAccountId: sourceAccount.homeAccountId,
          targetTenantId: result.targetTenantId,
        },
      });
    } finally {
      setReAuthing(false);
    }
  }, [result, sourceAccount, store, doMint]);

  /**
   * MFA re-elevation. Triggered from the success-result panel when the
   * minted access token does NOT carry an `amr` claim value of "mfa" /
   * "ngcmfa" / "wia" (i.e. the operator's session is single-factor and
   * the resource server might still want a step-up).
   *
   * The spec asks us to pass `extraQueryParameters: { acr_values:
   * "urn:mace:incommon:iap:silver" }` so AAD re-evaluates MFA, but the
   * project's `loginAccount` wrapper (msal-auth.ts:604) does NOT accept
   * `extraQueryParameters` — only `{ tenantId, loginHint, prompt }`. We
   * adapt by passing `prompt: "login"`, which forces a fresh credential
   * entry AND triggers Conditional Access policy re-evaluation. For
   * accounts subject to a CA policy that requires MFA, AAD will prompt
   * for the second factor automatically. For accounts NOT subject to
   * such a policy, "login" still produces a fresher token with an updated
   * `iat` and a clean `amr` array — which is the best we can do
   * client-side without editing msal-auth.ts.
   *
   * On success, auto-retries the mint so the new (hopefully MFA-bound)
   * session is captured by the silent acquire.
   */
  const [mfaUpgrading, setMfaUpgrading] = React.useState(false);
  const handleMfaUpgrade = React.useCallback(async () => {
    if (!result || result.status !== "success") return;
    if (!sourceAccount) {
      store.addNotification({
        type: "error",
        message: "Source account no longer signed in — cannot upgrade MFA.",
      });
      return;
    }
    setMfaUpgrading(true);
    try {
      await loginAccount({
        tenantId: result.targetTenantId,
        loginHint: sourceAccount.username,
        // prompt: "login" forces re-auth (no SSO short-circuit) — AAD
        // re-evaluates CA / MFA policies AGAINST THE TARGET TENANT.
        // We intentionally do NOT use extraQueryParameters since
        // loginAccount() in this codebase doesn't accept it (would
        // require a msal-auth.ts edit, out of scope here).
        prompt: "login",
      });
      store.addNotification({
        type: "success",
        message: `Re-authenticated ${sourceAccount.username} with prompt=login against ${result.targetTenantLabel}. If a CA policy requires MFA, the new token's amr should now include "mfa". Retrying mint…`,
      });
      auditLog.record({
        actor: sourceAccount.username || sourceAccount.homeAccountId,
        action: "tricky_login_mfa_upgrade",
        target: `${result.targetTenantLabel} (${result.targetTenantId})`,
        status: "success",
        details: {
          sourceAccountId: sourceAccount.homeAccountId,
          targetTenantId: result.targetTenantId,
          previousAmr: result.claims?.amr ?? null,
        },
      });
      // Re-mint the same audience so the new session is captured.
      await doMint(undefined, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.addNotification({
        type: "error",
        message: `MFA upgrade failed: ${msg}`,
      });
      auditLog.record({
        actor: sourceAccount.username || sourceAccount.homeAccountId,
        action: "tricky_login_mfa_upgrade",
        target: `${result.targetTenantLabel} (${result.targetTenantId})`,
        status: "failure",
        error: msg,
        details: {
          sourceAccountId: sourceAccount.homeAccountId,
          targetTenantId: result.targetTenantId,
        },
      });
    } finally {
      setMfaUpgrading(false);
    }
  }, [result, sourceAccount, store, doMint]);

  /** Pre-seed sessionStorage and hop to the Token Importer. */
  const handleOpenInImporter = React.useCallback(() => {
    if (!result || result.status !== "success" || !result.accessToken) return;
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          TOKEN_IMPORTER_SESSION_KEY,
          result.accessToken,
        );
      }
      navigate("/token-importer");
    } catch (err) {
      store.addNotification({
        type: "error",
        message: `Could not navigate: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [result, store, navigate]);

  /** Copy the raw token to clipboard, toast on success. */
  const handleCopyToken = React.useCallback(async () => {
    if (!result?.accessToken) return;
    try {
      await navigator.clipboard.writeText(result.accessToken);
      store.addNotification({
        type: "success",
        message: "Access token copied to clipboard.",
      });
    } catch {
      store.addNotification({
        type: "warning",
        message:
          "Could not access clipboard — reveal the token below and copy manually.",
      });
    }
  }, [result, store]);

  /** Replay a history row (re-runs the same source/target/method/audience). */
  const handleReplay = React.useCallback(
    (row: TrickyLoginHistoryRow) => {
      // Find the source account again (could have been signed out).
      const acct = azureAccounts.find(
        (a) => a.homeAccountId === row.sourceAccountId,
      );
      if (!acct) {
        store.addNotification({
          type: "error",
          message: `Cannot replay — source account ${row.sourceAccountLabel} is no longer signed in.`,
        });
        return;
      }
      // Set the picker state to match the row, then fire mint with the
      // row's method as an explicit override (so the operator doesn't
      // have to manually re-pick).
      setSourceAccountId(row.sourceAccountId);
      setTargetTenantId(row.targetTenantId);
      // Map scope back to an audience choice. Prefer the row's
      // extendedAudience (richer) — fall back to scope-based detection
      // for legacy rows persisted before the 12-audience expansion.
      const extAud =
        row.extendedAudience ?? extendedAudienceForScope(row.scope);
      if (extAud === "custom") {
        setAudienceId("custom");
        setCustomScope(row.scope);
      } else {
        setAudienceId(extAud);
      }
      setMethod(row.methodUsed);
      // Defer the mint by a tick so the state writes commit first.
      window.setTimeout(() => void doMint(row.methodUsed, true), 50);
    },
    [azureAccounts, doMint, store],
  );

  /* ----------------------------------------------------------------
   * G. Summary stats
   * ---------------------------------------------------------------- */
  const summary = React.useMemo(() => {
    const total = history.length;
    const successes = history.filter((h) => h.status === "success").length;
    const fociHits = history.filter(
      (h) => h.methodUsed === "foci-exchange" && h.status === "success",
    ).length;
    // Cross-tenant guests: distinct target tenant ids in successful rows
    // that differ from any of the operator's home tenant ids.
    const homeTids = new Set(
      azureAccounts.map((a) => (a.tenantId ?? "").toLowerCase()),
    );
    const guestTargets = new Set(
      history
        .filter((h) => h.status === "success")
        .map((h) => (h.targetTenantId ?? "").toLowerCase())
        .filter((tid) => tid && !homeTids.has(tid)),
    );
    return {
      total,
      successes,
      fociHits,
      crossTenantGuests: guestTargets.size,
    };
  }, [history, azureAccounts]);

  /* ----------------------------------------------------------------
   * Render guards
   * ---------------------------------------------------------------- */

  const noAccounts = azureAccounts.length === 0;
  const noTargetTenant = !targetTenantId;
  // Target tenant matches active tenant — surface it as a no-op so the
  // operator doesn't waste a click.
  const targetIsActive =
    !!activeTenantId &&
    !!targetTenantId &&
    activeTenantId.toLowerCase() === targetTenantId.toLowerCase();

  const canMint =
    !!sourceAccount && !noTargetTenant && !targetIsActive && !minting;

  /* ----------------------------------------------------------------
   * Render
   * ---------------------------------------------------------------- */

  return (
    <div className="flex flex-col gap-6">
      {/* ─── Page header ──────────────────────────────────────────── */}
      <PageHeader
        title="Tricky Login"
        description="Silent cross-tenant token mints from your existing sign-in. Re-frames cross-tenant token tricks (ROADtools roadtx, AADInternals, Stormspotter) as defensive admin operations."
      >
        <Badge variant="outline" className="gap-1">
          <ShieldCheck className="h-3 w-3" aria-hidden />
          Defensive admin
        </Badge>
        <TokenExpiryBadge
          secondsUntilExpiry={tokenState.secondsUntilExpiry}
          loading={tokenState.loading}
          onRefresh={tokenState.refresh}
          needsReauth={tokenState.needsReauth}
          onReauth={() =>
            void tokenState.reauth({
              tenantId: activeTenantId,
              loginHint: sourceAccount?.username,
            })
          }
        />
      </PageHeader>

      {/* ─── No-accounts empty state ──────────────────────────────── */}
      {noAccounts && (
        <EmptyState
          icon={KeyRound}
          title="Sign in to use Tricky Login"
          description="You need at least one signed-in Azure account so this page can mint silent cross-tenant tokens from its MSAL cache."
        />
      )}

      {!noAccounts && (
        <>
          {/* ─── Summary stat row ─────────────────────────────────── */}
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Tricky Login session summary"
          >
            <SummaryStatItem
              label="Total attempts"
              value={summary.total}
              hint="this session"
            />
            <SummaryStatItem
              label="Successes"
              value={summary.successes}
              tone={summary.successes > 0 ? "success" : undefined}
            />
            <SummaryStatItem
              label="FOCI exchanges"
              value={summary.fociHits}
              tone={summary.fociHits > 0 ? "info" : undefined}
              hint="successful"
            />
            <SummaryStatItem
              label="Cross-tenant guests"
              value={summary.crossTenantGuests}
              tone={summary.crossTenantGuests > 0 ? "warning" : undefined}
              hint="distinct target tids"
            />
          </div>

          {/* ─── Top-level flow selector ──────────────────────────
              The Tricky Login page supports two fundamentally different
              flows: (A) the original user-account silent-acquire path
              (MSAL silent / FOCI / Auto), and (B) raw Service-Principal
              credential mints (client secret / certificate-OOS / OBO).
              Both produce access tokens but the input shape, audit
              shape, and re-elevation surface are different enough that
              cramming them into one tab strip would be confusing. */}
          <Tabs defaultValue="user" className="w-full">
            <TabsList>
              <TabsTrigger value="user" className="gap-1">
                <Users className="h-3.5 w-3.5" aria-hidden />
                User account
              </TabsTrigger>
              <TabsTrigger value="sp" className="gap-1">
                <Lock className="h-3.5 w-3.5" aria-hidden />
                Service Principal
              </TabsTrigger>
            </TabsList>

            <TabsContent value="user" className="flex flex-col gap-6">
          {/* ─── Source + target picker ───────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4 text-primary" aria-hidden />
                Source account &amp; target tenant
              </CardTitle>
              <CardDescription>
                Pick a signed-in account, then pick the tenant you want to mint a token for. Silent acquisition only succeeds for tenants the source account is already entitled to access.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              {/* Source account picker */}
              <div className="flex flex-col gap-2">
                <Label className="flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground">
                  Source account
                  <InfoTooltip content="The signed-in MSAL account whose silent acquisition we'll use. Tokens are minted against its own MSAL cache — no credential prompt." />
                </Label>
                <Select
                  value={sourceAccountId}
                  onValueChange={(v) => setSourceAccountId(v)}
                >
                  <SelectTrigger aria-label="Source account">
                    <SelectValue placeholder="Select an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {azureAccounts.map((a) => (
                      <SelectItem key={a.homeAccountId} value={a.homeAccountId}>
                        {a.username || a.name || a.homeAccountId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sourceAccount && (
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                    <Badge variant="outline" className="gap-1">
                      <Globe className="h-3 w-3" aria-hidden />
                      Currently active:{" "}
                      {findTenantLabel(tenantChoices, activeTenantId)}
                    </Badge>
                    <Badge variant="outline">
                      Home tenant: {sourceAccount.tenantId}
                    </Badge>
                    {importedRt && (
                      <Badge variant="info" className="gap-1">
                        <KeyRound className="h-3 w-3" aria-hidden />
                        Imported RT available
                      </Badge>
                    )}
                  </div>
                )}
              </div>

              {/* Target tenant picker */}
              <div className="flex flex-col gap-2">
                <Label className="flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground">
                  Target tenant
                  <InfoTooltip content="The tenant you want a new token for. Greyed-out entries are either the source's currently-active tenant (would be a no-op) or not yet hydrated." />
                </Label>
                <div className="flex items-center gap-2">
                  <Select
                    value={targetTenantId}
                    onValueChange={(v) => setTargetTenantId(v)}
                    disabled={tenantChoices.length === 0}
                  >
                    <SelectTrigger className="flex-1" aria-label="Target tenant">
                      <SelectValue
                        placeholder={
                          tenantChoices.length === 0
                            ? tenantsLoading
                              ? "Loading tenants…"
                              : "No tenants loaded — click Discover"
                            : "Select target tenant"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {tenantChoices.map((t) => {
                        const isActive =
                          !!activeTenantId &&
                          (t.tenantId ?? "").toLowerCase() ===
                            activeTenantId.toLowerCase();
                        return (
                          <SelectItem
                            key={t.tenantId}
                            value={t.tenantId}
                            disabled={isActive}
                          >
                            {(t.displayName ?? t.defaultDomain ?? t.tenantId) +
                              (isActive ? "  (active — no-op)" : "")}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => sourceAccountId && void fetchTenants(sourceAccountId)}
                    disabled={!sourceAccountId || tenantsLoading}
                    title="Re-list accessible tenants for the source account (ARM /tenants)"
                    className="gap-1"
                  >
                    {tenantsLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {tenantChoices.length === 0 ? "Discover" : "Refresh"}
                  </Button>
                </div>
                {tenantsError && (
                  <p className="text-2xs text-destructive">{tenantsError}</p>
                )}
                {targetIsActive && (
                  <p className="flex items-center gap-1 text-2xs text-warning">
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                    This is the source account's active tenant — no mint would be performed.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ─── Tricks discovery + method selector ───────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wand2 className="h-4 w-4 text-primary" aria-hidden />
                Tricks discovery
              </CardTitle>
              <CardDescription>
                Per-method availability for the selected (account, tenant) pair. The page never makes interactive prompts; if a method's row is ✗, it would fail at submit time.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ul className="flex flex-col gap-1 text-xs">
                <li
                  className={cn(
                    "flex items-start gap-2",
                    availability.msalSilent.available
                      ? "text-success"
                      : "text-muted-foreground",
                  )}
                >
                  {availability.msalSilent.available ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5" aria-hidden />
                  )}
                  <span>{availability.msalSilent.reason}</span>
                </li>
                <li
                  className={cn(
                    "flex items-start gap-2",
                    availability.fociExchange.available
                      ? "text-success"
                      : "text-muted-foreground",
                  )}
                >
                  {availability.fociExchange.available ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5" aria-hidden />
                  )}
                  <span>{availability.fociExchange.reason}</span>
                </li>
                <li className="flex items-start gap-2 text-muted-foreground">
                  <XCircle className="mt-0.5 h-3.5 w-3.5" aria-hidden />
                  <span>{availability.directTenantRt.reason}</span>
                </li>
              </ul>

              <div className="flex flex-col gap-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Method
                </Label>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      {
                        id: "auto" as const,
                        label: "Auto",
                        hint: "Try MSAL silent, fall back to FOCI on failure.",
                        icon: Sparkles,
                      },
                      {
                        id: "msal-silent" as const,
                        label: "MSAL Silent",
                        hint: "acquireTokenSilent against the target tenant authority.",
                        icon: Repeat2,
                      },
                      {
                        id: "foci-exchange" as const,
                        label: "FOCI exchange",
                        hint: "POST grant_type=refresh_token to the target tenant's token endpoint.",
                        icon: Zap,
                      },
                    ] as const
                  ).map((m) => {
                    const Icon = m.icon;
                    const selected = method === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setMethod(m.id)}
                        className={cn(
                          "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected
                            ? "border-primary/60 bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                        )}
                        aria-pressed={selected}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                        <span>{m.label}</span>
                        <InfoTooltip
                          content={m.hint}
                          ariaLabel={`${m.label} method info`}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ─── Audience picker + mint button ────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Award className="h-4 w-4 text-primary" aria-hidden />
                Audience &amp; mint
              </CardTitle>
              <CardDescription>
                Pick the resource the new token should be valid for. Custom scope lets you target other Azure resource servers (must end in <code>/.default</code> for app-permission flows).
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                {AUDIENCE_CHOICES.map((c) => {
                  const selected = audienceId === c.id;
                  const accent = audienceChipAccent(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setAudienceId(c.id);
                        if (c.id !== "custom") setCustomScope(c.scope);
                      }}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "border-primary/60 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                      )}
                      aria-pressed={selected}
                    >
                      <Badge variant={accent.badge} className="px-1.5 py-0">
                        {c.label}
                      </Badge>
                      <InfoTooltip
                        content={c.description}
                        ariaLabel={`${c.label} info`}
                      />
                    </button>
                  );
                })}
              </div>
              {audienceId === "custom" && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="tricky-custom-scope" className="text-xs">
                    Custom scope
                  </Label>
                  <Input
                    id="tricky-custom-scope"
                    value={customScope}
                    onChange={(e) => setCustomScope(e.target.value)}
                    placeholder="https://management.azure.com/.default"
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                </div>
              )}

              {/* ─── Federation / ADFS pre-flight alert ─────────────
                  Surfaces BEFORE the mint button so the operator can
                  see whether the chosen source UPN is managed or
                  federated. Federated UPNs route credentials through a
                  third-party STS (corp ADFS, customer-owned identity
                  provider, etc.) — operators should know this before
                  triggering an MFA re-elevation popup. Managed UPNs
                  produce no alert (no noise). Unknown realm renders a
                  soft info chip. Probe errors (CORS / network) render
                  as a tiny info chip but never block the mint. */}
              {realmProbe && realmProbe.status === "federated" && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  <AlertTitle className="text-sm">
                    Federated account
                  </AlertTitle>
                  <AlertDescription className="text-xs">
                    Account{" "}
                    <code className="font-mono">
                      {sourceAccount?.username}
                    </code>{" "}
                    is federated{realmProbe.domainName ? ` (domain ${realmProbe.domainName})` : ""}
                    . Credentials are sent to{" "}
                    <code className="font-mono">
                      {realmProbe.stsUrl ?? realmProbe.authUrl ?? "(STS URL absent)"}
                    </code>{" "}
                    — not directly to Microsoft. Any MFA / password
                    prompt during re-authentication goes to that STS.
                    {realmProbe.federationProtocol && (
                      <>
                        {" "}
                        Protocol:{" "}
                        <code className="font-mono">
                          {realmProbe.federationProtocol}
                        </code>
                        .
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              {realmProbe && realmProbe.status === "unknown" && (
                <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                  <Info className="h-3 w-3" aria-hidden />
                  Realm discovery returned NameSpaceType=Unknown for{" "}
                  <code className="font-mono">{sourceAccount?.username}</code>{" "}
                  — domain may be unregistered or non-AAD.
                </div>
              )}
              {realmError && !realmProbe && (
                <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                  <Info className="h-3 w-3" aria-hidden />
                  Could not probe federation realm ({realmError}). Mint
                  is still allowed; the alert is informational only.
                </div>
              )}
              {realmLoading && (
                <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Probing federation realm for{" "}
                  <code className="font-mono">{sourceAccount?.username}</code>…
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void doMint()}
                  disabled={!canMint || batchMinting}
                  loading={minting}
                  className="gap-2"
                >
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Mint silent token for{" "}
                  {targetTenantId
                    ? findTenantLabel(tenantChoices, targetTenantId)
                    : "(pick a tenant)"}
                </Button>
                {/* Batch-mint trick: 12 audiences for the same target
                    in one click. ROADtools-style "give me everything
                    for this tenant" workflow. Each mint is audited +
                    tid-validated independently; auto-activate (if ON)
                    fires ONCE at the end. Non-ARM/Graph/Batch audiences
                    go straight to FOCI (no wasted MSAL round-trip). */}
                <Button
                  onClick={() => void doBatchMint()}
                  disabled={!canMint || minting}
                  loading={batchMinting}
                  variant="outline"
                  className="gap-2"
                  title="Mint 12 audience tokens for the same target tenant in one click"
                >
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Batch mint 12 audiences
                </Button>
                {mintSubStep && (
                  <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    {mintSubStep}
                  </span>
                )}
              </div>
              {/* Batch mint results panel — shows per-audience
                  status + tid match. Appears once a batch has been
                  kicked off; each row updates live as the
                  corresponding mint completes. */}
              {batchMintResults.length > 0 && (
                <div className="flex flex-col gap-1 rounded-md border bg-card/30 p-3">
                  <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="h-3 w-3" aria-hidden />
                    Batch mint results (
                    {batchMintResults.filter((r) => r.status === "success").length}
                    /{batchMintResults.length})
                  </div>
                  <table className="w-full text-2xs">
                    <thead className="text-2xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 text-left">Audience</th>
                        <th className="px-2 py-1 text-left">Status</th>
                        <th className="px-2 py-1 text-left">Method</th>
                        <th className="px-2 py-1 text-left">Tid match</th>
                        <th className="px-2 py-1 text-left">ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchMintResults.map((r) => {
                        const tidOk =
                          r.actualTid &&
                          targetTenantId &&
                          r.actualTid.toLowerCase() === targetTenantId.toLowerCase();
                        return (
                          <tr key={r.audience} className="border-t">
                            <td className="px-2 py-1 font-mono uppercase">
                              {r.audience}
                            </td>
                            <td className="px-2 py-1">
                              {r.status === "success" ? (
                                <Badge variant="outline" className="text-3xs">
                                  ok
                                </Badge>
                              ) : (
                                <span
                                  className="text-destructive"
                                  title={r.error}
                                >
                                  failed
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1 font-mono text-3xs">
                              {r.methodUsed ?? "—"}
                            </td>
                            <td className="px-2 py-1">
                              {r.status === "success" ? (
                                tidOk ? (
                                  <CheckCircle2
                                    className="h-3 w-3 text-success"
                                    aria-label="tid match"
                                  />
                                ) : (
                                  <AlertTriangle
                                    className="h-3 w-3 text-destructive"
                                    aria-label="tid mismatch"
                                  />
                                )
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="px-2 py-1 tabular-nums">
                              {r.durationMs}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <span className="text-3xs text-muted-foreground">
                    All successful tokens auto-imported into the vault. Switch
                    to the target tenant via the header pill or open Token
                    Importer to use them per-audience.
                  </span>
                </div>
              )}
              {/*
                Auto-activate toggle. Default ON so the freshly-
                minted token immediately becomes the operator's live
                identity across the rest of the app (import to vault
                + performTenantSwitch + TENANT_CHANGED_EVENT). Turn
                OFF when batch-minting (e.g. ARM + Graph + Batch for
                the same target) so only the last one activates.
              */}
              <label className="flex cursor-pointer select-none items-center gap-2 text-2xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoActivateOnSuccess}
                  onChange={(e) => setAutoActivateOnSuccess(e.target.checked)}
                  className="h-3.5 w-3.5"
                  aria-label="Auto-activate the minted context on success"
                />
                <span>
                  <strong className="text-foreground">
                    Auto-activate on success
                  </strong>{" "}
                  — after a successful mint, automatically import the
                  token to the vault AND switch the active tenant so
                  every page in the app uses this context. (Off →
                  manual: click Import / Set-active in the result
                  panel.)
                </span>
              </label>
            </CardContent>
          </Card>

          {/* ─── Auto attempts panel (only when method=auto and we ran) */}
          {autoAttempts.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Auto-mode attempts</CardTitle>
                <CardDescription className="text-xs">
                  Each sub-attempt the Auto orchestrator made, in order.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1 text-xs">
                  {autoAttempts.map((a, i) => (
                    <li
                      key={i}
                      className={cn(
                        "flex items-start gap-2",
                        a.status === "success"
                          ? "text-success"
                          : "text-destructive",
                      )}
                    >
                      {a.status === "success" ? (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <XCircle className="mt-0.5 h-3.5 w-3.5" aria-hidden />
                      )}
                      <span>
                        <span className="font-medium">
                          {methodShortLabel(a.method)}
                        </span>{" "}
                        — {a.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* ─── Result panel ─────────────────────────────────────── */}
          {result && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">Mint result</CardTitle>
                  {result.status === "success" ? (
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" aria-hidden />
                      Success
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="gap-1">
                      <XCircle className="h-3 w-3" aria-hidden />
                      Failure
                    </Badge>
                  )}
                  <Badge variant="outline">
                    Method: {methodLabel(result.methodUsed)}
                  </Badge>
                  <Badge variant="outline">
                    Audience:{" "}
                    {getAudienceChoice(
                      result.extendedAudience ??
                        (result.audience === "unknown"
                          ? "custom"
                          : result.audience),
                    ).label}
                  </Badge>
                  <Badge variant="outline">
                    {fmtDuration(result.durationMs / 1000)} elapsed
                  </Badge>
                  {result.status === "success" && result.expiresAt && (
                    <Badge variant="outline">
                      {formatExpiresIn(result.expiresAt)}
                    </Badge>
                  )}
                  {result.status === "failure" && result.errorCode && (
                    <Badge variant="destructive">{result.errorCode}</Badge>
                  )}
                </div>
                <CardDescription className="text-xs">
                  Target tenant{" "}
                  <span className="font-mono">{result.targetTenantLabel}</span> (
                  {result.targetTenantId}), source account{" "}
                  <span className="font-mono">{result.sourceAccountLabel}</span>.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {result.status === "failure" && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" aria-hidden />
                    <AlertTitle className="text-sm">
                      Mint failed
                      {result.errorCode ? ` — ${result.errorCode}` : ""}
                    </AlertTitle>
                    <AlertDescription className="text-xs">
                      <p className="m-0 whitespace-pre-wrap break-all font-mono">
                        {result.errorMessage}
                      </p>
                      {/*
                        Specific remediation for interaction_required
                        / invalid_grant / "Cached session is no longer
                        valid": both MSAL silent and FOCI fallback are
                        dead in the water until the operator either
                        re-authenticates the account (popup) or imports
                        a fresh refresh token. The re-auth path is
                        almost always what they want — it routes the
                        popup against the TARGET tenant's authority so
                        the same gesture refreshes the MSAL session
                        AND seeds the silent cache for the target.
                      */}
                      {(() => {
                        const msg = result.errorMessage ?? "";
                        const needsReAuth =
                          /interaction_required|invalid_grant|Cached session is no longer valid|AADSTS50173|AADSTS50058|AADSTS50076|AADSTS50079|AADSTS65001/i.test(
                            msg,
                          );
                        return (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {needsReAuth && (
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() =>
                                  void handleReAuthenticateAndRetry()
                                }
                                loading={reAuthing}
                                disabled={reAuthing}
                                className="gap-1.5"
                              >
                                <KeyRound className="h-3.5 w-3.5" aria-hidden />
                                Re-authenticate {sourceAccount?.username} against{" "}
                                {result.targetTenantLabel} (popup) &amp; retry
                              </Button>
                            )}
                            {result.methodUsed !== "auto" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  void doMint(
                                    result.methodUsed === "msal-silent"
                                      ? "foci-exchange"
                                      : "msal-silent",
                                  )
                                }
                              >
                                Try{" "}
                                {result.methodUsed === "msal-silent"
                                  ? "FOCI exchange"
                                  : "MSAL silent"}
                              </Button>
                            )}
                            {needsReAuth && (
                              <span className="self-center text-2xs italic opacity-80">
                                MSAL's cached session for this account is
                                gone — only an interactive popup can
                                replace it. Routing the popup at the
                                target tenant also makes you a member of
                                it if you aren't already.
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </AlertDescription>
                  </Alert>
                )}

                {result.status === "success" && (
                  <>
                    {/* Tenant verification badge — surfaces the
                        wrong-tenant bug ROADtools / operators have
                        hit where MSAL returns a cached home-tenant
                        token despite an explicit authority. Compares
                        the requested target tid with the actual tid
                        from the returned token's claims. The post-
                        mint validators above (mintViaMsalSilent /
                        mintViaFociExchange) already throw on a
                        mismatch, so reaching here with status=success
                        means a match — but we still display it so
                        the operator gets an explicit ✓. */}
                    {(() => {
                      const actualTid =
                        typeof result.claims?.tid === "string"
                          ? (result.claims!.tid as string)
                          : null;
                      const ok =
                        !!actualTid &&
                        actualTid.toLowerCase() ===
                          result.targetTenantId.toLowerCase();
                      return (
                        <div
                          className={cn(
                            "flex flex-col gap-1 rounded-md border p-3",
                            ok
                              ? "border-success/40 bg-success/5"
                              : "border-destructive/40 bg-destructive/5",
                          )}
                        >
                          <div className="flex items-center gap-2 text-xs font-semibold">
                            {ok ? (
                              <CheckCircle2
                                className="h-4 w-4 text-success"
                                aria-hidden
                              />
                            ) : (
                              <AlertTriangle
                                className="h-4 w-4 text-destructive"
                                aria-hidden
                              />
                            )}
                            <span>
                              {ok
                                ? "Tenant verification PASS — token tid matches requested target"
                                : "Tenant verification FAIL — token tid does not match"}
                            </span>
                          </div>
                          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 pt-1 text-2xs">
                            <dt className="text-muted-foreground">
                              Requested:
                            </dt>
                            <dd className="font-mono">
                              {result.targetTenantId}
                            </dd>
                            <dt className="text-muted-foreground">
                              Actual (token tid):
                            </dt>
                            <dd className="font-mono">
                              {actualTid ?? "(absent)"}
                            </dd>
                            <dt className="text-muted-foreground">
                              Audience (aud):
                            </dt>
                            <dd className="font-mono">
                              {typeof result.claims?.aud === "string"
                                ? (result.claims!.aud as string)
                                : "(absent)"}
                            </dd>
                            <dt className="text-muted-foreground">
                              App (azp/appid):
                            </dt>
                            <dd className="font-mono">
                              {(typeof result.claims?.azp === "string"
                                ? (result.claims!.azp as string)
                                : null) ??
                                (typeof result.claims?.appid === "string"
                                  ? (result.claims!.appid as string)
                                  : null) ??
                                "(absent)"}
                            </dd>
                          </dl>
                        </div>
                      );
                    })()}

                    {/* Authority URL preview — shows the exact
                        /oauth2/v2.0/token endpoint a FOCI exchange
                        would POST to for this (target tenant). Useful
                        for diagnosing tenant-routing issues, copying
                        the URL into curl/Postman, or just
                        understanding what MSAL is doing under the
                        hood. */}
                    <div className="flex flex-col gap-1 rounded-md border bg-card/30 p-3">
                      <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <Sparkles className="h-3 w-3" aria-hidden />
                        AAD endpoint hit (informational)
                        <InfoTooltip
                          content="The actual /oauth2/v2.0/token URL the FOCI exchange path would POST to. MSAL silent acquire hits the same authority under the hood, but routes via the configured customNetworkClient (dev-server proxy). Copy this URL into curl / Postman with grant_type=refresh_token + client_id + refresh_token + scope to replay the exchange outside the app."
                        />
                      </div>
                      <code className="break-all font-mono text-2xs">
                        https://login.microsoftonline.com/
                        {result.targetTenantId}/oauth2/v2.0/token
                      </code>
                      <div className="flex items-center gap-2 pt-1">
                        <CopyableText
                          value={`https://login.microsoftonline.com/${result.targetTenantId}/oauth2/v2.0/token`}
                          mono
                          alwaysVisibleButton
                          ariaLabel="Copy authority URL"
                        />
                      </div>
                    </div>

                    {/* Decoded claims */}
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                        Decoded access-token claims
                        <InfoTooltip content="Signature NOT verified — these are read straight off the JWT body. The remote resource server is the one that will accept or reject the token." />
                      </div>
                      <div className="rounded-md border bg-card/50">
                        <table className="w-full text-xs">
                          <thead className="border-b text-2xs uppercase text-muted-foreground">
                            <tr>
                              <th className="w-44 px-3 py-1.5 text-left font-medium">
                                Claim
                              </th>
                              <th className="px-3 py-1.5 text-left font-medium">
                                Value
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(result.claims ?? {})
                              .sort(([a], [b]) => a.localeCompare(b))
                              .map(([k, v]) => (
                                <tr
                                  key={k}
                                  className="border-b last:border-b-0 hover:bg-muted/30"
                                >
                                  <td className="px-3 py-1.5 align-top font-mono text-2xs">
                                    <span className="inline-flex items-center gap-1">
                                      {k}
                                      {CLAIM_EXPLAIN[k] && (
                                        <InfoTooltip
                                          content={CLAIM_EXPLAIN[k]}
                                          ariaLabel={`${k} explained`}
                                          size={12}
                                        />
                                      )}
                                    </span>
                                  </td>
                                  <td className="px-3 py-1.5 align-top break-all font-mono text-2xs text-muted-foreground">
                                    {formatClaimValue(k, v)}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Refresh-token presence indicator */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {result.refreshToken ? (
                        <>
                          <Badge variant="info" className="gap-1">
                            <KeyRound className="h-3 w-3" aria-hidden />
                            Refresh token returned
                          </Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRtRevealed((v) => !v)}
                            className="gap-1"
                          >
                            {rtRevealed ? (
                              <EyeOff className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <Eye className="h-3.5 w-3.5" aria-hidden />
                            )}
                            {rtRevealed ? "Hide" : "Reveal"}
                          </Button>
                          {rtRevealed && (
                            <div className="flex w-full items-center gap-2">
                              <code className="flex-1 break-all rounded border bg-muted/30 p-2 font-mono text-2xs text-muted-foreground">
                                {result.refreshToken}
                              </code>
                              <CopyButton
                                value={result.refreshToken}
                                alwaysVisible
                                ariaLabel="Copy refresh token"
                              />
                            </div>
                          )}
                        </>
                      ) : (
                        <Badge variant="outline">
                          No refresh token returned
                        </Badge>
                      )}
                    </div>

                    {/* Access token reveal + copy */}
                    {result.accessToken && (
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <Badge variant="success" className="gap-1">
                            <KeyRound className="h-3 w-3" aria-hidden />
                            Access token minted
                          </Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setTokenRevealed((v) => !v)}
                            className="gap-1"
                          >
                            {tokenRevealed ? (
                              <EyeOff className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <Eye className="h-3.5 w-3.5" aria-hidden />
                            )}
                            {tokenRevealed ? "Hide" : "Reveal"}
                          </Button>
                          <span className="font-mono text-2xs text-muted-foreground">
                            {maskToken(result.accessToken)}
                          </span>
                        </div>
                        {tokenRevealed && (
                          <div className="flex items-center gap-2">
                            <code className="flex-1 break-all rounded border bg-muted/30 p-2 font-mono text-2xs text-muted-foreground">
                              {result.accessToken}
                            </code>
                            <CopyButton
                              value={result.accessToken}
                              alwaysVisible
                              ariaLabel="Copy access token"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* ─── MFA re-elevation surface ────────────────
                        Detect when the minted token does NOT carry an
                        MFA-bound `amr` claim value. AAD canonically
                        emits one of "mfa" / "ngcmfa" / "wia" when the
                        session traveled through a strong-auth gesture
                        (Authenticator push, FIDO key, Windows Hello,
                        smart card, etc.). Tokens minted entirely
                        through a refresh-token or silent acquire path
                        do NOT add `amr` — meaning the current session
                        is single-factor. Many resource servers (Privileged
                        Identity Management, Microsoft Graph
                        delegated-write scopes) will fail with
                        `interaction_required` claims-challenge until the
                        operator re-authenticates. The button below
                        opens a popup with prompt=login so AAD
                        re-evaluates CA policy and (if MFA is required)
                        prompts for the second factor. */}
                    {(() => {
                      const amrClaim = result.claims?.amr;
                      const amrList = Array.isArray(amrClaim)
                        ? amrClaim.map((v) => String(v).toLowerCase())
                        : typeof amrClaim === "string"
                          ? [amrClaim.toLowerCase()]
                          : [];
                      const hasStrongAuth = amrList.some((m) =>
                        ["mfa", "ngcmfa", "wia"].includes(m),
                      );
                      const showUpgrade = !hasStrongAuth;
                      if (!showUpgrade) return null;
                      return (
                        <Alert variant="info" className="mt-1">
                          <Shield className="h-4 w-4" aria-hidden />
                          <AlertTitle className="text-sm">
                            Single-factor session detected
                          </AlertTitle>
                          <AlertDescription className="text-xs">
                            <p className="m-0">
                              The minted access token&apos;s{" "}
                              <code className="font-mono">amr</code> claim is{" "}
                              {amrList.length === 0
                                ? "absent"
                                : `[${amrList.join(", ")}]`}{" "}
                              — no MFA / ngcmfa / WIA marker. Resource
                              servers that require a step-up (PIM
                              activation, privileged Graph writes) will
                              reject this token with{" "}
                              <code className="font-mono">interaction_required</code>
                              . Re-authenticate with{" "}
                              <code className="font-mono">prompt=login</code>{" "}
                              so AAD re-evaluates the CA policy, then the
                              mint will be retried automatically.
                            </p>
                            <div className="mt-2">
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => void handleMfaUpgrade()}
                                loading={mfaUpgrading}
                                disabled={mfaUpgrading}
                                className="gap-1.5"
                              >
                                <Lock className="h-3.5 w-3.5" aria-hidden />
                                Upgrade to MFA-bound token
                              </Button>
                            </div>
                          </AlertDescription>
                        </Alert>
                      );
                    })()}

                    {/* Per-result actions */}
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleImportToVault()}
                        className="gap-1"
                      >
                        <KeyRound className="h-3.5 w-3.5" aria-hidden />
                        Import to vault
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleSetActive()}
                        className="gap-1"
                      >
                        <Repeat2 className="h-3.5 w-3.5" aria-hidden />
                        Set as active context
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleOpenInImporter}
                        className="gap-1"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        Open Token Importer
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCopyToken()}
                        className="gap-1"
                      >
                        <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
                        Copy raw token
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* ─── History ──────────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <RefreshCcw className="h-4 w-4 text-primary" aria-hidden />
                History
                <InfoTooltip content="Session-scoped: persists to sessionStorage so navigating away + back keeps the log, but a tab close wipes it. Capped at 20 entries." />
              </CardTitle>
              <CardDescription>
                Past mint attempts (most recent first). Replay re-runs the
                same source / target / method / audience combination.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No attempts yet.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="border-b bg-muted/30 text-2xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">
                          When
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          Source account
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          Target tenant
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          Method
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          Audience
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          Status
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          Took
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          {/* actions */}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((row) => (
                        <tr
                          key={row.id}
                          className="border-b last:border-b-0 hover:bg-muted/30"
                        >
                          <td className="px-3 py-1.5 text-2xs text-muted-foreground">
                            <span title={formatDateTime(row.finishedAt)}>
                              {formatRelativeTime(row.finishedAt)}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 font-mono text-2xs">
                            {row.sourceAccountLabel}
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex flex-col">
                              <span>{row.targetTenantLabel}</span>
                              <span className="font-mono text-3xs text-muted-foreground">
                                {row.targetTenantId}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-1.5">
                            <Badge variant="outline" className="px-1.5 py-0">
                              {methodShortLabel(row.methodUsed)}
                            </Badge>
                          </td>
                          <td className="px-3 py-1.5">
                            <Badge variant="outline" className="px-1.5 py-0">
                              {(row.extendedAudience ?? row.audience).toUpperCase()}
                            </Badge>
                          </td>
                          <td className="px-3 py-1.5">
                            {row.status === "success" ? (
                              <Badge variant="success" className="px-1.5 py-0">
                                ok
                              </Badge>
                            ) : (
                              <Badge
                                variant="destructive"
                                className="px-1.5 py-0"
                                title={row.errorCode ?? "failure"}
                              >
                                {row.errorCode ?? "fail"}
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-2xs text-muted-foreground">
                            {fmtDuration(row.durationMs / 1000)}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleReplay(row)}
                              disabled={minting}
                              className="gap-1"
                              title="Re-run this attempt with the same parameters"
                            >
                              <RefreshCcw
                                className="h-3.5 w-3.5"
                                aria-hidden
                              />
                              Replay
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ─── About footer ─────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Info className="h-4 w-4 text-primary" aria-hidden />
                About this page
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-xs sm:grid-cols-2">
                <div>
                  <dt className="font-semibold text-foreground">
                    What it does
                  </dt>
                  <dd className="m-0 mt-0.5 text-muted-foreground">
                    Silently mints access tokens for tenants the signed-in
                    operator can already reach (member, guest, partner) —
                    without re-entering credentials. Useful when an admin
                    has been B2B-invited into a customer tenant and wants
                    an ARM / Graph / Batch token for it from their
                    existing session.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-foreground">
                    Why it is not an offensive primitive
                  </dt>
                  <dd className="m-0 mt-0.5 text-muted-foreground">
                    No credentials are stolen. Silent acquisition only
                    succeeds when the operator has already authenticated
                    and the target tenant has granted them access. We
                    never prompt for a password, never touch the
                    operator's PRT / device cert, and never reach into
                    another principal's MSAL cache.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-foreground">
                    Three methods, all defensive
                  </dt>
                  <dd className="m-0 mt-0.5 text-muted-foreground">
                    <span className="block">
                      ① <em>MSAL silent multi-tenant</em> —
                      <code className="ml-1">acquireTokenSilent</code> with
                      the target tenant authority.
                    </span>
                    <span className="block">
                      ② <em>FOCI refresh-token exchange</em> — spends an
                      already-imported refresh token at the target
                      tenant's token endpoint.
                    </span>
                    <span className="block">
                      ③ <em>Auto</em> — tries MSAL first, falls back to
                      FOCI if MSAL surfaces interaction_required.
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-foreground">
                    Audit + credit
                  </dt>
                  <dd className="m-0 mt-0.5 text-muted-foreground">
                    Every mint records to the audit log under{" "}
                    <code>tricky_login_mint</code>, with method, audience,
                    duration, and the resulting <code>aud</code> claim
                    only — NEVER the token material. The page concept is
                    a defensive flip of tricks documented in{" "}
                    <a
                      href="https://github.com/dirkjanm/ROADtools"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      ROADtools (roadtx)
                    </a>{" "}
                    and{" "}
                    <a
                      href="https://github.com/Gerenios/AADInternals"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      AADInternals
                    </a>
                    .
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
            </TabsContent>

            <TabsContent value="sp" className="flex flex-col gap-6">
              {/* ─── Service Principal credential flow ───────────────
                  Separate tab so the SP form fields don't pollute the
                  user-account picker, and so the audit log surface is
                  unambiguous (tricky_login_sp_mint vs.
                  tricky_login_mint). The SpLoginTab component is
                  self-contained: it manages its own form state, mint
                  result, and audit hook. */}
              <SpLoginTab />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
};
