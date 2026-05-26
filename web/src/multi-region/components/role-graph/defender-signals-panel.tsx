/**
 * Defender-signals panel for the Role Assignment Visualizer.
 *
 * Renders the four corpus-derived signals as expandable cards inside the
 * role-graph page. Strictly presentation — every detector lives in
 * `role-graph-helpers.ts` and the page itself owns the supplementary Graph
 * reads (this component never fetches).
 *
 * Corpus citations:
 *   - C:\Users\baimgprodsesa1\Desktop\New folder\_AZURE_BYPASS_PLAYBOOK.md
 *       "Critical Defender Audit Surface" items 4-5
 *       Top-30 escalation chains items 23, 24, 25, 26
 *   - C:\Users\baimgprodsesa1\Desktop\New folder\_bypass_role_grant.md
 *       §3.5 (App Admin → existing app)
 *       §4.1/§4.2 (addPassword / addKey)
 *       §5.1/§5.3 (role-assignable groups + group ownership)
 *       §8.1 (custom role with hidden privesc actions)
 *
 * Defensive analogs to cite in tooltips:
 *   - SpecterOps/AzureHound — role-graph collection
 *   - nccgroup/PMapper, Azucar — custom-role audits
 *   - dafthack/GraphRunner — application-credentials enumeration
 *
 * NOTE: this is a defender-only surface — it shows risk indicators read out
 * of operator-tenant data the user can already see. It never invokes any of
 * the offensive primitives the citations describe; the page never POSTs an
 * `addKey`, `addPassword`, role assignment, or owner add.
 */
import * as React from "react";
import {
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  Key,
  KeyRound,
  Layers,
  Network,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserX,
  Users,
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
import { cn, pluralize } from "@/lib/utils";

import { CopyButton } from "../shared/copy-button";

import {
  SIGNAL_SEVERITY_META,
  type AppAdminEscalationFinding,
  type CredentialSurfaceFinding,
  type CustomRolePrivescFinding,
  type DefenderSignalCounts,
  type RoleAssignableGroupFinding,
  type SignalSeverity,
} from "./role-graph-helpers";

export interface DefenderSignalsPanelProps {
  /** Signal A — derived from the existing probe data (no extra fetch). */
  customRoleFindings: CustomRolePrivescFinding[];
  /** Signal B — present when the page has fetched role-assignable groups. */
  roleAssignableGroupFindings: RoleAssignableGroupFinding[] | null;
  /** True while Signal B Graph fetch is in flight. */
  roleAssignableGroupsLoading: boolean;
  /** Optional load-on-demand callback for Signal B. */
  onLoadRoleAssignableGroups?: () => void;
  /** Warning(s) collected while fetching Signal B. */
  roleAssignableGroupsWarning?: string | null;
  /** Signal C — present when the page has fetched App Admin + high-priv SPs. */
  appAdminFindings: AppAdminEscalationFinding[] | null;
  appAdminLoading: boolean;
  onLoadAppAdmin?: () => void;
  appAdminWarning?: string | null;
  /** Signal D — present when the page has fetched SP credential metadata. */
  credentialSurfaceFindings: CredentialSurfaceFinding[] | null;
  credentialSurfaceLoading: boolean;
  onLoadCredentialSurface?: () => void;
  credentialSurfaceWarning?: string | null;
  /** Pre-computed counts (drives the score badge). */
  counts: DefenderSignalCounts;
  /** Risk-score from `computeDefenderSignalScore`. */
  score: number;
  scoreLabel: string;
}

const SEVERITY_ICON: Record<SignalSeverity, React.FC<{ className?: string }>> = {
  critical: ShieldAlert,
  high: AlertTriangle,
  medium: Info,
  info: ShieldCheck,
};

const SeverityBadge: React.FC<{ severity: SignalSeverity }> = ({
  severity,
}) => {
  const meta = SIGNAL_SEVERITY_META[severity];
  const Icon = SEVERITY_ICON[severity];
  return (
    <Badge variant={meta.badgeVariant} className="text-2xs">
      <Icon className="mr-1 h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
};

/** Inline disclosure section — accessible, no third-party UI primitives. */
const SectionCard: React.FC<{
  title: string;
  description: string;
  icon: React.FC<{ className?: string }>;
  /** Cited corpus path for hover tooltip on the title. */
  corpusCitation: string;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({
  title,
  description,
  icon: Icon,
  corpusCitation,
  defaultOpen,
  badge,
  children,
}) => {
  const [open, setOpen] = React.useState(!!defaultOpen);
  const bodyId = React.useId();
  return (
    <Card>
      <CardHeader className="cursor-pointer py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="group flex w-full items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {open ? (
            <ChevronDown
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <ChevronRight
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <Icon
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <CardTitle className="flex items-center gap-2 text-sm">
              <span className="truncate" title={`Corpus: ${corpusCitation}`}>
                {title}
              </span>
              {badge}
            </CardTitle>
            <CardDescription className="text-xs">{description}</CardDescription>
          </div>
        </button>
      </CardHeader>
      {open && (
        <CardContent id={bodyId} className="flex flex-col gap-2 pt-0">
          {children}
        </CardContent>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Signal A — custom-role privesc finder
// ---------------------------------------------------------------------------

const CustomRoleFindingRow: React.FC<{ f: CustomRolePrivescFinding }> = ({
  f,
}) => {
  return (
    <li
      className={cn(
        "flex flex-col gap-1 rounded border p-2 text-2xs",
        f.severity === "critical" && "border-destructive/40 bg-destructive/5",
        f.severity === "high" && "border-warning/40 bg-warning/5",
        f.severity === "medium" && "border-secondary/40 bg-muted/30",
        f.severity === "info" && "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={f.severity} />
        <span className="font-medium" title={f.roleDefinitionId}>
          {f.roleName}
        </span>
        <CopyButton
          value={f.roleDefinitionId}
          ariaLabel={`Copy role definition id ${f.roleDefinitionId}`}
        />
        <Badge variant="outline" className="text-2xs">
          {f.subscriptionDisplayName}
        </Badge>
        <Badge variant="secondary" className="text-2xs">
          {f.assignmentCount}{" "}
          {f.assignmentCount === 1 ? "assignment" : "assignments"}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
          Privesc actions
        </span>
        {f.matchedActions.map((a) => (
          <code
            key={a}
            className="rounded bg-muted/60 px-1 py-0.5 font-mono text-2xs"
          >
            {a}
          </code>
        ))}
      </div>
      {f.holders.length > 0 && (
        <details className="rounded border border-border/60 bg-background/40 p-1.5">
          <summary className="cursor-pointer text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Holders ({f.holders.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {f.holders.slice(0, 10).map((h) => (
              <li key={h.principalId} className="flex items-center gap-1.5">
                <span className="truncate font-medium">{h.displayName}</span>
                <Badge variant="outline" className="text-2xs">
                  {h.principalType}
                </Badge>
                {h.isGuest && (
                  <Badge variant="warning" className="text-2xs">
                    <UserX className="mr-1 h-3 w-3" aria-hidden />
                    Guest
                  </Badge>
                )}
                {h.isNonTierZero && (
                  <Badge variant="destructive" className="text-2xs">
                    Non-Tier-0
                  </Badge>
                )}
                <span
                  className="ml-auto font-mono text-3xs opacity-60"
                  title={h.principalId}
                >
                  {h.principalId.substring(0, 8)}…
                </span>
              </li>
            ))}
            {f.holders.length > 10 && (
              <li className="italic text-muted-foreground/80">
                … and {f.holders.length - 10} more
              </li>
            )}
          </ul>
        </details>
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// Signal B — role-assignable groups + owners
// ---------------------------------------------------------------------------

const RoleAssignableGroupRow: React.FC<{ f: RoleAssignableGroupFinding }> = ({
  f,
}) => {
  return (
    <li
      className={cn(
        "flex flex-col gap-1 rounded border p-2 text-2xs",
        f.severity === "critical" && "border-destructive/40 bg-destructive/5",
        f.severity === "high" && "border-warning/40 bg-warning/5",
        f.severity === "medium" && "border-secondary/40 bg-muted/30",
        f.severity === "info" && "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={f.severity} />
        <Users className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium" title={f.groupId}>
          {f.displayName}
        </span>
        <CopyButton
          value={f.groupId}
          ariaLabel={`Copy group id ${f.groupId}`}
        />
        {f.groupHighestTier && (
          <Badge variant="outline" className="text-2xs">
            Holds: {f.groupHighestTier}
          </Badge>
        )}
        <Badge variant="secondary" className="text-2xs">
          {f.ownerCount} {f.ownerCount === 1 ? "owner" : "owners"}
        </Badge>
        {f.hasNonTierZeroOwner && (
          <Badge variant="destructive" className="text-2xs">
            Non-Tier-0 owner
          </Badge>
        )}
      </div>
      {f.groupRoles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Currently holds
          </span>
          {f.groupRoles.slice(0, 5).map((r) => (
            <Badge key={r} variant="outline" className="text-2xs">
              {r}
            </Badge>
          ))}
          {f.groupRoles.length > 5 && (
            <span className="text-3xs italic text-muted-foreground/80">
              +{f.groupRoles.length - 5}
            </span>
          )}
        </div>
      )}
      {f.sampleOwners.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Owners
          </span>
          {f.sampleOwners.map((o) => (
            <Badge key={o.id} variant="outline" className="text-2xs" title={o.id}>
              {o.displayName}
              {o.isGuest && (
                <UserX className="ml-1 h-3 w-3 text-warning" aria-hidden />
              )}
            </Badge>
          ))}
          {f.ownerCount > f.sampleOwners.length && (
            <span className="text-3xs italic text-muted-foreground/80">
              +{f.ownerCount - f.sampleOwners.length}
            </span>
          )}
        </div>
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// Signal C — App Admin escalation panel
// ---------------------------------------------------------------------------

const AppAdminFindingRow: React.FC<{ f: AppAdminEscalationFinding }> = ({
  f,
}) => {
  return (
    <li
      className={cn(
        "flex flex-col gap-1 rounded border p-2 text-2xs",
        f.severity === "critical" && "border-destructive/40 bg-destructive/5",
        f.severity === "high" && "border-warning/40 bg-warning/5",
        f.severity === "medium" && "border-secondary/40 bg-muted/30",
        f.severity === "info" && "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={f.severity} />
        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium" title={f.principalId}>
          {f.displayName}
        </span>
        <CopyButton
          value={f.principalId}
          ariaLabel={`Copy principal id ${f.principalId}`}
        />
        <Badge variant="outline" className="text-2xs">
          {f.principalType}
        </Badge>
        <Badge variant="destructive" className="text-2xs">
          {f.roleName}
        </Badge>
        {f.isGuest && (
          <Badge variant="warning" className="text-2xs">
            <UserX className="mr-1 h-3 w-3" aria-hidden />
            Guest
          </Badge>
        )}
        <Badge variant="secondary" className="text-2xs">
          {f.reachableSpCount}{" "}
          {pluralize(f.reachableSpCount, "reachable high-priv SP")}
        </Badge>
      </div>
      {f.topReachableScope && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Top reachable scope
          </span>
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-2xs">
            {f.topReachableScope}
          </code>
        </div>
      )}
      {f.sampleSpNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Sample SPs
          </span>
          {f.sampleSpNames.map((n) => (
            <Badge key={n} variant="outline" className="text-2xs">
              {n}
            </Badge>
          ))}
        </div>
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// Signal D — credential surface
// ---------------------------------------------------------------------------

const CredentialSurfaceRow: React.FC<{ f: CredentialSurfaceFinding }> = ({
  f,
}) => {
  const totalCreds = f.passwordCredentialCount + f.keyCredentialCount;
  return (
    <li
      className={cn(
        "flex flex-col gap-1 rounded border p-2 text-2xs",
        f.severity === "critical" && "border-destructive/40 bg-destructive/5",
        f.severity === "high" && "border-warning/40 bg-warning/5",
        f.severity === "medium" && "border-secondary/40 bg-muted/30",
        f.severity === "info" && "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={f.severity} />
        <Key className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium" title={f.spId}>
          {f.displayName}
        </span>
        <CopyButton value={f.spId} ariaLabel={`Copy SP id ${f.spId}`} />
        {f.isHighPriv && (
          <Badge variant="destructive" className="text-2xs">
            High-priv SP
          </Badge>
        )}
        {f.isRecent && (
          <Badge variant="warning" className="text-2xs">
            Recent credential
          </Badge>
        )}
        <Badge variant="outline" className="text-2xs">
          {f.passwordCredentialCount} pwd
        </Badge>
        <Badge variant="outline" className="text-2xs">
          {f.keyCredentialCount} key
        </Badge>
        <Badge variant="secondary" className="text-2xs">
          {totalCreds} total
        </Badge>
      </div>
      {f.daysSinceNewestCredential !== undefined && (
        <div className="flex flex-wrap items-center gap-1 text-3xs text-muted-foreground">
          Newest credential minted {f.daysSinceNewestCredential}{" "}
          {pluralize(f.daysSinceNewestCredential, "day")} ago.
          {f.isRecent && (
            <span className="ml-1 font-medium text-warning">
              Within recency window — verify intent.
            </span>
          )}
        </div>
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// Panel root
// ---------------------------------------------------------------------------

export const DefenderSignalsPanel: React.FC<DefenderSignalsPanelProps> = (
  props,
) => {
  const {
    customRoleFindings,
    roleAssignableGroupFindings,
    roleAssignableGroupsLoading,
    onLoadRoleAssignableGroups,
    roleAssignableGroupsWarning,
    appAdminFindings,
    appAdminLoading,
    onLoadAppAdmin,
    appAdminWarning,
    credentialSurfaceFindings,
    credentialSurfaceLoading,
    onLoadCredentialSurface,
    credentialSurfaceWarning,
    counts,
    score,
    scoreLabel,
  } = props;

  // Pre-compute headline counts for the section badges so they render even
  // when the section is collapsed.
  const aCritical = counts.customRolePrivescCritical;
  const aHigh = counts.customRolePrivescHigh;
  const bCritical = counts.roleAssignableGroupCritical;
  const bHigh = counts.roleAssignableGroupHigh;
  const cCritical = counts.appAdminEscalationCritical;
  const cHigh = counts.appAdminEscalationHigh;
  const dCritical = counts.credentialSurfaceCritical;
  const dHigh = counts.credentialSurfaceHigh;

  return (
    <div
      className="flex flex-col gap-2"
      role="region"
      aria-label="Defender signals from offensive-tooling corpus"
    >
      {/* Headline summary with risk score */}
      <Alert
        variant={score >= 60 ? "destructive" : undefined}
        className={cn(
          score >= 30 && score < 60 && "border-warning/40 bg-warning/5",
        )}
      >
        <Sparkles className="h-4 w-4" />
        <AlertTitle className="flex items-center gap-2 text-sm">
          Defender signals — {scoreLabel} ({score}/100)
        </AlertTitle>
        <AlertDescription className="text-2xs">
          Risk indicators wired from the offensive-tooling corpus
          (<code className="font-mono">_bypass_role_grant.md</code> + Top-30
          privesc chains). Read-only — no offensive primitives invoked.
        </AlertDescription>
      </Alert>

      {/* ---------- Signal A — custom-role privesc finder ---------- */}
      <SectionCard
        title="Custom roles with hidden roleAssignments/write"
        description="Custom RBAC roles whose actions[] contains an escalation wildcard. Holder of such a role can grant any role to anyone at scope."
        icon={Layers}
        corpusCitation="_bypass_role_grant.md §8.1 + _AZURE_BYPASS_PLAYBOOK.md #25"
        defaultOpen={aCritical > 0 || aHigh > 0}
        badge={
          <>
            {aCritical > 0 && (
              <Badge variant="destructive" className="text-2xs">
                {aCritical} critical
              </Badge>
            )}
            {aHigh > 0 && (
              <Badge variant="warning" className="text-2xs">
                {aHigh} high
              </Badge>
            )}
            {aCritical === 0 && aHigh === 0 && (
              <Badge variant="outline" className="text-2xs">
                Clean
              </Badge>
            )}
          </>
        }
      >
        {customRoleFindings.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            No custom roles in the audited subscriptions hold one of the
            roleAssignments/write privesc wildcards.
            <br />
            <span className="opacity-70">
              Defensive analog: SpecterOps/AzureHound + nccgroup/PMapper run
              the same custom-role action audit during their ingest.
            </span>
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {customRoleFindings.map((f) => (
              <CustomRoleFindingRow
                key={`${f.subscriptionId}-${f.roleDefinitionId}`}
                f={f}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      {/* ---------- Signal B — role-assignable group owners ---------- */}
      <SectionCard
        title="Role-assignable groups + their owners"
        description="Group owners inherit the group's directory role transitively, with no role-grant audit event firing."
        icon={Users}
        corpusCitation="_bypass_role_grant.md §5.1 + §5.3 + _AZURE_BYPASS_PLAYBOOK.md #26"
        defaultOpen={bCritical > 0 || bHigh > 0}
        badge={
          <>
            {bCritical > 0 && (
              <Badge variant="destructive" className="text-2xs">
                {bCritical} critical
              </Badge>
            )}
            {bHigh > 0 && (
              <Badge variant="warning" className="text-2xs">
                {bHigh} high
              </Badge>
            )}
            {roleAssignableGroupFindings === null && (
              <Badge variant="outline" className="text-2xs">
                Not loaded
              </Badge>
            )}
            {roleAssignableGroupFindings !== null &&
              bCritical === 0 &&
              bHigh === 0 && (
                <Badge variant="outline" className="text-2xs">
                  Clean
                </Badge>
              )}
          </>
        }
      >
        {roleAssignableGroupFindings === null ? (
          <div className="flex flex-col gap-2">
            <p className="text-2xs text-muted-foreground">
              Click to enumerate role-assignable groups
              (<code className="font-mono">isAssignableToRole eq true</code>)
              and resolve their owners. Read-only Graph reads:
              <br />
              <code className="font-mono">
                GET /v1.0/groups?$filter=isAssignableToRole eq true
              </code>
              <br />
              <code className="font-mono">
                GET /v1.0/groups/&#123;id&#125;/owners
              </code>
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onLoadRoleAssignableGroups}
              disabled={!onLoadRoleAssignableGroups || roleAssignableGroupsLoading}
              className="self-start text-2xs"
            >
              {roleAssignableGroupsLoading
                ? "Enumerating…"
                : "Enumerate role-assignable groups"}
            </Button>
          </div>
        ) : roleAssignableGroupFindings.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            No role-assignable groups discovered (or insufficient Graph
            permission to enumerate them).
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {roleAssignableGroupFindings.map((f) => (
              <RoleAssignableGroupRow key={f.groupId} f={f} />
            ))}
          </ul>
        )}
        {roleAssignableGroupsWarning && (
          <Alert variant="destructive" className="mt-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription className="text-2xs">
              {roleAssignableGroupsWarning}
            </AlertDescription>
          </Alert>
        )}
      </SectionCard>

      {/* ---------- Signal C — App Admin escalation panel ---------- */}
      <SectionCard
        title="Application Administrator → addKey chain"
        description="Holders of Application Administrator can plant credentials on any app, including apps with admin-tier Graph permissions — a stealth path to GA-equivalent."
        icon={Network}
        corpusCitation="_bypass_role_grant.md §3.5 + _AZURE_BYPASS_PLAYBOOK.md #23, #24"
        defaultOpen={cCritical > 0 || cHigh > 0}
        badge={
          <>
            {cCritical > 0 && (
              <Badge variant="destructive" className="text-2xs">
                {cCritical} critical
              </Badge>
            )}
            {cHigh > 0 && (
              <Badge variant="warning" className="text-2xs">
                {cHigh} high
              </Badge>
            )}
            {appAdminFindings === null && (
              <Badge variant="outline" className="text-2xs">
                Not loaded
              </Badge>
            )}
            {appAdminFindings !== null && cCritical === 0 && cHigh === 0 && (
              <Badge variant="outline" className="text-2xs">
                Clean
              </Badge>
            )}
          </>
        }
      >
        {appAdminFindings === null ? (
          <div className="flex flex-col gap-2">
            <p className="text-2xs text-muted-foreground">
              Click to enumerate Application Administrator + Cloud Application
              Administrator holders and cross-product them with SPs holding
              admin-tier Graph permissions
              (<code className="font-mono">
                RoleManagement.ReadWrite.Directory
              </code>{" "}
              et al). Read-only Graph reads.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onLoadAppAdmin}
              disabled={!onLoadAppAdmin || appAdminLoading}
              className="self-start text-2xs"
            >
              {appAdminLoading
                ? "Enumerating…"
                : "Enumerate App Admin escalation paths"}
            </Button>
          </div>
        ) : appAdminFindings.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            No Application Administrator / Cloud Application Administrator
            holders detected (or insufficient permission to enumerate
            directoryRoles).
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {appAdminFindings.map((f) => (
              <AppAdminFindingRow key={f.principalId} f={f} />
            ))}
          </ul>
        )}
        {appAdminWarning && (
          <Alert variant="destructive" className="mt-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription className="text-2xs">
              {appAdminWarning}
            </AlertDescription>
          </Alert>
        )}
        <p className="text-3xs italic text-muted-foreground">
          Defensive analog: dafthack/GraphRunner enumerates this chain via
          <code className="ml-1 font-mono">Invoke-GraphAppRoleEnum</code>.
        </p>
      </SectionCard>

      {/* ---------- Signal D — credential surface ---------- */}
      <SectionCard
        title="SP credential surface (addPassword / addKey)"
        description="Recently-minted credentials on service principals — the canonical persistence + privesc primitive."
        icon={Box}
        corpusCitation="_bypass_role_grant.md §4.1, §4.2 + _AZURE_BYPASS_PLAYBOOK.md Defender Audit #5"
        defaultOpen={dCritical > 0 || dHigh > 0}
        badge={
          <>
            {dCritical > 0 && (
              <Badge variant="destructive" className="text-2xs">
                {dCritical} critical
              </Badge>
            )}
            {dHigh > 0 && (
              <Badge variant="warning" className="text-2xs">
                {dHigh} high
              </Badge>
            )}
            {credentialSurfaceFindings === null && (
              <Badge variant="outline" className="text-2xs">
                Not loaded
              </Badge>
            )}
            {credentialSurfaceFindings !== null &&
              dCritical === 0 &&
              dHigh === 0 && (
                <Badge variant="outline" className="text-2xs">
                  Clean
                </Badge>
              )}
          </>
        }
      >
        {credentialSurfaceFindings === null ? (
          <div className="flex flex-col gap-2">
            <p className="text-2xs text-muted-foreground">
              Click to enumerate credential metadata
              (<code className="font-mono">passwordCredentials.length</code>,{" "}
              <code className="font-mono">keyCredentials.length</code>, newest{" "}
              <code className="font-mono">startDateTime</code>) for SPs that
              appear as role-assignment principals AND for SPs holding
              admin-tier Graph permissions. Recency window: 7 days.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onLoadCredentialSurface}
              disabled={!onLoadCredentialSurface || credentialSurfaceLoading}
              className="self-start text-2xs"
            >
              {credentialSurfaceLoading
                ? "Enumerating…"
                : "Enumerate SP credential surface"}
            </Button>
            <p className="text-3xs italic text-muted-foreground">
              {/* COORDINATOR: needs baseline snapshot to diff — without one we
                  can only detect within-recency-window credentials. A future
                  baseline service would let us flag CHANGED credentials,
                  matching the corpus "Defender Audit Surface" item 5
                  more closely. */}
              Note: without a baseline snapshot helper, only credentials minted
              within the 7-day recency window are flagged. Baseline-diff
              detection is a future enhancement.
            </p>
          </div>
        ) : credentialSurfaceFindings.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            No SP credentials returned (or insufficient permission to read
            <code className="ml-1 font-mono">applications</code> /{" "}
            <code className="font-mono">servicePrincipals</code>).
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {credentialSurfaceFindings.map((f) => (
              <CredentialSurfaceRow key={f.spId} f={f} />
            ))}
          </ul>
        )}
        {credentialSurfaceWarning && (
          <Alert variant="destructive" className="mt-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription className="text-2xs">
              {credentialSurfaceWarning}
            </AlertDescription>
          </Alert>
        )}
      </SectionCard>

      <p className="text-3xs italic text-muted-foreground">
        All findings are READ-ONLY risk indicators against the operator's own
        tenant. The page never invokes role-grant, addKey/addPassword, or
        consent primitives. Citations:{" "}
        <code className="font-mono">_bypass_role_grant.md</code>,{" "}
        <code className="font-mono">_AZURE_BYPASS_PLAYBOOK.md</code>.{" "}
        <ExternalLink className="inline h-2.5 w-2.5 opacity-60" aria-hidden />
      </p>
    </div>
  );
};
