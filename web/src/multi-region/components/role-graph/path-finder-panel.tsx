/**
 * Multi-hop path-finder visualizer for the Role Assignment Visualizer.
 *
 * Renders the BFS results from `findShortestPath` and the
 * transitive-ownership-chain findings from `detectOwnershipChains` as
 * hop-by-hop chips so the operator can see EVERY edge they have to revoke
 * to break the chain — not just the leaf principal.
 *
 * Corpus citations (mirrored from `role-graph-helpers.ts`):
 *   - `_bypass_role_grant.md` §5.3 group ownership = membership management
 *   - `_bypass_role_grant.md` §5.4 nested groups
 *   - `_bypass_role_grant.md` §10  role-graph privesc chain reference
 *   - `_analysis_specterops.md`    AzureHound shortestPath queries
 *
 * No I/O — every input is precomputed in the page or in the helper module.
 */
import * as React from "react";
import {
  ArrowRight,
  Boxes,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Key,
  Layers,
  Network,
  Route,
  Shield,
  Target,
  User,
  Users,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { CopyButton } from "../shared/copy-button";

import {
  PRIVILEGE_TIER_META,
  SIGNAL_SEVERITY_META,
  type FoundPath,
  type OwnershipChainFinding,
  type PathHop,
  type PrivilegeTier,
} from "./role-graph-helpers";

export interface PathFinderPanelProps {
  /** Whether the path finder is "armed" (the operator typed at least one hint). */
  armed: boolean;
  /** BFS-derived shortest paths. */
  paths: FoundPath[];
  /** Transitive-ownership chains (one-off detector, always-on). */
  ownershipChains: OwnershipChainFinding[];
  /** Optional notice for when the result set was capped. */
  totalMatched: number;
  /** Click handler for "focus this principal in the tree". */
  onFocusPrincipal?: (principalId: string) => void;
  /** Click handler for "filter to this group's members". */
  onFocusGroup?: (groupId: string) => void;
  /** Toggle expansion of the panel itself. */
  defaultOpen?: boolean;
}

/** Map a hop kind to an icon. */
const HOP_ICON: Record<PathHop["kind"], React.ElementType> = {
  principal: User,
  group: Users,
  role: Key,
  scope: Boxes,
};

/** Color a hop chip by kind. */
function hopChipClass(kind: PathHop["kind"], tier?: PrivilegeTier): string {
  if (kind === "role") {
    if (tier === "critical") return "border-destructive/50 bg-destructive/10 text-destructive";
    if (tier === "privileged") return "border-warning/50 bg-warning/10 text-warning";
    if (tier === "write") return "border-secondary/50 bg-muted/40";
    return "border-border bg-card";
  }
  if (kind === "principal") return "border-primary/40 bg-primary/5";
  if (kind === "group") return "border-amber-500/40 bg-amber-500/5";
  if (kind === "scope") return "border-blue-500/40 bg-blue-500/5";
  return "border-border bg-card";
}

const HopChip: React.FC<{
  hop: PathHop;
  onClick?: () => void;
  /** Whether this is the LAST hop in a row (affects the connecting arrow). */
  isLast?: boolean;
}> = ({ hop, onClick, isLast }) => {
  const Icon = HOP_ICON[hop.kind];
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={cn(
          "inline-flex max-w-[260px] items-center gap-1 rounded border px-1.5 py-1 text-2xs",
          hopChipClass(hop.kind, hop.tier),
          onClick &&
            "cursor-pointer hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !onClick && "cursor-default",
        )}
        title={hop.detail ? `${hop.label} — ${hop.detail}` : hop.label}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate font-medium">{hop.label}</span>
        {hop.kind === "role" && hop.tier && (
          <Badge
            variant={PRIVILEGE_TIER_META[hop.tier].badgeVariant}
            className="ml-1 text-3xs"
          >
            {PRIVILEGE_TIER_META[hop.tier].label}
          </Badge>
        )}
        {hop.detail && hop.kind === "group" && (
          <span className="ml-1 rounded bg-muted px-1 text-3xs opacity-80">
            {hop.detail}
          </span>
        )}
      </button>
      {!isLast && (
        <ArrowRight
          className="h-3 w-3 shrink-0 text-muted-foreground"
          aria-hidden
        />
      )}
    </>
  );
};

const PathRow: React.FC<{
  path: FoundPath;
  onFocusPrincipal?: (id: string) => void;
  onFocusGroup?: (id: string) => void;
}> = ({ path, onFocusPrincipal, onFocusGroup }) => {
  const meta = PRIVILEGE_TIER_META[path.highestTier];
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded border p-2 text-2xs",
        path.highestTier === "critical" &&
          "border-destructive/40 bg-destructive/5",
        path.highestTier === "privileged" && "border-warning/40 bg-warning/5",
        path.highestTier === "write" && "border-secondary/40 bg-muted/30",
        path.highestTier === "readonly" && "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={meta.badgeVariant} className="text-2xs">
          {meta.label}
        </Badge>
        <Badge variant="outline" className="text-2xs">
          {path.hopCount} {path.hopCount === 1 ? "hop" : "hops"}
        </Badge>
        {path.viaGroup && (
          <Badge variant="warning" className="text-2xs">
            <Users className="mr-1 h-3 w-3" aria-hidden />
            via group
          </Badge>
        )}
        {path.viaNestedGroup && (
          <Badge variant="destructive" className="text-2xs">
            <GitBranch className="mr-1 h-3 w-3" aria-hidden />
            nested group
          </Badge>
        )}
      </div>
      <div
        className="flex flex-wrap items-center gap-1"
        role="list"
        aria-label="Hop sequence"
      >
        {path.hops.map((hop, i) => {
          const isLast = i === path.hops.length - 1;
          const handler =
            hop.kind === "principal" && onFocusPrincipal
              ? () => onFocusPrincipal(hop.id)
              : hop.kind === "group" && onFocusGroup
                ? () => onFocusGroup(hop.id)
                : undefined;
          return (
            <HopChip
              key={`${hop.kind}-${hop.id}-${i}`}
              hop={hop}
              onClick={handler}
              isLast={isLast}
            />
          );
        })}
      </div>
    </li>
  );
};

const OwnershipChainRow: React.FC<{
  f: OwnershipChainFinding;
  onFocusPrincipal?: (id: string) => void;
  onFocusGroup?: (id: string) => void;
}> = ({ f, onFocusPrincipal, onFocusGroup }) => {
  const sevMeta = SIGNAL_SEVERITY_META[f.severity];
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded border p-2 text-2xs",
        f.severity === "critical" && "border-destructive/40 bg-destructive/5",
        f.severity === "high" && "border-warning/40 bg-warning/5",
        f.severity === "medium" && "border-secondary/40 bg-muted/30",
        f.severity === "info" && "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={sevMeta.badgeVariant} className="text-2xs">
          {sevMeta.label}
        </Badge>
        <Route className="h-3 w-3 text-muted-foreground" aria-hidden />
        <span className="font-medium" title={f.ownerId}>
          {f.ownerDisplayName}
        </span>
        <Badge variant="outline" className="text-2xs">
          {f.ownerType}
        </Badge>
        {f.isGuest && (
          <Badge variant="warning" className="text-2xs">
            Guest
          </Badge>
        )}
        <Badge variant="secondary" className="text-2xs">
          owns {f.rootGroupDisplayName}
        </Badge>
        {f.intermediateGroupIds.length > 0 && (
          <Badge variant="destructive" className="text-2xs">
            <GitBranch className="mr-1 h-3 w-3" aria-hidden />
            +{f.intermediateGroupIds.length} nested
          </Badge>
        )}
        <Badge variant={PRIVILEGE_TIER_META[f.terminalTier].badgeVariant} className="text-2xs">
          {f.terminalTier}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <HopChip
          hop={{
            kind: "principal",
            id: f.ownerId,
            label: f.ownerDisplayName,
            principalType: f.ownerType,
          }}
          onClick={onFocusPrincipal ? () => onFocusPrincipal(f.ownerId) : undefined}
        />
        <HopChip
          hop={{
            kind: "group",
            id: f.rootGroupId,
            label: f.rootGroupDisplayName,
            detail: "owned",
          }}
          onClick={onFocusGroup ? () => onFocusGroup(f.rootGroupId) : undefined}
        />
        {f.intermediateGroupIds.map((gid) => (
          <HopChip
            key={gid}
            hop={{
              kind: "group",
              id: gid,
              label: `Group ${gid.substring(0, 8)}…`,
              detail: "nested",
            }}
            onClick={onFocusGroup ? () => onFocusGroup(gid) : undefined}
          />
        ))}
        <HopChip
          hop={{
            kind: "group",
            id: f.terminalGroupId,
            label: f.terminalGroupDisplayName,
            detail: "holds role",
          }}
          onClick={onFocusGroup ? () => onFocusGroup(f.terminalGroupId) : undefined}
          isLast
        />
      </div>
      {f.terminalRoles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Inherited roles
          </span>
          {f.terminalRoles.slice(0, 5).map((r) => (
            <Badge key={r} variant="outline" className="text-2xs">
              {r}
            </Badge>
          ))}
          {f.terminalRoles.length > 5 && (
            <span className="text-3xs italic text-muted-foreground/80">
              +{f.terminalRoles.length - 5}
            </span>
          )}
        </div>
      )}
      <p className="text-3xs italic text-muted-foreground">
        Revoke the cheapest edge to break the chain — usually the ownership
        of <span className="font-mono">{f.rootGroupDisplayName}</span>{" "}
        (one PATCH against the group's owners). Citation:
        <code className="ml-1 font-mono">_bypass_role_grant.md §5.3</code>.
      </p>
      <CopyButton
        value={f.ownerId}
        ariaLabel={`Copy owner principal id ${f.ownerId}`}
        className="self-start"
      />
    </li>
  );
};

/**
 * Root component — renders the BFS path list AND the transitive-ownership
 * detector findings as two sub-sections inside one collapsible card.
 *
 * Renders aria-live so screen readers announce when the path count updates.
 */
export const PathFinderPanel: React.FC<PathFinderPanelProps> = (props) => {
  const {
    armed,
    paths,
    ownershipChains,
    totalMatched,
    onFocusPrincipal,
    onFocusGroup,
    defaultOpen = true,
  } = props;
  const [open, setOpen] = React.useState(defaultOpen);
  const bodyId = React.useId();
  // aria-live announcement — debounced via key so screen readers update.
  const announceText = armed
    ? `Path finder: ${paths.length} ${paths.length === 1 ? "path" : "paths"} discovered, ${ownershipChains.length} ownership ${ownershipChains.length === 1 ? "chain" : "chains"} flagged.`
    : "";
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
          <Target
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <CardTitle
              className="flex items-center gap-2 text-sm"
              title="Corpus: _bypass_role_grant.md §5.3, §5.4, §10 + _analysis_specterops.md"
            >
              <span>Path finder &amp; ownership chains</span>
              {armed && paths.length > 0 && (
                <Badge variant="secondary" className="text-2xs">
                  {paths.length} {paths.length === 1 ? "path" : "paths"}
                </Badge>
              )}
              {ownershipChains.length > 0 && (
                <Badge variant="destructive" className="text-2xs">
                  {ownershipChains.length} ownership{" "}
                  {ownershipChains.length === 1 ? "chain" : "chains"}
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              BFS shortest-path traversal (principal → group → role → scope)
              and transitive ownership detection. Citations:{" "}
              <code className="font-mono">_bypass_role_grant.md</code> §5.3,
              §5.4.
            </CardDescription>
          </div>
        </button>
      </CardHeader>
      {open && (
        <CardContent
          id={bodyId}
          className="flex flex-col gap-3 pt-0"
        >
          {/* aria-live region — empty/visually hidden, just for SR updates */}
          <div className="sr-only" aria-live="polite" role="status">
            {announceText}
          </div>

          {/* BFS paths section */}
          <div className="flex flex-col gap-1">
            <h3 className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
              <Network className="h-3 w-3" aria-hidden />
              BFS paths
              {totalMatched > paths.length && (
                <span className="ml-1 italic opacity-80">
                  (showing {paths.length} of {totalMatched})
                </span>
              )}
            </h3>
            {!armed ? (
              <p className="text-2xs text-muted-foreground">
                Type a principal name (or scope substring) above to run a
                shortest-path traversal. Hops are drawn from a BFS over the
                principal → group → role → scope graph, hop budget 5.
              </p>
            ) : paths.length === 0 ? (
              <Alert>
                <AlertDescription className="text-2xs">
                  No paths found for the current hints. Either the principal
                  has no role-assignment path under the matched scope, or
                  group membership wasn't enumerable for this audit.
                </AlertDescription>
              </Alert>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {paths.map((p, i) => (
                  <PathRow
                    key={`${p.hops.map((h) => h.id).join(">")}-${i}`}
                    path={p}
                    onFocusPrincipal={onFocusPrincipal}
                    onFocusGroup={onFocusGroup}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* Ownership chains section */}
          <div className="flex flex-col gap-1">
            <h3 className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
              <Layers className="h-3 w-3" aria-hidden />
              Transitive ownership chains
              <Badge variant="outline" className="text-3xs">
                _bypass_role_grant.md §5.3 + §5.4
              </Badge>
            </h3>
            {ownershipChains.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                No transitive ownership chains detected (or role-assignable
                groups + transitive members haven't been enumerated yet —
                run Signal B and the probe above).
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {ownershipChains.map((f) => (
                  <OwnershipChainRow
                    key={`${f.ownerId}-${f.terminalGroupId}`}
                    f={f}
                    onFocusPrincipal={onFocusPrincipal}
                    onFocusGroup={onFocusGroup}
                  />
                ))}
              </ul>
            )}
          </div>

          <p className="text-3xs italic text-muted-foreground">
            <Shield className="mr-1 inline h-3 w-3 opacity-60" aria-hidden />
            Read-only traversal of the operator's tenant. No POSTs are issued.
            Defensive analog: SpecterOps/AzureHound{" "}
            <code className="font-mono">MATCH p=shortestPath(...)</code>{" "}
            Cypher queries.
          </p>
        </CardContent>
      )}
    </Card>
  );
};
