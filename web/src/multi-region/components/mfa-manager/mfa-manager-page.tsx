/**
 * MFA Manager — manage Entra ID authentication methods (MFA) for the
 * operator's OWN signed-in accounts and for a target user, plus a self-
 * contained OATH (TOTP) seed lab.
 *
 * Three modes (tabs):
 *
 *   1. Signed-in accounts — for every account logged into the app, view its
 *      OWN registered methods (`/me/authentication/methods`), reset them
 *      (delete → force re-registration) with optional session revoke, register
 *      a new phone/email method, and issue a Temporary Access Pass.
 *
 *   2. Target user — pick a signed-in admin account, resolve a user by UPN /
 *      object id, then manage THAT user's methods (`/users/{id}/…`). This is
 *      the same surface the Tenant Users "Reset MFA" dialog exposes, widened
 *      to registration + TAP issuance.
 *
 *   3. OATH seed lab — generate a software-OATH (TOTP) seed client-side, show
 *      its provisioning URI + a live RFC-6238 code, and verify it. Graph v1.0
 *      returns a null `softwareOathMethods` secret, so a *usable* seed can't be
 *      minted server-side; this is the supported programmable-token path.
 *
 * "Tricks" mirrored from the research corpus (AADInternals `MFA.ps1` —
 * New-OTPSecret / New-OTP, the method-swap + default-method handling) re-cast
 * on Microsoft Graph v1.0 + Web Crypto, with full audit-logging on every write
 * so each privileged change is observable (see _bypass_modify_delete.md §2).
 */
import * as React from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Info,
  KeyRound,
  Loader2,
  Mail,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Timer,
  Trash2,
  User,
  Users,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, pluralize } from "@/lib/utils";

import { getActiveTenant, getGraphTokenForAccount } from "../../auth/msal-auth";
import { auditLog } from "../../services/audit-log";
import {
  addEmailMethod,
  addPhoneMethod,
  canManageMfa,
  createTemporaryAccessPass,
  findUserByUpnOrMail,
  getMyDirectoryRoles,
  getSignInPreferences,
  listAuthMethods,
  resetMfa,
  SELF_TARGET,
  TAP_MAX_LIFETIME_MINUTES,
  TAP_MIN_LIFETIME_MINUTES,
  userTarget,
  type AuthMethodTarget,
  type MfaResetResult,
  type PhoneAuthType,
  type SignInPreferences,
  type TemporaryAccessPass,
  type UserAuthMethod,
} from "../../services/graph-service";
import {
  buildOtpAuthUri,
  computeTotp,
  formatSecretForDisplay,
  generateOathSecret,
} from "../../services/totp";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import type { AzureLoginAccount } from "../../store/store-types";

import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton } from "../shared/copy-button";
import { PageHeader } from "../shared/page-header";
import {
  describeAuthMethodsError,
  methodIcon,
  PHONE_TYPE_OPTIONS,
  PREFERRED_METHOD_LABELS,
  tapUsabilityTone,
} from "./mfa-manager-helpers";

// ===========================================================================
// Shared types
// ===========================================================================

/** Everything the methods manager needs to act against a single principal. */
interface TargetCtx {
  tenantId: string;
  target: AuthMethodTarget;
  /** Mint a fresh Graph token for the acting account. */
  getToken: () => Promise<string>;
  /** Display name of the principal being managed. */
  label: string;
  /** UPN / username of the principal being managed (audit target). */
  upn: string;
  /** The signed-in account performing the action (audit actor). */
  actor: string;
}

/** The active account's resolved home tenant for self-service operations. */
function selfTenantId(account: AzureLoginAccount): string {
  return (
    getActiveTenant(account.homeAccountId) ??
    account.activeTenantId ??
    account.tenantId
  );
}

// ===========================================================================
// Capability probe — does the acting account hold an MFA-management role?
// ===========================================================================

type CapState = "checking" | "capable" | "incapable" | "unknown";

function useMfaCapability(
  homeAccountId: string | null,
  tenantId: string | null,
): CapState {
  const [state, setState] = React.useState<CapState>("unknown");
  React.useEffect(() => {
    if (!homeAccountId || !tenantId) {
      setState("unknown");
      return;
    }
    let cancelled = false;
    setState("checking");
    void (async () => {
      try {
        const token = await getGraphTokenForAccount(homeAccountId, tenantId);
        const roles = await getMyDirectoryRoles(tenantId, token);
        if (cancelled) return;
        setState(canManageMfa(roles) ? "capable" : "incapable");
      } catch {
        if (!cancelled) setState("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [homeAccountId, tenantId]);
  return state;
}

// ===========================================================================
// AuthMethodsManager — the reusable per-principal panel
// ===========================================================================

type BusyOp =
  | null
  | "loading"
  | "reset"
  | "addPhone"
  | "addEmail"
  | "tap";

interface AuthMethodsManagerProps {
  ctx: TargetCtx;
  /** Capability of the acting account (gates a warning, never blocks). */
  capability: CapState;
}

const AuthMethodsManager: React.FC<AuthMethodsManagerProps> = ({
  ctx,
  capability,
}) => {
  const store = useMultiRegionStore();

  const [methods, setMethods] = React.useState<UserAuthMethod[] | null>(null);
  const [prefs, setPrefs] = React.useState<SignInPreferences | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<BusyOp>(null);
  const [opError, setOpError] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [revokeSessions, setRevokeSessions] = React.useState(true);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [resetResult, setResetResult] = React.useState<MfaResetResult | null>(
    null,
  );

  // Registration form state.
  const [phoneNumber, setPhoneNumber] = React.useState("");
  const [phoneType, setPhoneType] = React.useState<PhoneAuthType>("mobile");
  const [emailAddress, setEmailAddress] = React.useState("");

  // Temporary Access Pass form + result.
  const [tapLifetime, setTapLifetime] = React.useState("60");
  const [tapUsableOnce, setTapUsableOnce] = React.useState(false);
  const [tap, setTap] = React.useState<TemporaryAccessPass | null>(null);

  const targetKey =
    ctx.target.kind === "me" ? `me:${ctx.tenantId}` : ctx.target.userId;

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setBusy("loading");
      setLoadError(null);
      try {
        const token = await ctx.getToken();
        if (signal?.aborted) return;
        const [list, signInPrefs] = await Promise.all([
          listAuthMethods(ctx.tenantId, ctx.target, token, { signal }),
          // Preferences are best-effort context — a failure here must not
          // blank the method list.
          getSignInPreferences(ctx.tenantId, ctx.target, token, {
            signal,
          }).catch(() => null),
        ]);
        if (signal?.aborted) return;
        setMethods(list);
        setPrefs(signInPrefs);
        setSelectedIds(
          new Set(list.filter((m) => m.removable).map((m) => m.id)),
        );
      } catch (err) {
        if (signal?.aborted) return;
        setLoadError(describeAuthMethodsError(err, ctx.label));
        setMethods(null);
      } finally {
        if (!signal?.aborted) setBusy(null);
      }
    },
    // ctx is rebuilt per render; targetKey captures the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetKey, ctx.tenantId],
  );

  React.useEffect(() => {
    const ac = new AbortController();
    setResetResult(null);
    setOpError(null);
    setTap(null);
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const removable = React.useMemo(
    () => (methods ?? []).filter((m) => m.removable),
    [methods],
  );
  const nonRemovable = React.useMemo(
    () => (methods ?? []).filter((m) => !m.removable),
    [methods],
  );
  const selectedRemovable = React.useMemo(
    () => removable.filter((m) => selectedIds.has(m.id)),
    [removable, selectedIds],
  );

  const toggle = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const audit = React.useCallback(
    (
      action: string,
      status: "success" | "failure",
      details: Record<string, unknown>,
      error?: string,
    ) => {
      auditLog.record({
        actor: ctx.actor,
        action,
        target: ctx.upn,
        status,
        error,
        details: { tenantId: ctx.tenantId, ...details },
      });
    },
    [ctx.actor, ctx.upn, ctx.tenantId],
  );

  const notify = React.useCallback(
    (type: "success" | "info" | "error", message: string) =>
      store.addNotification({ type, message }),
    [store],
  );

  // -- Reset ---------------------------------------------------------------
  const handleReset = React.useCallback(async () => {
    if (selectedRemovable.length === 0 && !revokeSessions) return;
    setConfirmReset(false);
    setBusy("reset");
    setOpError(null);
    setResetResult(null);
    try {
      const token = await ctx.getToken();
      const res = await resetMfa(ctx.tenantId, ctx.target, token, {
        methods: selectedRemovable,
        revokeSessions,
      });
      setResetResult(res);
      const ok = res.failed.length === 0;
      notify(
        ok ? "success" : res.deleted.length > 0 ? "info" : "error",
        ok
          ? `Reset MFA for ${ctx.label}: ${res.deleted.length} ${pluralize(
              res.deleted.length,
              "method",
            )} removed${res.sessionsRevoked ? ", sessions revoked" : ""}.`
          : `MFA reset for ${ctx.label} finished with ${res.failed.length} ${pluralize(
              res.failed.length,
              "failure",
            )}.`,
      );
      audit("reset_mfa", ok ? "success" : "failure", {
        deleted: res.deleted.map((m) => m.kind),
        failed: res.failed.map((f) => ({ kind: f.method.kind, error: f.error })),
        skipped: res.skipped.map((m) => m.kind),
        revokeSessions,
        sessionsRevoked: res.sessionsRevoked,
        self: ctx.target.kind === "me",
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOpError(msg);
      audit("reset_mfa", "failure", { revokeSessions }, msg);
    } finally {
      setBusy(null);
    }
  }, [selectedRemovable, revokeSessions, ctx, notify, audit, load]);

  // -- Register phone ------------------------------------------------------
  const handleAddPhone = React.useCallback(async () => {
    setBusy("addPhone");
    setOpError(null);
    try {
      const token = await ctx.getToken();
      const created = await addPhoneMethod(
        ctx.tenantId,
        ctx.target,
        { phoneNumber, phoneType },
        token,
      );
      notify("success", `Registered ${created.kind} for ${ctx.label}.`);
      audit("add_mfa_method", "success", {
        kind: created.kind,
        methodType: "phone",
        phoneType,
        self: ctx.target.kind === "me",
      });
      setPhoneNumber("");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOpError(msg);
      audit("add_mfa_method", "failure", { methodType: "phone", phoneType }, msg);
    } finally {
      setBusy(null);
    }
  }, [ctx, phoneNumber, phoneType, notify, audit, load]);

  // -- Register email ------------------------------------------------------
  const handleAddEmail = React.useCallback(async () => {
    setBusy("addEmail");
    setOpError(null);
    try {
      const token = await ctx.getToken();
      const created = await addEmailMethod(
        ctx.tenantId,
        ctx.target,
        { emailAddress },
        token,
      );
      notify("success", `Registered email method for ${ctx.label}.`);
      audit("add_mfa_method", "success", {
        kind: created.kind,
        methodType: "email",
        self: ctx.target.kind === "me",
      });
      setEmailAddress("");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOpError(msg);
      audit("add_mfa_method", "failure", { methodType: "email" }, msg);
    } finally {
      setBusy(null);
    }
  }, [ctx, emailAddress, notify, audit, load]);

  // -- Issue Temporary Access Pass ----------------------------------------
  const handleIssueTap = React.useCallback(async () => {
    const lifetime = Number(tapLifetime);
    setBusy("tap");
    setOpError(null);
    setTap(null);
    try {
      const token = await ctx.getToken();
      const created = await createTemporaryAccessPass(
        ctx.tenantId,
        ctx.target,
        token,
        { lifetimeInMinutes: lifetime, isUsableOnce: tapUsableOnce },
      );
      setTap(created);
      notify(
        "success",
        `Issued a Temporary Access Pass for ${ctx.label} (valid ${created.lifetimeInMinutes} min).`,
      );
      audit("issue_tap", "success", {
        lifetimeInMinutes: created.lifetimeInMinutes,
        isUsableOnce: created.isUsableOnce,
        isUsable: created.isUsable,
        methodUsabilityReason: created.methodUsabilityReason,
        self: ctx.target.kind === "me",
        // NB: never log the pass value itself.
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOpError(msg);
      audit("issue_tap", "failure", { lifetimeInMinutes: lifetime }, msg);
    } finally {
      setBusy(null);
    }
  }, [ctx, tapLifetime, tapUsableOnce, notify, audit, load]);

  const lifetimeValid =
    Number.isInteger(Number(tapLifetime)) &&
    Number(tapLifetime) >= TAP_MIN_LIFETIME_MINUTES &&
    Number(tapLifetime) <= TAP_MAX_LIFETIME_MINUTES;

  const preferred =
    prefs?.userPreferredMethodForSecondaryAuthentication ?? null;

  return (
    <div className="flex flex-col gap-4">
      {capability === "incapable" && (
        <Alert variant="warning" className="py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-2xs">
            The acting account doesn&apos;t appear to hold Authentication
            Administrator or Privileged Authentication Administrator in this
            tenant. Reading methods may still work, but registers / resets will
            be rejected by Graph with 403 unless it does.
          </AlertDescription>
        </Alert>
      )}

      {loadError && (
        <Alert variant="destructive" className="py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="whitespace-pre-wrap text-2xs">
            {loadError}
          </AlertDescription>
        </Alert>
      )}

      {/* ---- Registered methods + reset -------------------------------- */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-foreground">
            Registered methods{" "}
            {methods && (
              <span className="text-muted-foreground">({methods.length})</span>
            )}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-2xs"
            onClick={() => void load()}
            disabled={busy !== null}
          >
            <RefreshCcw
              className={cn("h-3.5 w-3.5", busy === "loading" && "animate-spin")}
              aria-hidden
            />
            Refresh
          </Button>
        </div>

        {busy === "loading" && methods === null ? (
          <p className="flex items-center gap-2 py-3 text-2xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Loading authentication methods…
          </p>
        ) : methods && methods.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-2xs text-muted-foreground">
            No authentication methods registered.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {(methods ?? []).map((m) => {
              const Icon = methodIcon(m.odataType);
              const checked = selectedIds.has(m.id);
              return (
                <li
                  key={m.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
                >
                  {m.removable ? (
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(m.id)}
                      aria-label={`Select ${m.kind} for removal`}
                    />
                  ) : (
                    <span className="inline-block w-4" aria-hidden />
                  )}
                  <Icon
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="text-2xs font-medium text-foreground">
                    {m.kind}
                  </span>
                  {m.detail && (
                    <span className="truncate font-mono text-2xs text-muted-foreground">
                      {m.detail}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    {!m.removable && (
                      <Badge variant="info" className="text-[10px]">
                        retained
                      </Badge>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {nonRemovable.length > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Retained methods (password, FIDO2/passkey, Windows Hello, hardware
            OATH, …) have no per-type delete endpoint and are never touched by a
            reset.
          </p>
        )}

        {methods && removable.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-base px-3 py-2">
            <label className="flex items-center gap-2 text-2xs text-foreground">
              <Switch
                checked={revokeSessions}
                onCheckedChange={setRevokeSessions}
                aria-label="Revoke active sign-in sessions after reset"
              />
              Revoke active sessions after reset
            </label>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="ml-auto h-8 gap-1.5"
              onClick={() => setConfirmReset(true)}
              disabled={
                busy !== null ||
                (selectedRemovable.length === 0 && !revokeSessions)
              }
            >
              {busy === "reset" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              )}
              Reset {selectedRemovable.length > 0
                ? `${selectedRemovable.length} ${pluralize(
                    selectedRemovable.length,
                    "method",
                  )}`
                : "(sessions only)"}
            </Button>
          </div>
        )}

        {resetResult && (
          <p className="text-2xs text-muted-foreground">
            Removed {resetResult.deleted.length}; failed{" "}
            {resetResult.failed.length}; skipped {resetResult.skipped.length}
            {resetResult.sessionsRevoked ? "; sessions revoked" : ""}.
          </p>
        )}

        {preferred && (
          <p className="text-[10px] text-muted-foreground">
            User-preferred second factor:{" "}
            <span className="text-foreground">
              {PREFERRED_METHOD_LABELS[preferred] ?? preferred}
            </span>
            . Graph blocks deleting the default until it&apos;s reassigned.
          </p>
        )}
      </section>

      <Separator />

      {/* ---- Register a method ----------------------------------------- */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold text-foreground">
          Register a method
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Phone */}
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
            <Label className="flex items-center gap-1.5 text-2xs">
              <Smartphone className="h-3.5 w-3.5" aria-hidden /> Phone (SMS /
              voice)
            </Label>
            <Input
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+1 2065551234"
              className="h-8 text-2xs"
              inputMode="tel"
            />
            <Select
              value={phoneType}
              onValueChange={(v) => setPhoneType(v as PhoneAuthType)}
            >
              <SelectTrigger className="h-8 text-2xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PHONE_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-2xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              onClick={() => void handleAddPhone()}
              disabled={busy !== null || phoneNumber.trim().length === 0}
            >
              {busy === "addPhone" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Smartphone className="h-3.5 w-3.5" aria-hidden />
              )}
              Add phone
            </Button>
          </div>

          {/* Email */}
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
            <Label className="flex items-center gap-1.5 text-2xs">
              <Mail className="h-3.5 w-3.5" aria-hidden /> Email (SSPR /
              recovery)
            </Label>
            <Input
              value={emailAddress}
              onChange={(e) => setEmailAddress(e.target.value)}
              placeholder="recovery@example.com"
              className="h-8 text-2xs"
              inputMode="email"
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-auto h-8 gap-1.5"
              onClick={() => void handleAddEmail()}
              disabled={busy !== null || emailAddress.trim().length === 0}
            >
              {busy === "addEmail" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Mail className="h-3.5 w-3.5" aria-hidden />
              )}
              Add email
            </Button>
          </div>
        </div>
      </section>

      <Separator />

      {/* ---- Temporary Access Pass ------------------------------------- */}
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Timer className="h-3.5 w-3.5" aria-hidden /> Temporary Access Pass
        </h3>
        <p className="text-[10px] text-muted-foreground">
          A time-bound passcode that satisfies MFA and can bootstrap passwordless
          / re-register other methods. A principal holds only one usable pass at
          a time — issuing a new one replaces the previous.
        </p>
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-2.5">
          <div className="flex flex-col gap-1">
            <Label className="text-2xs">Lifetime (minutes)</Label>
            <Input
              value={tapLifetime}
              onChange={(e) => setTapLifetime(e.target.value)}
              className={cn(
                "h-8 w-28 text-2xs",
                !lifetimeValid && "border-destructive",
              )}
              inputMode="numeric"
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-2xs text-foreground">
            <Switch
              checked={tapUsableOnce}
              onCheckedChange={setTapUsableOnce}
              aria-label="One-time use"
            />
            One-time use
          </label>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="ml-auto h-8 gap-1.5"
            onClick={() => void handleIssueTap()}
            disabled={busy !== null || !lifetimeValid}
          >
            {busy === "tap" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Timer className="h-3.5 w-3.5" aria-hidden />
            )}
            Issue pass
          </Button>
        </div>

        {tap && (
          <div className="flex flex-col gap-1.5 rounded-md border border-success/40 bg-success/10 p-3">
            <div className="flex items-center gap-2">
              <span className="text-2xs font-semibold text-foreground">
                Temporary Access Pass
              </span>
              <Badge
                variant={tapUsabilityTone(
                  tap.methodUsabilityReason,
                  tap.isUsable,
                )}
                className="text-[10px]"
              >
                {tap.isUsable ? "usable now" : tap.methodUsabilityReason ?? "not usable"}
              </Badge>
              <span className="ml-auto text-[10px] text-muted-foreground">
                valid {tap.lifetimeInMinutes} min
                {tap.isUsableOnce ? " · one-time" : ""}
              </span>
            </div>
            <div className="group/copy flex items-center gap-2">
              <code className="select-all rounded bg-background px-2 py-1 font-mono text-sm tracking-widest text-foreground">
                {tap.temporaryAccessPass}
              </code>
              <CopyButton
                value={tap.temporaryAccessPass}
                ariaLabel="Copy Temporary Access Pass"
                alwaysVisible
                iconSize={14}
              />
            </div>
            <p className="flex items-center gap-1 text-[10px] text-warning">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              Shown once — copy it now. Graph hides the value on subsequent
              reads.
            </p>
          </div>
        )}
      </section>

      {opError && (
        <Alert variant="destructive" className="py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="whitespace-pre-wrap text-2xs">
            {opError}
          </AlertDescription>
        </Alert>
      )}

      <ConfirmationDialog
        hidden={!confirmReset}
        danger
        title={`Reset MFA for ${ctx.label}?`}
        confirmText="Reset MFA"
        loading={busy === "reset"}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void handleReset()}
        message={
          <div className="flex flex-col gap-1.5 text-xs">
            <span>
              This removes{" "}
              <strong>
                {selectedRemovable.length}{" "}
                {pluralize(selectedRemovable.length, "authentication method")}
              </strong>{" "}
              ({selectedRemovable.map((m) => m.kind).join(", ") || "none"}) so{" "}
              {ctx.label} must re-register at next sign-in.
            </span>
            <span>
              {revokeSessions
                ? "Active sessions will be revoked, forcing immediate re-auth."
                : "Active sessions are left intact."}{" "}
              The password is never affected.
            </span>
          </div>
        }
      />
    </div>
  );
};

// ===========================================================================
// Tab 1 — Signed-in accounts (self-service)
// ===========================================================================

const SelfAccountCard: React.FC<{ account: AzureLoginAccount }> = ({
  account,
}) => {
  const [open, setOpen] = React.useState(false);
  const tenantId = selfTenantId(account);
  const capability = useMfaCapability(
    open ? account.homeAccountId : null,
    open ? tenantId : null,
  );

  const ctx = React.useMemo<TargetCtx>(
    () => ({
      tenantId,
      target: SELF_TARGET,
      getToken: () => getGraphTokenForAccount(account.homeAccountId, tenantId),
      label: account.name || account.username,
      upn: account.username,
      actor: account.username,
    }),
    [account.homeAccountId, account.name, account.username, tenantId],
  );

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <User className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-foreground">
            {account.name || account.username}
          </span>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {account.username}
          </span>
        </span>
        {account.signedOut && (
          <Badge variant="warning" className="ml-auto text-[10px]">
            signed out
          </Badge>
        )}
      </button>
      {open && (
        <div className="border-t border-border px-3 py-3">
          {account.signedOut ? (
            <Alert variant="warning" className="py-2">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-2xs">
                This account&apos;s session is stale. Re-authenticate it from
                Azure Accounts before managing its methods.
              </AlertDescription>
            </Alert>
          ) : (
            <AuthMethodsManager ctx={ctx} capability={capability} />
          )}
        </div>
      )}
    </div>
  );
};

const SignedInAccountsTab: React.FC = () => {
  const state = useMultiRegionState();
  const accounts = state.azureAccounts ?? [];

  return (
    <div className="flex flex-col gap-3">
      <Alert className="py-2">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-2xs">
          Manage MFA for each account signed into this app via{" "}
          <code className="font-mono">/me/authentication</code>. Reading your own
          methods needs only <code>UserAuthenticationMethod.Read</code>;
          registering or resetting them still requires an Authentication
          Administrator role in the account&apos;s tenant.
        </AlertDescription>
      </Alert>
      {accounts.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No accounts are signed in. Add one from the Azure Accounts page.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {accounts.map((a) => (
            <SelfAccountCard key={a.homeAccountId} account={a} />
          ))}
        </div>
      )}
    </div>
  );
};

// ===========================================================================
// Tab 2 — Target user
// ===========================================================================

interface ResolvedTarget {
  ctx: TargetCtx;
  displayName: string;
}

const TargetUserTab: React.FC = () => {
  const state = useMultiRegionState();
  const accounts = (state.azureAccounts ?? []).filter((a) => !a.signedOut);

  const [accountId, setAccountId] = React.useState<string>(
    accounts[0]?.homeAccountId ?? "",
  );
  const [query, setQuery] = React.useState("");
  const [resolving, setResolving] = React.useState(false);
  const [resolveError, setResolveError] = React.useState<string | null>(null);
  const [resolved, setResolved] = React.useState<ResolvedTarget | null>(null);

  const account = accounts.find((a) => a.homeAccountId === accountId) ?? null;
  const tenantId = account ? selfTenantId(account) : null;
  const capability = useMfaCapability(account?.homeAccountId ?? null, tenantId);

  const handleResolve = React.useCallback(async () => {
    if (!account || !tenantId) return;
    const value = query.trim();
    if (!value) return;
    setResolving(true);
    setResolveError(null);
    setResolved(null);
    try {
      const token = await getGraphTokenForAccount(
        account.homeAccountId,
        tenantId,
      );
      const user = await findUserByUpnOrMail(tenantId, value, token);
      if (!user || !user.id) {
        setResolveError(`No user found matching "${value}" in this tenant.`);
        return;
      }
      setResolved({
        displayName: user.displayName,
        ctx: {
          tenantId,
          target: userTarget(user.id),
          getToken: () =>
            getGraphTokenForAccount(account.homeAccountId, tenantId),
          label: user.displayName || user.upn,
          upn: user.upn,
          actor: account.username,
        },
      });
    } catch (err) {
      setResolveError(describeAuthMethodsError(err, value));
    } finally {
      setResolving(false);
    }
  }, [account, tenantId, query]);

  return (
    <div className="flex flex-col gap-3">
      <Alert className="py-2">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-2xs">
          Pick a signed-in admin account, then resolve a user by UPN or object
          id to manage <em>their</em> methods (
          <code className="font-mono">/users/&#123;id&#125;/authentication</code>
          ). Requires Authentication / Privileged Authentication Administrator.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3">
        <div className="flex min-w-[12rem] flex-col gap-1">
          <Label className="text-2xs">Acting account</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="h-8 text-2xs">
              <SelectValue placeholder="Select an account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem
                  key={a.homeAccountId}
                  value={a.homeAccountId}
                  className="text-2xs"
                >
                  {a.username}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <Label className="text-2xs">Target user (UPN or object id)</Label>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleResolve();
            }}
            placeholder="user@contoso.com"
            className="h-8 text-2xs"
          />
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => void handleResolve()}
          disabled={resolving || !account || query.trim().length === 0}
        >
          {resolving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <User className="h-3.5 w-3.5" aria-hidden />
          )}
          Load methods
        </Button>
      </div>

      {resolveError && (
        <Alert variant="destructive" className="py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="whitespace-pre-wrap text-2xs">
            {resolveError}
          </AlertDescription>
        </Alert>
      )}

      {resolved && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
            <span className="text-xs font-semibold text-foreground">
              {resolved.displayName}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {resolved.ctx.upn}
            </span>
          </div>
          <AuthMethodsManager
            key={resolved.ctx.target.kind === "user" ? resolved.ctx.target.userId : "me"}
            ctx={resolved.ctx}
            capability={capability}
          />
        </div>
      )}
    </div>
  );
};

// ===========================================================================
// Tab 3 — OATH seed lab (client-side TOTP)
// ===========================================================================

const OathSeedLab: React.FC = () => {
  const state = useMultiRegionState();
  const firstUpn = state.azureAccounts?.[0]?.username ?? "user@contoso.com";

  const [secret, setSecret] = React.useState<string>(() => generateOathSecret());
  const [accountName, setAccountName] = React.useState(firstUpn);
  const [issuer, setIssuer] = React.useState("AzureBatchManager");
  const [digits, setDigits] = React.useState<6 | 8>(6);
  const [period, setPeriod] = React.useState(30);
  const [live, setLive] = React.useState<{
    code: string;
    secondsRemaining: number;
  } | null>(null);

  const uri = React.useMemo(
    () =>
      buildOtpAuthUri({
        secret,
        accountName: accountName || "user",
        issuer: issuer || "Issuer",
        digits,
        periodSeconds: period,
      }),
    [secret, accountName, issuer, digits, period],
  );

  // Live code — recompute every second. A generation counter guards against a
  // slow async compute landing after the secret/params changed.
  React.useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const result = await computeTotp(secret, {
          digits,
          periodSeconds: period,
        });
        if (active) setLive(result);
      } catch {
        if (active) setLive(null);
      }
    };
    void tick();
    timer = setInterval(() => void tick(), 1000);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [secret, digits, period]);

  const grouped = formatSecretForDisplay(secret);

  return (
    <div className="flex flex-col gap-3">
      <Alert className="py-2">
        <Info className="h-4 w-4" />
        <AlertDescription className="text-2xs">
          Microsoft Graph v1.0 returns a <code>null</code> secret for software
          OATH methods, so a usable TOTP seed can&apos;t be minted server-side.
          This lab generates an RFC-4226/6238 seed in-browser (Web Crypto) for
          provisioning a programmable hardware token or an authenticator via
          manual entry, and shows a live code so you can verify it. Treat the
          seed like a credential — anyone holding it can generate valid codes.
        </AlertDescription>
      </Alert>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Seed + params */}
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <KeyRound className="h-3.5 w-3.5" aria-hidden /> OATH seed
            </h3>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-2xs"
              onClick={() => setSecret(generateOathSecret())}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> New seed
            </Button>
          </div>
          <div className="group/copy flex items-center gap-2">
            <code className="select-all break-all rounded bg-muted/50 px-2 py-1 font-mono text-2xs text-foreground">
              {grouped}
            </code>
            <CopyButton
              value={secret}
              ariaLabel="Copy OATH secret"
              alwaysVisible
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-2xs">Account</Label>
              <Input
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                className="h-8 text-2xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-2xs">Issuer</Label>
              <Input
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                className="h-8 text-2xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-2xs">Digits</Label>
              <Select
                value={String(digits)}
                onValueChange={(v) => setDigits(Number(v) === 8 ? 8 : 6)}
              >
                <SelectTrigger className="h-8 text-2xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="6" className="text-2xs">
                    6
                  </SelectItem>
                  <SelectItem value="8" className="text-2xs">
                    8
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-2xs">Period (s)</Label>
              <Select
                value={String(period)}
                onValueChange={(v) => setPeriod(Number(v) || 30)}
              >
                <SelectTrigger className="h-8 text-2xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30" className="text-2xs">
                    30
                  </SelectItem>
                  <SelectItem value="60" className="text-2xs">
                    60
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-2xs">Provisioning URI (otpauth://)</Label>
            <div className="group/copy flex items-center gap-2">
              <code className="select-all break-all rounded bg-muted/50 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                {uri}
              </code>
              <CopyButton
                value={uri}
                ariaLabel="Copy provisioning URI"
                alwaysVisible
              />
            </div>
          </div>
        </div>

        {/* Live code */}
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card p-4">
          <h3 className="flex items-center gap-1.5 self-start text-xs font-semibold text-foreground">
            <Clock className="h-3.5 w-3.5" aria-hidden /> Live code
          </h3>
          {live ? (
            <>
              <div className="group/copy flex items-center gap-2">
                <span className="font-mono text-4xl font-bold tracking-[0.2em] text-foreground tabular-nums">
                  {live.code}
                </span>
                <CopyButton
                  value={live.code}
                  ariaLabel="Copy current code"
                  alwaysVisible
                  iconSize={16}
                />
              </div>
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
                  style={{
                    width: `${(live.secondsRemaining / period) * 100}%`,
                  }}
                  aria-hidden
                />
              </div>
              <p className="text-2xs text-muted-foreground">
                refreshes in {live.secondsRemaining}s
              </p>
            </>
          ) : (
            <p className="text-2xs text-muted-foreground">computing…</p>
          )}
        </div>
      </div>
    </div>
  );
};

// ===========================================================================
// Page
// ===========================================================================

type TabKey = "self" | "target" | "oath";

export const MfaManagerPage: React.FC = () => {
  const [tab, setTab] = React.useState<TabKey>("self");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="MFA Manager"
        description="Register, reset, and bootstrap Entra ID authentication methods for your signed-in accounts or a target user — plus a self-contained OATH (TOTP) seed lab."
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="self" className="gap-1.5">
            <Users className="h-3.5 w-3.5" aria-hidden /> Signed-in accounts
          </TabsTrigger>
          <TabsTrigger value="target" className="gap-1.5">
            <User className="h-3.5 w-3.5" aria-hidden /> Target user
          </TabsTrigger>
          <TabsTrigger value="oath" className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> OATH seed lab
          </TabsTrigger>
        </TabsList>
        <TabsContent value="self">
          <SignedInAccountsTab />
        </TabsContent>
        <TabsContent value="target">
          <TargetUserTab />
        </TabsContent>
        <TabsContent value="oath">
          <OathSeedLab />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default MfaManagerPage;
