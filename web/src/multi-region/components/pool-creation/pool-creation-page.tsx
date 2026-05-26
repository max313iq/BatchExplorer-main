/**
 * Pool Creation page — guides the operator through a stepper workflow
 * (Target -> Image -> Scale -> Networking -> Tasks -> Review) and submits
 * a multi-account pool create through the orchestrator.
 *
 * Does NOT host the global pool-defaults editor — that lives on the
 * `/pool-defaults` page; this page only consumes them and offers an opt-in
 * "save as default" hook on submit.
 */
import * as React from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Cpu,
  Download,
  Eraser,
  FileCode,
  FileJson,
  Image as ImageIcon,
  Keyboard,
  Layers,
  Lightbulb,
  Loader2,
  Lock,
  Network,
  Plus,
  RotateCw,
  Save,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
  ClipboardCheck,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsContent,
} from "@/components/ui/tabs";
import { AnimatedTabs } from "@/components/ui/effects";
import { cn } from "@/lib/utils";

import { MonacoEditor } from "@azure/bonito-ui/lib/components";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import {
  buildPoolConfigFromDefaults,
  PoolDefaults,
} from "../../store/pool-defaults";
import {
  DataTable,
  DataTableColumn,
} from "../shared/enhanced-table";
import { EmptyState } from "../shared/empty-state";
import { getAllVmSizes, getVmSizeInfo } from "../shared/vm-sizes";
import { LiveVmSizeSelect } from "../vm-catalog/live-vm-size-select";
import { useLiveCatalogAvailable } from "../vm-catalog/use-live-catalog-available";
import { ErrorBoundary } from "../shared/error-boundary";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { PageHeader } from "../shared/page-header";
import { TokenExpiryBadge } from "../shared/token-expiry-badge";
import { CopyButton, CopyableText } from "../shared/copy-button";
import { InfoTooltip } from "../shared/info-tooltip";
import { SummaryStatItem } from "../shared/summary-stat-item";
import { useUrlState } from "../../hooks/use-url-state";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useShortcut } from "../../hooks/use-shortcut";
import { useArmToken } from "../../auth/use-arm-token";
import { auditLog } from "../../services/audit-log";
import {
  cachePeek,
  invalidateQuotaCache,
  subscribeQuotaCache,
  vmSkusCacheKey,
  ComputeVmSku,
} from "../../services/quota-service";

// ---- Constants -----------------------------------------------------------

// Azure Batch pool ID: 1-64 chars, alphanumeric, hyphen, underscore.
const POOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const POOL_ID_ERROR_ID = "pool-id-error";
const POOL_JSON_ERROR_ID = "pool-json-error";
const SUBNET_ID_PATTERN =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/;
// POSIX env-var name: must start with letter/underscore, then alnum/underscore.
// Used by BOTH the inline env-var Name input and the .env paste parser — keep
// them in sync so a name that's invalid via paste is also invalid via type.
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// localStorage key for the saved-templates feature (last 5 successful configs).
const POOL_TEMPLATES_KEY = "pool-creation:templates:v1";
const POOL_TEMPLATES_MAX = 5;

type StepKey =
  | "target"
  | "image"
  | "scale"
  | "networking"
  | "tasks"
  | "review";

interface StepDescriptor {
  key: StepKey;
  label: string;
  icon: React.ElementType;
}

const STEPS: readonly StepDescriptor[] = [
  { key: "target", label: "Target", icon: Server },
  { key: "image", label: "Image", icon: ImageIcon },
  { key: "scale", label: "Scale", icon: Layers },
  { key: "networking", label: "Networking", icon: Network },
  { key: "tasks", label: "Tasks", icon: Terminal },
  { key: "review", label: "Review", icon: ClipboardCheck },
] as const;

const DEFAULT_POOL_CONFIG = {
  id: "pool",
  vmSize: "standard_nd40rs_v2",
  virtualMachineConfiguration: {
    nodeAgentSKUId: "batch.node.ubuntu 22.04",
    imageReference: {
      publisher: "canonical",
      offer: "0001-com-ubuntu-server-jammy",
      sku: "22_04-lts-gen2",
      version: "latest",
    },
  },
  resizeTimeout: "PT15M",
  targetDedicatedNodes: 0,
  targetLowPriorityNodes: 0,
  taskSlotsPerNode: 1,
  taskSchedulingPolicy: { nodeFillType: "Pack" },
  enableAutoScale: false,
  enableInterNodeCommunication: false,
  startTask: {
    commandLine: '/bin/bash -c "echo Hello"',
    environmentSettings: [],
    maxTaskRetryCount: 3,
    resourceFiles: [],
    userIdentity: {
      autoUser: { scope: "pool", elevationLevel: "admin" },
    },
    waitForSuccess: true,
  },
  certificateReferences: [],
  metadata: [],
  userAccounts: [],
};

// ---- Start-task presets -------------------------------------------------
// One-click templates for the operator. Picked from common GPU-pool warm-up
// patterns we hit during the 2026-05 multi-account dispatches — saves the
// operator from re-typing the same `apt-get update && nvidia-smi` boot
// sequence on every fresh pool definition.

interface StartTaskPreset {
  id: string;
  label: string;
  description: string;
  commandLine: string;
}

const START_TASK_PRESETS: readonly StartTaskPreset[] = [
  {
    id: "hello",
    label: "Hello (smoke test)",
    description: "Minimal echo — verifies the start-task channel works.",
    commandLine: '/bin/bash -c "echo Hello from $(hostname)"',
  },
  {
    id: "nvidia-smi",
    label: "NVIDIA driver check",
    description:
      "Prints driver + GPU inventory. Fails the start-task if the GPU SKU lost its driver.",
    commandLine:
      '/bin/bash -c "nvidia-smi || (echo NO_GPU_DRIVER && exit 1)"',
  },
  {
    id: "apt-update",
    label: "apt-get update + base tools",
    description:
      "Refreshes apt caches and installs git/curl/jq. Common warm-up for Ubuntu pools.",
    commandLine:
      '/bin/bash -c "apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl jq"',
  },
  {
    id: "pip-torch",
    label: "Python + PyTorch (CUDA)",
    description:
      "Installs python3-pip and PyTorch with CUDA 12.1. Long-running on cold nodes.",
    commandLine:
      '/bin/bash -c "apt-get update -y && apt-get install -y python3-pip && pip3 install --upgrade pip && pip3 install torch --index-url https://download.pytorch.org/whl/cu121"',
  },
  {
    id: "docker-warm",
    label: "Docker warm-up",
    description:
      "Pulls a canary image and runs `--gpus all` to validate the docker-GPU bridge.",
    commandLine:
      '/bin/bash -c "docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi"',
  },
];

// ---- env-var paste parser ----------------------------------------------
// Accepts shell-style `NAME=VALUE` lines (one per row), tolerates `export `
// prefixes, comments starting with `#`, blank lines, and surrounding
// single/double quotes around the value. Returns the parsed pairs plus a
// flat list of human-readable warnings for anything that couldn't be
// understood — surfaced in the UI so the operator can see what was dropped.
//
// COORDINATOR: pool-creation has env-paste import behavior — if another page
// adds clipboard→env-var import (e.g. pool-defaults, job creation), the
// `parseEnvPaste` shape + `ENV_NAME_PATTERN` should be promoted to a
// shared util rather than duplicated. Touch this from the per-page agent
// owning that page; do NOT re-implement.

interface EnvParseResult {
  parsed: { name: string; value: string }[];
  warnings: string[];
}

function parseEnvPaste(raw: string): EnvParseResult {
  const out: { name: string; value: string }[] = [];
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) {
      warnings.push(`Line ${i + 1}: missing "=", skipped (${line.slice(0, 40)})`);
      continue;
    }
    const name = line.slice(0, eq).trim();
    if (!ENV_NAME_PATTERN.test(name)) {
      warnings.push(
        `Line ${i + 1}: invalid POSIX env name "${name}", skipped (must start with letter/underscore, then alnum/underscore)`,
      );
      continue;
    }
    let value = line.slice(eq + 1);
    // Strip a single matching pair of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.push({ name, value });
  }
  return { parsed: out, warnings };
}

// ---- Attack-surface analyzer -------------------------------------------
// Corpus-grounded pre-create warning panel. The shape we're trying to
// detect is the classic "compute hijack target" from
// `New folder\_analysis_netspi.md §I (IMDS Variants)`:
//
//   * The Batch node has a managed-identity reachable IMDS endpoint at
//     `169.254.169.254/metadata/identity/oauth2/token` — exactly the
//     `Azure VM` row in the NetSPI IMDS matrix.
//   * If the StartTask runs as autoUser with `elevationLevel: admin`,
//     anything that compromises the start-task shell (apt registries,
//     pip mirrors, Docker registries, GitHub releases) gets root and
//     can read tokens out of IMDS, MSAL caches, and bound storage.
//   * If the pool has public (no-subnet) networking AND outbound
//     internet AND a writable filesystem, the same shape that NetSPI
//     uses to hijack App Service / Functions identities applies one
//     hop down — the attacker uploads a malicious tarball that the
//     start-task fetches, then exfils the IMDS token.
//
// We DON'T block creation — operators are sometimes intentionally
// running unsigned setup. We surface the chain so they SEE it before
// pressing Create. Citations on the panel point at the corpus docs.

interface AttackSurfaceFinding {
  /** Stable key so render passes can keyframe. */
  id: string;
  /** Severity tone — drives Alert variant. */
  severity: "info" | "warning" | "destructive";
  /** Headline (short, scannable). */
  title: string;
  /** Body — why this matters, what the corpus says, how to mitigate. */
  detail: string;
  /** Corpus citation (relative path under `New folder\`). */
  cite: string;
}

interface AttackSurfaceInput {
  subnetId: string;
  startTaskCmd: string;
  elevationLevel: "admin" | "nonadmin";
  envVars: { name: string; value: string }[];
  smartMode: boolean;
  selectedAccountCount: number;
  crossSubDispatch: boolean;
}

// Commands whose presence in the StartTask implies the node will reach
// out to the public internet during boot. The intersection with the
// "no subnet + admin StartTask" shape is the high-risk case.
const OUTBOUND_FETCH_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bapt-get\s+(?:update|install)\b/i,
  /\bapt\s+(?:update|install)\b/i,
  /\byum\s+install\b/i,
  /\bdnf\s+install\b/i,
  /\bpip3?\s+install\b/i,
  /\bnpm\s+(?:install|i)\b/i,
  /\bdocker\s+(?:pull|run)\b/i,
  /\bgit\s+clone\b/i,
  /\bhuggingface-cli\s+download\b/i,
  /\bnvidia-smi\b/i, // benign, but a marker that GPU + outbound is in play
];

// Patterns that write to filesystem with elevated privilege — the
// "blast radius" amplifier. Caught with conservative regex so we
// don't false-positive on legitimate echo into a file (which is fine).
const FS_WRITE_PATTERNS = [
  /\bchmod\s+[+u]\w*[sx]\b/i, // setuid / executable
  /\bchown\s+root\b/i,
  /\bsudo\b/i, // already root in autoUser:admin, but a marker
  /\binstall\s+-D\b/i,
  /\btar\s+(?:-x|xf|xzvf|xzf)\b/i,
  /\bunzip\b/i,
  />\s*\/etc\//i,
  />\s*\/usr\/local\/bin\//i,
];

// Env-var names that hint at credentials being baked into the pool
// definition. Plain-text on the wire AND on the pool resource — a
// secondary leak path. Names match conservatively.
const SECRET_ENV_PATTERNS = [
  /pass(word)?$/i,
  /^aws_secret/i,
  /^azure_client_secret/i,
  /token$/i,
  /^github_token/i,
  /apikey$/i,
  /^openai_api_key/i,
  /^anthropic_api_key/i,
  /^hf_token/i,
  /_secret$/i,
];

function analyzeAttackSurface(
  input: AttackSurfaceInput,
): AttackSurfaceFinding[] {
  const out: AttackSurfaceFinding[] = [];
  const cmd = input.startTaskCmd ?? "";
  const isPublic = input.subnetId.trim().length === 0;
  const isAdmin = input.elevationLevel === "admin";
  const fetches = OUTBOUND_FETCH_PATTERNS.some((p) => p.test(cmd));
  const fsWrite = FS_WRITE_PATTERNS.some((p) => p.test(cmd));

  // 1. Compute-hijack shape: public IP + outbound + admin StartTask.
  if (isPublic && fetches && isAdmin) {
    out.push({
      id: "compute-hijack",
      severity: "destructive",
      title:
        "Compute-hijack shape: public IP + outbound fetch + admin StartTask",
      detail:
        "Pool nodes will boot on the public Batch fleet (no subnet attached), the StartTask will fetch from the internet, and it runs as root. A compromised apt/pip/docker mirror — or a single MITM on the fetch path — yields a root shell with IMDS access. The classic Azure VM IMDS at 169.254.169.254 (Metadata: true header) will mint managed-identity tokens for whatever identity the Batch account has, which AzureHound / MicroBurst then graph into the wider tenant. Mitigations: attach a subnet with a deny-by-default NSG, pin checksums on every fetched artifact, or drop elevation to nonadmin.",
      cite: "_analysis_netspi.md §I (IMDS Variants — Azure VM row)",
    });
  } else if (isPublic && fetches) {
    out.push({
      id: "outbound-public",
      severity: "warning",
      title: "Public networking + outbound fetch in StartTask",
      detail:
        "No subnet attached, so the node uses default public networking. The StartTask reaches out to the internet during boot. A poisoned apt/pip/docker mirror compromises every node in the pool. Consider pinning checksums, mirroring artifacts to a private storage account, or attaching a subnet with controlled egress.",
      cite: "_analysis_netspi.md §I (IMDS Variants)",
    });
  } else if (isAdmin && fsWrite) {
    out.push({
      id: "admin-fs-write",
      severity: "warning",
      title: "StartTask is elevated AND writes outside the task directory",
      detail:
        "elevationLevel=admin combined with chmod/chown/tar/install-D to system paths means a buggy or malicious StartTask leaves persistent state on the node. Even after the pool deallocates and a node is recycled into a new pool, Batch reformats the OS disk — but secrets baked into the start-task script remain in the pool's stored definition. Prefer dropping privileges (nonadmin) or fencing writes to /mnt/batch/tasks/.",
      cite: "_analysis_netspi.md §III (App Service Token Theft — same blast-radius pattern)",
    });
  }

  // 2. Secret-shaped env vars in the pool definition.
  const secretEnvs = input.envVars
    .filter((ev) => ev.name.trim() !== "")
    .filter((ev) =>
      SECRET_ENV_PATTERNS.some((p) => p.test(ev.name.trim())),
    )
    .map((ev) => ev.name);
  if (secretEnvs.length > 0) {
    out.push({
      id: "secret-env",
      severity: "warning",
      title: `${secretEnvs.length} env-var name(s) look like secret(s)`,
      detail:
        `Plain-text env vars on a pool definition are visible to anyone with Reader on the Batch account — they're returned by the pool GET API, the Azure Portal, and pool exports. Names: ${secretEnvs.slice(0, 5).join(", ")}${secretEnvs.length > 5 ? ", …" : ""}. Move these to a Key Vault reference (Batch supports it natively) or fetch at runtime from an identity-bound source.`,
      cite: "_analysis_netspi.md §VI (Key Vault enumeration / Get-AzPasswords)",
    });
  }

  // 3. Cross-sub dispatch advisory.
  if (input.smartMode && input.crossSubDispatch) {
    out.push({
      id: "cross-sub-dispatch",
      severity: "info",
      title: "Cross-subscription dispatch in progress",
      detail:
        "Selected accounts span multiple subscriptions / AAD identities. The orchestrator routes a fresh Batch token per account, but the StartTask above runs identically in every account. Verify the command does not embed sub-specific paths, role assignments, or storage accounts that only exist in one of the targets.",
      cite: "_bypass_tenant_switch.md §multi-tenant token routing",
    });
  }

  // 4. Pool-scale warning: many accounts × many SKUs = many nodes.
  if (input.smartMode && input.selectedAccountCount >= 10) {
    out.push({
      id: "pool-scale",
      severity: "info",
      title: `Large dispatch: ${input.selectedAccountCount} accounts in smart-fill mode`,
      detail:
        "Each account fills its remaining LP quota, so the per-account node count is bounded by quota — but the aggregate fleet you're about to bring up could be thousands of nodes. Every node will run the StartTask above. A bug in the StartTask amplifies across the whole fleet.",
      cite: "(operational guidance — not a corpus citation)",
    });
  }

  return out;
}

// ---- PUT-body preview builder ------------------------------------------
// Mirrors the exact body the submit path constructs in `handleCreate`
// (smart mode), so the operator sees what's actually about to be PUT to
// each Batch account before pressing Create. Two intentional differences
// from `handleCreate`:
//   1. `vmSize` is a placeholder string `"<one of N SKUs>"` since smart
//      mode picks per account at dispatch time.
//   2. `environmentSettings` filters out empty names AND redacts values
//      whose name matches `SECRET_ENV_PATTERNS` — we don't want secrets
//      copy-pasted out of the preview pane.
// The preview also covers Manual JSON mode by passing through the operator's
// JSON verbatim (with the same `targetDedicatedNodes=0` clamp the submit
// path applies).
interface PutPreviewInput {
  smartMode: boolean;
  poolIdInput: string;
  poolConfigJson: string;
  resizeTimeoutMin: number;
  subnetId: string;
  interNodeComm: boolean;
  startTaskCmd: string;
  envVars: { name: string; value: string }[];
  maxRetryCount: number;
  waitForSuccess: boolean;
  poolDefaults: PoolDefaults | undefined;
  smartVmSizes: string[];
  smartVmCount: number;
}

function buildPutBodyPreview(input: PutPreviewInput): {
  body: Record<string, unknown>;
  redactedNames: string[];
} {
  const redactedNames: string[] = [];
  if (!input.smartMode) {
    try {
      const parsed = JSON.parse(input.poolConfigJson) as Record<string, unknown>;
      parsed.targetDedicatedNodes = 0;
      // Redact secret-shaped env vars in the manual JSON preview too.
      const env = (parsed.startTask as { environmentSettings?: unknown })
        ?.environmentSettings;
      if (Array.isArray(env)) {
        const sanitized = env.map((e) => {
          const item = e as { name?: unknown; value?: unknown };
          const name = typeof item.name === "string" ? item.name : "";
          const looksSecret = SECRET_ENV_PATTERNS.some((p) => p.test(name));
          if (looksSecret) redactedNames.push(name);
          return looksSecret
            ? { name, value: "<redacted in preview>" }
            : { name, value: typeof item.value === "string" ? item.value : "" };
        });
        (parsed.startTask as { environmentSettings?: unknown }).environmentSettings =
          sanitized;
      }
      return { body: parsed, redactedNames };
    } catch (e) {
      return {
        body: { _previewError: `Invalid JSON: ${(e as Error).message}` },
        redactedNames: [],
      };
    }
  }

  const vmSizePlaceholder =
    input.smartVmSizes.length > 0
      ? `<one of ${input.smartVmSizes.length} picked SKUs>`
      : `<one of ${input.smartVmCount} default GPU SKUs>`;

  const environmentSettings = input.envVars
    .filter((ev) => ev.name.trim() !== "")
    .map((ev) => {
      const looksSecret = SECRET_ENV_PATTERNS.some((p) => p.test(ev.name));
      if (looksSecret) redactedNames.push(ev.name);
      return {
        name: ev.name,
        value: looksSecret ? "<redacted in preview>" : ev.value,
      };
    });

  let body: Record<string, unknown>;
  if (input.poolDefaults) {
    body = buildPoolConfigFromDefaults(input.poolDefaults, {
      id: input.poolIdInput,
      targetLowPriorityNodes: 0,
      vmSize: vmSizePlaceholder,
    });
    (body as Record<string, unknown>).targetDedicatedNodes = 0;
    (body as Record<string, unknown>).enableAutoScale = false;
  } else {
    body = {
      id: input.poolIdInput,
      vmSize: vmSizePlaceholder,
      virtualMachineConfiguration: {
        nodeAgentSKUId: "batch.node.ubuntu 22.04",
        imageReference: {
          publisher: "canonical",
          offer: "0001-com-ubuntu-server-jammy",
          sku: "22_04-lts-gen2",
          version: "latest",
        },
      },
      resizeTimeout: `PT${input.resizeTimeoutMin}M`,
      targetDedicatedNodes: 0,
      targetLowPriorityNodes: 0,
      taskSlotsPerNode: 1,
      taskSchedulingPolicy: { nodeFillType: "Pack" },
      enableAutoScale: false,
      enableInterNodeCommunication: input.interNodeComm,
      certificateReferences: [],
      metadata: [],
      userAccounts: [],
    };
  }
  body.resizeTimeout = `PT${input.resizeTimeoutMin}M`;
  body.enableInterNodeCommunication = input.interNodeComm;
  if (input.subnetId) {
    body.networkConfiguration = { subnetId: input.subnetId };
  }
  body.startTask = {
    commandLine: input.startTaskCmd,
    environmentSettings,
    maxTaskRetryCount: input.maxRetryCount,
    resourceFiles: [],
    userIdentity: {
      autoUser: {
        scope: "pool",
        elevationLevel: "admin",
      },
    },
    waitForSuccess: input.waitForSuccess,
  };
  return { body, redactedNames };
}

// ---- Validators ----------------------------------------------------------

function validatePoolId(id: unknown): string | null {
  if (typeof id !== "string" || id.length === 0) {
    return "Pool ID is required.";
  }
  if (!POOL_ID_PATTERN.test(id)) {
    return "Pool ID must be 1-64 chars, alphanumeric/underscore/hyphen only.";
  }
  return null;
}

function validateSubnetId(id: string): string | null {
  if (id.length === 0) return null; // optional
  if (!SUBNET_ID_PATTERN.test(id)) {
    return "Subnet must be a full Azure resource ID: /subscriptions/.../subnets/<name>.";
  }
  return null;
}

interface EnvVar {
  name: string;
  value: string;
}

// ---- Saved pool templates -----------------------------------------------
// Persisted in localStorage via usePersistedState so operators can re-use
// a successful configuration without retyping every step. Keeps the last
// POOL_TEMPLATES_MAX entries (newest first). A template is a denormalised
// snapshot of the wizard form — NOT the orchestrator payload — so it
// survives schema changes in the dispatch path.
interface PoolTemplate {
  id: string;
  /** Human label — defaults to poolId at save-time, operator can rename. */
  name: string;
  /** ISO timestamp the template was saved. */
  savedAt: string;
  poolIdPrefix: string;
  osCategory: "linux" | "windows";
  resizeTimeoutMin: number;
  subnetId: string;
  interNodeComm: boolean;
  startTaskCmd: string;
  maxRetryCount: number;
  waitForSuccess: boolean;
  envVars: EnvVar[];
  smartMode: boolean;
  smartVmSizes: string[];
}

type EligibleAccount = {
  id: string;
  accountName: string;
  region: string;
  subscriptionId: string;
  /** Subscription display name (resolved at build-time for sort + filter). */
  subscriptionName: string;
  /** Free low-priority cores (the primary smart-mode capacity input). */
  lowPriorityCoresFree: number;
  /** Free dedicated cores — secondary signal for non-LP pools. */
  dedicatedCoresFree: number;
  /** Pool count currently in the account (capacity is `poolsFree` away from quota). */
  poolCount: number;
  poolQuota: number;
  /** True when accountInfos hasn't reported numbers yet. */
  quotaStale: boolean;
};

interface PoolCreationPageProps {
  orchestrator: OrchestratorAgent;
}

// ---- Eligible-account columns (defined out-of-component for stability) --

function buildAccountColumns(): DataTableColumn<EligibleAccount>[] {
  return [
    {
      id: "accountName",
      header: "Account",
      cell: (row) => (
        <span className="group/copy inline-flex items-center gap-1.5 align-middle">
          <span className="font-medium">{row.accountName}</span>
          <CopyButton
            value={row.accountName}
            ariaLabel={`Copy account name ${row.accountName}`}
          />
        </span>
      ),
      sort: (a, b) => a.accountName.localeCompare(b.accountName),
      csv: (row) => row.accountName,
    },
    {
      id: "region",
      header: "Region",
      cell: (row) => (
        <span className="font-mono text-2xs">{row.region}</span>
      ),
      sort: (a, b) => a.region.localeCompare(b.region),
      csv: (row) => row.region,
    },
    {
      id: "subscription",
      header: "Subscription",
      cell: (row) => (
        <span
          className="block max-w-[14rem] truncate text-xs text-muted-foreground"
          title={row.subscriptionName || row.subscriptionId}
        >
          {row.subscriptionName || row.subscriptionId.slice(0, 8) + "…"}
        </span>
      ),
      sort: (a, b) => a.subscriptionName.localeCompare(b.subscriptionName),
      csv: (row) => row.subscriptionName || row.subscriptionId,
      defaultHidden: true,
    },
    {
      id: "freeLp",
      header: "Free LP cores",
      cell: (row) => {
        if (row.quotaStale) {
          return (
            <span
              className="text-2xs italic text-muted-foreground"
              title="Quota not yet refreshed — click Discover accounts above."
            >
              not loaded
            </span>
          );
        }
        const tone =
          row.lowPriorityCoresFree > 0
            ? "text-success"
            : "text-muted-foreground";
        return (
          <span className={cn("font-mono tabular-nums text-xs", tone)}>
            {row.lowPriorityCoresFree.toLocaleString()}
          </span>
        );
      },
      sort: (a, b) => a.lowPriorityCoresFree - b.lowPriorityCoresFree,
      csv: (row) => (row.quotaStale ? "" : row.lowPriorityCoresFree),
    },
    {
      id: "freeDedicated",
      header: "Free dedicated",
      cell: (row) =>
        row.quotaStale ? (
          <span className="text-2xs italic text-muted-foreground">—</span>
        ) : (
          <span className="font-mono tabular-nums text-xs text-muted-foreground">
            {row.dedicatedCoresFree.toLocaleString()}
          </span>
        ),
      sort: (a, b) => a.dedicatedCoresFree - b.dedicatedCoresFree,
      csv: (row) => (row.quotaStale ? "" : row.dedicatedCoresFree),
      defaultHidden: true,
    },
    {
      id: "pools",
      header: "Pools",
      cell: (row) =>
        row.quotaStale ? (
          <span className="text-2xs italic text-muted-foreground">—</span>
        ) : (
          <span className="font-mono tabular-nums text-xs text-muted-foreground">
            {row.poolCount} / {row.poolQuota || "?"}
          </span>
        ),
      sort: (a, b) => a.poolCount - b.poolCount,
      csv: (row) =>
        row.quotaStale ? "" : `${row.poolCount}/${row.poolQuota || ""}`,
    },
  ];
}

// ---- Component -----------------------------------------------------------

const PoolCreationPageInner: React.FC<PoolCreationPageProps> = ({
  orchestrator,
}) => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const poolDefaults = (state as unknown as Record<string, unknown>)
    .poolDefaults as PoolDefaults | undefined;

  // Page-level ARM-token tracker. Drives the TokenExpiryBadge in the
  // header so the operator gets a visible heads-up before the token
  // flips mid-dispatch — pool creation can run for minutes (smart-mode
  // fan-out across dozens of accounts/VM sizes) and a stale token would
  // surface as an opaque mid-batch 401. We don't bridge this token
  // back into the orchestrator's per-account flow; that path keeps its
  // own per-sub token resolver. This is purely the expiry-awareness UI.
  const primaryAccount = (state.azureAccounts ?? [])[0];
  const armTokenTracker = useArmToken(
    primaryAccount?.homeAccountId,
    primaryAccount?.tenantId,
  );

  // Step state — URL-synced per Contract §3.7 / §4.3.
  const [stepState, setStepState] = useUrlState<{ step: StepKey }>(
    { step: "target" },
    { replace: true },
  );
  const currentStep: StepKey = STEPS.some((s) => s.key === stepState.step)
    ? (stepState.step as StepKey)
    : "target";

  // ---- Form state ----
  const [poolConfigJson, setPoolConfigJson] = React.useState(
    JSON.stringify(DEFAULT_POOL_CONFIG, null, 2),
  );
  const [configError, setConfigError] = React.useState<string | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = React.useState<
    Set<string>
  >(new Set());
  const [isRunning, setIsRunning] = React.useState(false);
  // Discovery progress for the explicit "Discover accounts" button. Mirrors
  // the per-sub flow used by the orchestrator so the operator can see which
  // subs the page is still walking through. `null` ⇒ no discovery in flight.
  const [discoverProgress, setDiscoverProgress] = React.useState<{
    completed: number;
    total: number;
    currentSubId: string | null;
    importedTotal: number;
  } | null>(null);
  const [discoverError, setDiscoverError] = React.useState<string | null>(null);
  const [smartMode, setSmartMode] = React.useState(true);
  // Smart-mode VM SKU set. Empty = "use the live catalog defaults" which
  // expands to the GPU-only catalog (or the hardcoded 5 fallback when
  // the catalog hasn't been populated yet). Non-empty = user override
  // via the LiveVmSizeSelect multi-picker below the smart-mode toggle.
  const [smartVmSizes, setSmartVmSizes] = React.useState<string[]>([]);

  // ---- One-time URL-param hydration (deep-link from Unused Quota) ----
  // The Unused Quota page's "Use in Smart Mode" button navigates here
  // with `?accountIds=...&vmSizes=...&smartMode=on`. We read those
  // params ONCE on mount and pre-fill the Target step + Smart Mode
  // picker. Subsequent edits via the wizard own the state.
  const urlHydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (urlHydratedRef.current) return;
    urlHydratedRef.current = true;
    const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const accountIdsParam = params.get("accountIds");
    if (accountIdsParam) {
      const ids = accountIdsParam.split(",").filter(Boolean);
      if (ids.length > 0) setSelectedAccountIds(new Set(ids));
    }
    const vmSizesParam = params.get("vmSizes");
    if (vmSizesParam) {
      const vms = vmSizesParam.split(",").filter(Boolean);
      if (vms.length > 0) setSmartVmSizes(vms);
    }
    if (params.get("smartMode") === "on") {
      setSmartMode(true);
    } else if (params.get("smartMode") === "off") {
      setSmartMode(false);
    }
  }, []);
  // Master wire-up toggle. Hydrated from user preferences so the choice
  // sticks across reloads. When OFF, the LiveVmSizeSelect picker is
  // hidden, smartVmSizes is treated as empty, and Smart Mode falls
  // through to the hardcoded 5-VM list — the pre-wire UX.
  const [liveCatalogEnabled, setLiveCatalogEnabled] = React.useState<boolean>(
    () => store.getUserPreferences().liveVmCatalogEnabled,
  );
  const toggleLiveCatalog = React.useCallback(
    (next: boolean) => {
      setLiveCatalogEnabled(next);
      store.saveUserPreferences({ liveVmCatalogEnabled: next });
      // When disabling, clear the picker selection so the smart-mode
      // dispatch deterministically falls back to the hardcoded list.
      if (!next) setSmartVmSizes([]);
    },
    [store],
  );
  const [poolIdInput, setPoolIdInput] = React.useState("pool");
  const [poolIdError, setPoolIdError] = React.useState<string | null>(null);
  // Multi-pick subscription filter. When empty, the eligible-accounts
  // table shows every created account across every signed-in sub —
  // operators can then cross-select accounts that span different subs
  // (and even different AAD identities) in a single create_pools_smart
  // dispatch. The per-sub Batch token resolver in pool-agent makes
  // that cross-tenant case actually work.
  const [selectedSubIds, setSelectedSubIds] = React.useState<string[]>([]);
  // Mirror of the FIRST picked sub (or empty when none / many). Used
  // only by call sites that need a single value — live VM-catalog
  // availability check, the per-sub VM-size picker, etc. These call
  // sites are inherently single-sub today; treating them as "primary"
  // is the least-disruptive way to keep them working.
  const subscriptionId =
    selectedSubIds.length > 0 ? selectedSubIds[0] : "";
  // Catalog-availability dependency: the toggle is meaningless when the
  // cache has no data (no SKUs to pick from). Disable the switch in
  // that case and surface a "populate first" hint. Reactive — flips
  // back to enabled the moment the cache fills. Declared AFTER
  // subscriptionId so the hook receives the live state value (not
  // a TDZ-undefined reference — the previous ordering crashed with
  // ReferenceError).
  const catalogAvailability = useLiveCatalogAvailable(
    subscriptionId || undefined,
  );
  // Effective on/off: the user's stored preference AND the catalog
  // actually has data. If the catalog goes empty (TTL expiry, manual
  // invalidate) the picker hides automatically — Smart Mode falls back
  // to the hardcoded list without surprising the user.
  const liveCatalogEffective =
    liveCatalogEnabled && catalogAvailability.available;

  // Catalog freshness — exposed in the UI as a "Last updated: X ago" chip
  // so the operator can spot a stale cache before a dispatch picks the
  // wrong SKU set. Pulls the underlying `fetchedAt` from the quota-service
  // cache item and re-reads on cache pub/sub changes (covers TTL expiry,
  // operator-driven invalidate, vm-catalog page refresh).
  const [catalogFetchedAt, setCatalogFetchedAt] = React.useState<number | null>(
    null,
  );
  React.useEffect(() => {
    if (!subscriptionId) {
      setCatalogFetchedAt(null);
      return;
    }
    const read = () => {
      const all = cachePeek<ComputeVmSku[]>(
        vmSkusCacheKey(subscriptionId, false),
      );
      const gpu = cachePeek<ComputeVmSku[]>(
        vmSkusCacheKey(subscriptionId, true),
      );
      // Prefer whichever is fresher — they're populated independently.
      const fetched = Math.max(all?.fetchedAt ?? 0, gpu?.fetchedAt ?? 0);
      setCatalogFetchedAt(fetched > 0 ? fetched : null);
    };
    read();
    return subscribeQuotaCache((key) => {
      if (
        !subscriptionId ||
        key === "*" ||
        key === vmSkusCacheKey(subscriptionId, true) ||
        key === vmSkusCacheKey(subscriptionId, false)
      ) {
        read();
      }
    });
  }, [subscriptionId]);

  // Tick once a minute so the relative "X min ago" label refreshes even
  // when the cache itself isn't changing. Cheap — single setInterval.
  const [, setNowTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const catalogAgeLabel = React.useMemo(() => {
    if (catalogFetchedAt == null) return null;
    const ageMs = Date.now() - catalogFetchedAt;
    if (ageMs < 0) return "just now";
    const min = Math.floor(ageMs / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }, [catalogFetchedAt]);

  // Manual refresh — invalidates the cached SKU set for the current sub
  // and routes the operator to the VM Catalog page where the prefetch
  // will re-populate. We don't have a direct "fetch VM SKUs" action on
  // the orchestrator (boot prefetch in dashboard-shell owns that path),
  // so the safe contract is invalidate-and-navigate.
  const handleRefreshCatalog = React.useCallback(() => {
    if (!subscriptionId) return;
    invalidateQuotaCache(subscriptionId);
    auditLog.record({
      actor: primaryAccount?.username ?? "unknown",
      action: "invalidate_vm_catalog",
      target: `subscription:${subscriptionId}`,
      status: "success",
      details: { from: "pool-creation" },
    });
    store.addNotification({
      type: "info",
      message: "VM catalog cache cleared — open VM Catalog to repopulate.",
      autoDismissMs: 4000,
    });
  }, [subscriptionId, primaryAccount?.username, store]);
  const [autoSelectedSubscription, setAutoSelectedSubscription] =
    React.useState(false);

  // Image step
  const [osCategory, setOsCategory] = React.useState<"linux" | "windows">(
    poolDefaults?.osCategory ?? "linux",
  );

  // Scale step
  const [resizeTimeoutMin, setResizeTimeoutMin] = React.useState<number>(
    poolDefaults?.resizeTimeoutMinutes ?? 15,
  );

  // Networking step
  const [subnetId, setSubnetId] = React.useState<string>(
    poolDefaults?.subnetId ?? "",
  );
  const [subnetError, setSubnetError] = React.useState<string | null>(null);
  const [interNodeComm, setInterNodeComm] = React.useState<boolean>(
    poolDefaults?.enableInterNodeCommunication ?? false,
  );

  // Tasks step
  const [startTaskCmd, setStartTaskCmd] = React.useState(
    poolDefaults?.startTask?.commandLine ??
      DEFAULT_POOL_CONFIG.startTask.commandLine,
  );
  const [envVars, setEnvVars] = React.useState<EnvVar[]>([]);
  const [maxRetryCount, setMaxRetryCount] = React.useState(3);
  const [waitForSuccess, setWaitForSuccess] = React.useState(true);

  // Review step
  const [saveAsDefault, setSaveAsDefault] = React.useState(false);
  const [confirmHidden, setConfirmHidden] = React.useState(true);

  // ---- Saved templates (last N successful configs) ----
  const [templates, setTemplates] = usePersistedState<PoolTemplate[]>(
    POOL_TEMPLATES_KEY,
    [],
  );

  // ---- Per-submit AbortController ----
  // Lets the operator cancel a long-running smart-fill dispatch via the
  // "Stop" button and also auto-cancels on unmount. The orchestrator
  // already accepts `params.signal` and forwards it to the per-agent
  // cancellation tracker; we just supply the controller here.
  const submitAbortRef = React.useRef<AbortController | null>(null);

  // Separate controller for the "Discover accounts" action so the
  // operator typing in the sub picker (changes selectedSubIds) can abort
  // the previous discovery without nuking the in-flight pool create.
  const discoverAbortRef = React.useRef<AbortController | null>(null);

  // Mount-effect-only abort on unmount.
  React.useEffect(() => {
    return () => {
      submitAbortRef.current?.abort();
      discoverAbortRef.current?.abort();
    };
  }, []);

  // ---- Refs / IDs ----
  const poolIdFieldRef = React.useRef<HTMLInputElement | null>(null);
  const subnetFieldRef = React.useRef<HTMLInputElement | null>(null);
  const startTaskFieldRef = React.useRef<HTMLTextAreaElement | null>(null);
  const jsonEditorContainerRef = React.useRef<HTMLDivElement | null>(null);

  const poolIdFieldId = React.useId();
  const startTaskFieldId = React.useId();
  const retryFieldId = React.useId();
  const jsonEditorFieldId = React.useId();
  const smartModeId = React.useId();
  const waitForSuccessId = React.useId();
  const subscriptionFieldId = React.useId();
  const subnetFieldId = React.useId();
  const interNodeCommId = React.useId();
  const resizeTimeoutFieldId = React.useId();
  const osCategoryFieldId = React.useId();
  const saveAsDefaultId = React.useId();

  // ---- Effects ----

  // Load last pool config from preferences on mount.
  React.useEffect(() => {
    const prefs = store.getUserPreferences();
    if (prefs.lastPoolConfig) {
      setPoolConfigJson(prefs.lastPoolConfig);
    }
  }, [store]);

  // Auto-select the only subscription on first hydration.
  React.useEffect(() => {
    if (
      state.subscriptions.length === 1 &&
      selectedSubIds.length === 0 &&
      state.subscriptions[0]?.subscriptionId
    ) {
      setSelectedSubIds([state.subscriptions[0].subscriptionId]);
      setAutoSelectedSubscription(true);
    }
    // Drop stale ids (sub disappeared from state, e.g., after logout).
    const visible = new Set(state.subscriptions.map((s) => s.subscriptionId));
    setSelectedSubIds((prev) => {
      const filtered = prev.filter((id) => visible.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [state.subscriptions, selectedSubIds.length]);

  // Toggle a sub in/out of the multi-pick set. Clears the auto-select
  // hint the moment the user makes a manual choice (positive OR negative
  // — un-ticking a single auto-selected sub also flips the flag).
  const toggleSubSelection = React.useCallback((subId: string) => {
    setAutoSelectedSubscription(false);
    setSelectedSubIds((prev) =>
      prev.includes(subId)
        ? prev.filter((x) => x !== subId)
        : [...prev, subId],
    );
  }, []);

  // Explicit "Discover accounts" handler — walks the operator's chosen
  // subs (or every signed-in sub when the filter is empty) and asks the
  // orchestrator to re-pull Batch accounts from each. Each call passes
  // a specific `subscriptionId` so the orchestrator's per-sub token
  // resolver routes through the owning MSAL identity — without that,
  // subs owned by a non-primary signed-in account silently return
  // nothing and the operator sees the "No eligible accounts" stub.
  const handleDiscoverAccounts = React.useCallback(async () => {
    const targetSubs =
      selectedSubIds.length > 0
        ? selectedSubIds
        : state.subscriptions.map((s) => s.subscriptionId);
    if (targetSubs.length === 0) {
      setDiscoverError(
        "No subscriptions to discover. Sign in to an Azure account first.",
      );
      return;
    }
    setDiscoverError(null);
    // Spin a fresh controller; aborts any in-flight discovery from a
    // previous click before starting the new walk.
    discoverAbortRef.current?.abort();
    discoverAbortRef.current = new AbortController();
    setDiscoverProgress({
      completed: 0,
      total: targetSubs.length,
      currentSubId: targetSubs[0] ?? null,
      importedTotal: 0,
    });
    const before = state.accounts.length;
    const errors: string[] = [];
    try {
      for (let i = 0; i < targetSubs.length; i++) {
        const subId = targetSubs[i];
        setDiscoverProgress((prev) =>
          prev
            ? { ...prev, completed: i, currentSubId: subId }
            : prev,
        );
        try {
          await orchestrator.execute({
            action: "discover_accounts",
            payload: { subscriptionId: subId },
            signal: discoverAbortRef.current?.signal,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${subId.slice(0, 8)}…: ${message}`);
        }
      }
      // After discovery, eagerly refresh account info (quota) so the
      // newly-imported accounts show real `lowPriorityCoresFree` values.
      // Without this the Submit step's pre-flight sees free=0 on every
      // freshly-discovered account and returns `total=N, failed=N,
      // failures=[]` — the empty-failures stub. Each account-info refresh
      // is sub-scoped via the orchestrator's per-sub token cache so
      // accounts owned by non-primary signed-in identities are
      // populated correctly.
      try {
        await orchestrator.execute({
          action: "refresh_account_info",
          payload: {},
          signal: discoverAbortRef.current?.signal,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`account-info refresh: ${message}`);
      }
      const after =
        // Re-read the store state synchronously through the orchestrator's
        // bound store reference is too brittle here — easier to derive
        // from the accounts already visible after dispatch via the
        // subscribed `state.accounts` prop on the next render.
        // For the immediate progress display we just emit the diff.
        Math.max(0, state.accounts.length - before);
      setDiscoverProgress({
        completed: targetSubs.length,
        total: targetSubs.length,
        currentSubId: null,
        importedTotal: after,
      });
      if (errors.length > 0) {
        setDiscoverError(errors.join(" · "));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setDiscoverError(message);
    }
  }, [orchestrator, selectedSubIds, state.subscriptions, state.accounts.length]);

  // Save pool config to preferences when editor value changes (debounced).
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const handleEditorChange = React.useCallback(
    (value: string) => {
      setPoolConfigJson(value);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        store.saveUserPreferences({ lastPoolConfig: value });
      }, 1000);
    },
    [store],
  );

  // Cleanup debounce timer on unmount.
  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Show all created accounts. When the operator has picked one or more
  // subs in the filter dropdown, narrow to the union of those subs;
  // otherwise show every created account across every signed-in
  // subscription. This is the multi-sub fan-out enabler — without it
  // the user can't select accounts from two different subs in a single
  // pool-create dispatch.
  const subFilterSet = React.useMemo(
    () => new Set(selectedSubIds),
    [selectedSubIds],
  );

  // Detect ambiguous subscription labels — i.e. two different
  // subscriptionIds that share the same `displayName` AND the same
  // `ownerAccountLabel`. Operators running provisioning scripts that
  // create subs named "Sub for Provisioned User N" sometimes end up
  // with the same script run twice under two different AAD identities
  // that ALSO share the same display name. The dropdown then shows
  // two visually-identical rows. They are functionally distinct (each
  // has its own GUID + homeAccountId, tokens route correctly per
  // sub), but the operator can't tell them apart. We compute the set
  // of "ambiguous" subscriptionIds here and append a disambiguating
  // homeAccountId suffix to those entries in the picker + chips.
  const ambiguousSubIds = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of state.subscriptions) {
      const key = `${s.displayName}|${s.ownerAccountLabel ?? ""}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const ids = new Set<string>();
    for (const s of state.subscriptions) {
      const key = `${s.displayName}|${s.ownerAccountLabel ?? ""}`;
      if ((counts.get(key) ?? 0) > 1) ids.add(s.subscriptionId);
    }
    return ids;
  }, [state.subscriptions]);
  // Index account-info by account id so we can splice quota numbers into
  // each eligible-account row without re-walking the array per row. Stale
  // (no entry) is treated as "quota not loaded" rather than zero — zero
  // would silently hide accounts behind the LP filter below.
  const accountInfoIndex = React.useMemo(() => {
    const map = new Map<string, (typeof state.accountInfos)[number]>();
    for (const ai of state.accountInfos ?? []) {
      map.set(ai.id, ai);
    }
    return map;
  }, [state.accountInfos]);

  // Sub-id → displayName index for the new Subscription column. Cheap to
  // rebuild on subscription changes (typical N is < 20) and avoids an
  // O(n*m) lookup inside the row mapper.
  const subscriptionNameIndex = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const s of state.subscriptions ?? []) {
      map.set(s.subscriptionId, s.displayName);
    }
    return map;
  }, [state.subscriptions]);

  // Operator-driven UX filters layered ON TOP of the existing sub filter.
  // Both default to "off" so the page renders identically out-of-the-box.
  const [accountSearch, setAccountSearch] = React.useState("");
  const [onlyAccountsWithFreeLp, setOnlyAccountsWithFreeLp] =
    React.useState(false);
  // Region multi-pick filter. Empty set = no region filter (matches the
  // sub-filter convention).
  const [regionFilter, setRegionFilter] = React.useState<Set<string>>(
    () => new Set(),
  );

  const eligibleAccountsRaw: EligibleAccount[] = React.useMemo(
    () =>
      state.accounts
        .filter(
          (a) =>
            a.provisioningState === "created" &&
            (subFilterSet.size === 0 || subFilterSet.has(a.subscriptionId)),
        )
        .map((a) => {
          const info = accountInfoIndex.get(a.id);
          return {
            id: a.id,
            accountName: a.accountName,
            region: a.region,
            subscriptionId: a.subscriptionId,
            subscriptionName:
              subscriptionNameIndex.get(a.subscriptionId) ?? "",
            lowPriorityCoresFree: info?.lowPriorityCoresFree ?? 0,
            dedicatedCoresFree: info?.dedicatedCoresFree ?? 0,
            poolCount: info?.poolCount ?? 0,
            poolQuota: info?.poolQuota ?? 0,
            quotaStale: info == null,
          };
        }),
    [state.accounts, subFilterSet, accountInfoIndex, subscriptionNameIndex],
  );

  // Region list for the filter dropdown — derived from the raw rows (BEFORE
  // the search/quota filters) so the dropdown options stay stable while the
  // operator types.
  const availableRegions = React.useMemo(() => {
    const set = new Set<string>();
    for (const a of eligibleAccountsRaw) set.add(a.region);
    return Array.from(set).sort();
  }, [eligibleAccountsRaw]);

  // Apply the search, region, and "only with free LP" filters last. Search
  // matches case-insensitively against accountName / region / sub name —
  // the three columns the operator can actually see.
  const eligibleAccounts: EligibleAccount[] = React.useMemo(() => {
    const needle = accountSearch.trim().toLowerCase();
    return eligibleAccountsRaw.filter((row) => {
      if (onlyAccountsWithFreeLp && row.lowPriorityCoresFree <= 0) return false;
      if (regionFilter.size > 0 && !regionFilter.has(row.region)) return false;
      if (needle.length === 0) return true;
      return (
        row.accountName.toLowerCase().includes(needle) ||
        row.region.toLowerCase().includes(needle) ||
        row.subscriptionName.toLowerCase().includes(needle) ||
        row.subscriptionId.toLowerCase().includes(needle)
      );
    });
  }, [eligibleAccountsRaw, accountSearch, onlyAccountsWithFreeLp, regionFilter]);

  const accountColumns = React.useMemo(() => buildAccountColumns(), []);

  // Summary stats over the FILTERED set so the stats row reflects what
  // the operator currently sees (matches what they're picking from).
  const accountStats = React.useMemo(() => {
    let totalFreeLp = 0;
    let totalFreeDed = 0;
    let withFreeLp = 0;
    for (const a of eligibleAccounts) {
      if (a.quotaStale) continue;
      totalFreeLp += a.lowPriorityCoresFree;
      totalFreeDed += a.dedicatedCoresFree;
      if (a.lowPriorityCoresFree > 0) withFreeLp += 1;
    }
    return { totalFreeLp, totalFreeDed, withFreeLp };
  }, [eligibleAccounts]);

  // Selected-account stats (free quota summed across the picks). This is
  // the operator's "am I about to fill a million cores?" sanity check that
  // matters MORE than the all-eligible aggregate when they've actually
  // ticked rows.
  const selectedStats = React.useMemo(() => {
    let totalFreeLp = 0;
    let staleCount = 0;
    let withZeroLp = 0;
    for (const a of eligibleAccountsRaw) {
      if (!selectedAccountIds.has(a.id)) continue;
      if (a.quotaStale) {
        staleCount += 1;
        continue;
      }
      totalFreeLp += a.lowPriorityCoresFree;
      if (a.lowPriorityCoresFree <= 0) withZeroLp += 1;
    }
    return { totalFreeLp, staleCount, withZeroLp };
  }, [eligibleAccountsRaw, selectedAccountIds]);

  // ---- Env var helpers ----
  const addEnvVar = React.useCallback(() => {
    setEnvVars((prev) => [...prev, { name: "", value: "" }]);
  }, []);

  const removeEnvVar = React.useCallback((index: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateEnvVar = React.useCallback(
    (index: number, field: "name" | "value", val: string) => {
      setEnvVars((prev) =>
        prev.map((ev, i) => (i === index ? { ...ev, [field]: val } : ev)),
      );
    },
    [],
  );

  // ---- env-var bulk-edit helpers ----
  // Operator-facing controls for the env-vars table: paste a .env blob,
  // clear everything, or dedupe by name. Each goes through the same
  // immutable updater so the React tree re-renders normally.

  const [envPasteOpen, setEnvPasteOpen] = React.useState(false);
  const [envPasteText, setEnvPasteText] = React.useState("");
  const [envPasteWarnings, setEnvPasteWarnings] = React.useState<string[]>([]);
  const envPasteFieldId = React.useId();

  const handleEnvPasteApply = React.useCallback(() => {
    const result = parseEnvPaste(envPasteText);
    setEnvPasteWarnings(result.warnings);
    if (result.parsed.length === 0) {
      // Nothing to add — keep the modal open so the warnings can be read.
      return;
    }
    setEnvVars((prev) => {
      // Merge: existing values stay, new keys appended, duplicate keys
      // replace the existing value (last-write-wins, matches shell `export`).
      const byName = new Map<string, string>();
      for (const ev of prev) {
        if (ev.name.trim() !== "") byName.set(ev.name, ev.value);
      }
      for (const p of result.parsed) byName.set(p.name, p.value);
      const merged: EnvVar[] = [];
      // Preserve order: existing names first (in their original order),
      // then new ones appended in paste order.
      const existingNames = new Set(
        prev.filter((ev) => ev.name.trim() !== "").map((ev) => ev.name),
      );
      for (const ev of prev) {
        if (ev.name.trim() === "") continue;
        merged.push({ name: ev.name, value: byName.get(ev.name) ?? ev.value });
      }
      for (const p of result.parsed) {
        if (!existingNames.has(p.name)) {
          merged.push(p);
        }
      }
      return merged;
    });
    setEnvPasteText("");
    setEnvPasteOpen(false);
  }, [envPasteText]);

  const clearAllEnvVars = React.useCallback(() => {
    setEnvVars([]);
  }, []);

  const dedupeEnvVars = React.useCallback(() => {
    setEnvVars((prev) => {
      const seen = new Map<string, EnvVar>();
      for (const ev of prev) {
        if (ev.name.trim() === "") continue;
        seen.set(ev.name, ev);
      }
      return Array.from(seen.values());
    });
  }, []);

  // Detect duplicate env-var names so the UI can highlight them inline.
  // Single source of truth so the inline badge + the submit dialog agree.
  const envDuplicateNames = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of envVars) {
      const k = ev.name.trim();
      if (k === "") continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const dups = new Set<string>();
    for (const [k, n] of counts) if (n > 1) dups.add(k);
    return dups;
  }, [envVars]);

  // POSIX-invalid env-var names. An operator can type `123-bad` directly
  // into the inline name input; we don't drop that on submit (it'd be a
  // silent fail), we highlight inline and block submit on the Tasks step.
  const envInvalidIndices = React.useMemo(() => {
    const set = new Set<number>();
    envVars.forEach((ev, idx) => {
      const k = ev.name.trim();
      if (k !== "" && !ENV_NAME_PATTERN.test(k)) set.add(idx);
    });
    return set;
  }, [envVars]);
  const envHasInvalidNames = envInvalidIndices.size > 0;

  // ---- start-task helpers ----
  const applyStartTaskPreset = React.useCallback((preset: StartTaskPreset) => {
    setStartTaskCmd(preset.commandLine);
    requestAnimationFrame(() => {
      startTaskFieldRef.current?.focus();
      startTaskFieldRef.current?.setSelectionRange(
        preset.commandLine.length,
        preset.commandLine.length,
      );
    });
  }, []);

  // ---- JSON-mode helpers ----
  const handleJsonFormat = React.useCallback(() => {
    try {
      const parsed = JSON.parse(poolConfigJson);
      setPoolConfigJson(JSON.stringify(parsed, null, 2));
      setConfigError(null);
    } catch (e) {
      setConfigError(
        `Cannot format: ${(e as Error).message ?? "invalid JSON"}`,
      );
    }
  }, [poolConfigJson]);

  const handleJsonReset = React.useCallback(() => {
    setPoolConfigJson(JSON.stringify(DEFAULT_POOL_CONFIG, null, 2));
    setConfigError(null);
  }, []);

  const handleJsonCopy = React.useCallback(async () => {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(poolConfigJson);
        store.addNotification({
          type: "success",
          message: "Pool config copied to clipboard",
          autoDismissMs: 2500,
        });
      }
    } catch {
      // Silent — CopyButton elsewhere on the page does its own retry path.
    }
  }, [poolConfigJson, store]);

  const handleJsonDownload = React.useCallback(() => {
    try {
      const blob = new Blob([poolConfigJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pool-config-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setConfigError(
        `Download failed: ${(e as Error).message ?? "unknown error"}`,
      );
    }
  }, [poolConfigJson]);

  // ---- Bulk selection helpers ----
  // Operator-facing shortcuts that beat clicking through 30 checkboxes
  // one by one. Each acts on the CURRENTLY-FILTERED set (eligibleAccounts)
  // so the search / region filter / "only with free LP" toggle compose
  // naturally with the bulk action — pick "Select all" right after
  // narrowing by region to add a whole region's worth in one click.

  const selectAllVisible = React.useCallback(() => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      for (const a of eligibleAccounts) next.add(a.id);
      return next;
    });
  }, [eligibleAccounts]);

  const clearAllSelection = React.useCallback(() => {
    setSelectedAccountIds(new Set());
  }, []);

  const selectVisibleWithFreeLp = React.useCallback(() => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      for (const a of eligibleAccounts) {
        if (!a.quotaStale && a.lowPriorityCoresFree > 0) next.add(a.id);
      }
      return next;
    });
  }, [eligibleAccounts]);

  const invertVisibleSelection = React.useCallback(() => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      for (const a of eligibleAccounts) {
        if (next.has(a.id)) next.delete(a.id);
        else next.add(a.id);
      }
      return next;
    });
  }, [eligibleAccounts]);

  const toggleRegionFilter = React.useCallback((region: string) => {
    setRegionFilter((prev) => {
      const next = new Set(prev);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
  }, []);

  const clearAllFilters = React.useCallback(() => {
    setAccountSearch("");
    setOnlyAccountsWithFreeLp(false);
    setRegionFilter(new Set());
  }, []);

  // Pools currently resizing — block creation in smart mode while true.
  const resizingPools = React.useMemo(
    () =>
      (state.poolInfos ?? []).filter(
        (p) =>
          p.allocationState === "resizing" ||
          p.allocationState === "stopping",
      ),
    [state.poolInfos],
  );

  // ---- Per-step validity ----

  const targetStepValid =
    selectedAccountIds.size > 0 &&
    (smartMode ? resizingPools.length === 0 : true);

  const imageStepValid = osCategory === "linux" || osCategory === "windows";

  const scaleStepValid = (() => {
    if (!smartMode) {
      try {
        const parsed = JSON.parse(poolConfigJson);
        const id = (parsed as { id?: unknown })?.id;
        return validatePoolId(id) === null;
      } catch {
        return false;
      }
    }
    return validatePoolId(poolIdInput) === null && resizeTimeoutMin >= 5;
  })();

  const networkingStepValid = validateSubnetId(subnetId) === null;

  const tasksStepValid =
    startTaskCmd.trim().length > 0 && !envHasInvalidNames;

  const stepValidity: Record<StepKey, boolean> = {
    target: targetStepValid,
    image: targetStepValid && imageStepValid,
    scale: targetStepValid && imageStepValid && scaleStepValid,
    networking:
      targetStepValid &&
      imageStepValid &&
      scaleStepValid &&
      networkingStepValid,
    tasks:
      targetStepValid &&
      imageStepValid &&
      scaleStepValid &&
      networkingStepValid &&
      tasksStepValid,
    review:
      targetStepValid &&
      imageStepValid &&
      scaleStepValid &&
      networkingStepValid &&
      tasksStepValid,
  };

  const allStepsValid = stepValidity.tasks; // every gate up to tasks passed.

  const goToStep = React.useCallback(
    (key: StepKey) => {
      setStepState({ step: key });
    },
    [setStepState],
  );

  const stepOrder = STEPS.map((s) => s.key);
  const currentIndex = Math.max(0, stepOrder.indexOf(currentStep));

  const handleContinue = React.useCallback(() => {
    // Re-validate the current step and surface inline errors before advancing.
    if (currentStep === "scale" && smartMode) {
      const idErr = validatePoolId(poolIdInput);
      setPoolIdError(idErr);
      if (idErr) {
        requestAnimationFrame(() => poolIdFieldRef.current?.focus());
        return;
      }
    }
    if (currentStep === "scale" && !smartMode) {
      try {
        const parsed = JSON.parse(poolConfigJson);
        const idErr = validatePoolId((parsed as { id?: unknown })?.id);
        if (idErr) {
          setConfigError(`Pool config: ${idErr}`);
          requestAnimationFrame(() =>
            jsonEditorContainerRef.current?.focus(),
          );
          return;
        }
        setConfigError(null);
      } catch (e) {
        setConfigError(
          `Invalid JSON: ${(e as Error).message ?? "parse error"}`,
        );
        requestAnimationFrame(() => jsonEditorContainerRef.current?.focus());
        return;
      }
    }
    if (currentStep === "networking") {
      const err = validateSubnetId(subnetId);
      setSubnetError(err);
      if (err) {
        requestAnimationFrame(() => subnetFieldRef.current?.focus());
        return;
      }
    }
    if (currentStep === "tasks" && !tasksStepValid) {
      requestAnimationFrame(() => startTaskFieldRef.current?.focus());
      return;
    }
    if (currentIndex < stepOrder.length - 1) {
      goToStep(stepOrder[currentIndex + 1]);
    }
  }, [
    currentStep,
    smartMode,
    poolIdInput,
    poolConfigJson,
    subnetId,
    tasksStepValid,
    currentIndex,
    stepOrder,
    goToStep,
  ]);

  const handleBack = React.useCallback(() => {
    if (currentIndex > 0) {
      goToStep(stepOrder[currentIndex - 1]);
    }
  }, [currentIndex, stepOrder, goToStep]);

  // Find the first invalid step and jump to it. Powers the "Jump to first
  // unresolved step" button on the Review pane so the operator doesn't
  // have to click through the stepper hunting for the red dot.
  const firstInvalidStep = React.useMemo<StepKey | null>(() => {
    const order: StepKey[] = ["target", "image", "scale", "networking", "tasks"];
    for (const k of order) {
      if (!stepValidity[k]) return k;
    }
    return null;
  }, [stepValidity]);

  // ---- Submit ----

  const handleSubmit = React.useCallback(() => {
    setConfigError(null);
    setPoolIdError(null);
    if (!allStepsValid) return;
    if (smartMode && resizingPools.length > 0) {
      setConfigError(
        `Cannot create pools while ${resizingPools.length} pool(s) are still resizing. Wait for them to finish or stop them first.`,
      );
      return;
    }
    setConfirmHidden(false);
  }, [allStepsValid, smartMode, resizingPools.length]);

  // Keyboard shortcut: Ctrl/Cmd + Enter advances the wizard. On the
  // review step it opens the confirmation dialog (matches the visible
  // "Create pools" CTA). On any earlier step it triggers Continue,
  // which re-runs the per-step validators. Routed through the shared
  // `useShortcut` hook so the chord parsing + cross-platform Cmd vs Ctrl
  // handling lives in one place. `allowInInputs: true` because the
  // operator routinely fires this while focus is in the Pool ID / subnet
  // inputs; we keep the manual Monaco/textarea bailouts below.
  useShortcut(
    "Mod+Enter",
    React.useCallback(
      (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (target) {
          const tag = target.tagName;
          if (tag === "TEXTAREA") return;
          // Monaco renders inside contenteditable=true descendants — skip.
          const ce =
            target.closest("[contenteditable='true']") ??
            target.closest(".monaco-editor");
          if (ce) return;
        }
        if (isRunning) return;
        event.preventDefault();
        if (currentStep === "review") {
          handleSubmit();
        } else {
          handleContinue();
        }
      },
      [currentStep, isRunning, handleSubmit, handleContinue],
    ),
    { allowInInputs: true, preventDefault: false },
  );

  // Esc — close the confirmation dialog if open. Doesn't otherwise
  // interfere; the dropdown menus / Monaco / etc. handle their own Esc
  // before this listener (window-level) gets the event.
  useShortcut(
    "Escape",
    React.useCallback(() => {
      if (!confirmHidden) {
        setConfirmHidden(true);
      }
    }, [confirmHidden]),
    { allowInInputs: true, preventDefault: false },
  );

  // ARIA-live announcement for creation results — picked up by a polite
  // live region rendered near the bottom. Without this, screen-reader
  // users get no audible signal when a long-running smart-fill dispatch
  // finishes; the visible badges only help sighted operators.
  const [creationAnnouncement, setCreationAnnouncement] = React.useState("");

  // Manual "save current wizard form as a template" — distinct from the
  // auto-save on successful dispatch in `handleCreate`. Lets the operator
  // checkpoint a half-built config (e.g. before swapping target accounts)
  // without having to actually run the dispatch first.
  const saveCurrentAsTemplate = React.useCallback(() => {
    if (poolIdInput.trim().length === 0) return;
    const snapshot: PoolTemplate = {
      id: crypto.randomUUID(),
      name: `${poolIdInput || "untitled"} (manual)`,
      savedAt: new Date().toISOString(),
      poolIdPrefix: poolIdInput,
      osCategory,
      resizeTimeoutMin,
      subnetId,
      interNodeComm,
      startTaskCmd,
      maxRetryCount,
      waitForSuccess,
      envVars: envVars.filter((ev) => ev.name.trim() !== ""),
      smartMode,
      smartVmSizes: [...smartVmSizes],
    };
    setTemplates((prev) => [snapshot, ...prev].slice(0, POOL_TEMPLATES_MAX));
    store.addNotification({
      type: "info",
      message: `Saved "${snapshot.name}" to templates (Ctrl+S)`,
      autoDismissMs: 2500,
    });
  }, [
    poolIdInput,
    osCategory,
    resizeTimeoutMin,
    subnetId,
    interNodeComm,
    startTaskCmd,
    maxRetryCount,
    waitForSuccess,
    envVars,
    smartMode,
    smartVmSizes,
    setTemplates,
    store,
  ]);

  // Ctrl/Cmd+S — save the current wizard form as a named template.
  // Browser default is "save page", which we always pre-empt.
  useShortcut(
    "Mod+s",
    React.useCallback(
      (event: KeyboardEvent) => {
        // Monaco's own Ctrl+S handler should win when focus is inside.
        const target = event.target as HTMLElement | null;
        if (target) {
          const ce =
            target.closest("[contenteditable='true']") ??
            target.closest(".monaco-editor");
          if (ce) return;
        }
        event.preventDefault();
        saveCurrentAsTemplate();
      },
      [saveCurrentAsTemplate],
    ),
    { allowInInputs: true, preventDefault: false },
  );

  // Export / import templates as JSON — the "share with the rest of the
  // org" affordance. A template is a denormalised wizard snapshot
  // (NOT the orchestrator payload), so a JSON exchange is safe to share
  // — no account IDs, no tokens. Schema is captured by the
  // `format: "pool-creation-templates"` envelope so a future
  // schema-version bump can be detected on import.

  const exportTemplates = React.useCallback(() => {
    if (templates.length === 0) {
      store.addNotification({
        type: "info",
        message: "No saved templates to export.",
        autoDismissMs: 2500,
      });
      return;
    }
    const blob = new Blob(
      [
        JSON.stringify(
          {
            format: "pool-creation-templates",
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            templates,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pool-templates-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    auditLog.record({
      actor: primaryAccount?.username ?? "unknown",
      action: "pool_templates:export",
      target: `${templates.length} template(s)`,
      status: "success",
      details: { count: templates.length },
    });
  }, [templates, store, primaryAccount?.username]);

  // Hidden file input — clicking the "Import templates" button forwards
  // here. Conservative parser: rejects anything not matching the envelope,
  // drops individual entries that fail per-field validation rather than
  // bailing the whole import.
  const importTemplatesRef = React.useRef<HTMLInputElement | null>(null);
  const handleImportTemplatesFile = React.useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed?.format !== "pool-creation-templates") {
          store.addNotification({
            type: "error",
            message:
              'Import failed: expected {"format": "pool-creation-templates"} envelope.',
            autoDismissMs: 5000,
          });
          return;
        }
        const raw = parsed.templates;
        if (!Array.isArray(raw)) {
          store.addNotification({
            type: "error",
            message: "Import failed: templates field is not an array.",
            autoDismissMs: 5000,
          });
          return;
        }
        const valid: PoolTemplate[] = [];
        const skipped: string[] = [];
        for (const candidate of raw) {
          const c = candidate as Partial<PoolTemplate>;
          if (
            typeof c.poolIdPrefix !== "string" ||
            (c.osCategory !== "linux" && c.osCategory !== "windows") ||
            typeof c.startTaskCmd !== "string" ||
            typeof c.resizeTimeoutMin !== "number"
          ) {
            skipped.push(c?.name ?? "<unnamed>");
            continue;
          }
          valid.push({
            id: typeof c.id === "string" && c.id.length > 0 ? c.id : crypto.randomUUID(),
            name: typeof c.name === "string" ? c.name : c.poolIdPrefix,
            savedAt:
              typeof c.savedAt === "string" ? c.savedAt : new Date().toISOString(),
            poolIdPrefix: c.poolIdPrefix,
            osCategory: c.osCategory,
            resizeTimeoutMin: c.resizeTimeoutMin,
            subnetId: typeof c.subnetId === "string" ? c.subnetId : "",
            interNodeComm: c.interNodeComm === true,
            startTaskCmd: c.startTaskCmd,
            maxRetryCount:
              typeof c.maxRetryCount === "number" ? c.maxRetryCount : 3,
            waitForSuccess: c.waitForSuccess !== false,
            envVars: Array.isArray(c.envVars)
              ? c.envVars
                  .filter(
                    (ev): ev is { name: string; value: string } =>
                      ev != null &&
                      typeof (ev as { name?: unknown }).name === "string" &&
                      typeof (ev as { value?: unknown }).value === "string",
                  )
                  .map((ev) => ({ name: ev.name, value: ev.value }))
              : [],
            smartMode: c.smartMode !== false,
            smartVmSizes: Array.isArray(c.smartVmSizes)
              ? c.smartVmSizes.filter((s): s is string => typeof s === "string")
              : [],
          });
        }
        setTemplates((prev) =>
          // Dedupe by id, keep imported entries first, cap at the persisted max.
          [...valid, ...prev]
            .filter(
              (t, i, arr) => arr.findIndex((x) => x.id === t.id) === i,
            )
            .slice(0, POOL_TEMPLATES_MAX),
        );
        store.addNotification({
          type: valid.length > 0 ? "success" : "warning",
          message:
            `Imported ${valid.length} template(s)` +
            (skipped.length > 0 ? `; skipped ${skipped.length} malformed entry(ies).` : "."),
          autoDismissMs: 4000,
        });
        auditLog.record({
          actor: primaryAccount?.username ?? "unknown",
          action: "pool_templates:import",
          target: file.name,
          status: "success",
          details: { imported: valid.length, skipped: skipped.length },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        store.addNotification({
          type: "error",
          message: `Import failed: ${msg}`,
          autoDismissMs: 5000,
        });
      }
    },
    [setTemplates, store, primaryAccount?.username],
  );

  const persistDefaultsFromForm = React.useCallback(() => {
    const updater = store as unknown as {
      updatePoolDefaults?: (patch: Partial<PoolDefaults>) => void;
    };
    if (typeof updater.updatePoolDefaults !== "function") return;
    const environmentSettings = envVars
      .filter((ev) => ev.name.trim() !== "")
      .map((ev) => ({ name: ev.name, value: ev.value }));
    updater.updatePoolDefaults({
      poolIdPrefix: poolIdInput,
      osCategory,
      resizeTimeoutMinutes: resizeTimeoutMin,
      enableInterNodeCommunication: interNodeComm,
      subnetId,
      startTask: {
        commandLine: startTaskCmd,
        environmentSettings,
        maxTaskRetryCount: maxRetryCount,
        resourceFiles: poolDefaults?.startTask?.resourceFiles ?? [],
        userIdentity: poolDefaults?.startTask?.userIdentity ?? {
          autoUser: { scope: "pool", elevationLevel: "admin" },
        },
        waitForSuccess,
      },
    });
  }, [
    store,
    poolIdInput,
    osCategory,
    resizeTimeoutMin,
    interNodeComm,
    subnetId,
    envVars,
    startTaskCmd,
    maxRetryCount,
    waitForSuccess,
    poolDefaults,
  ]);

  const handleCreate = React.useCallback(async () => {
    setConfirmHidden(true);
    // Spin a fresh controller for this submit. Abort any previous in-flight
    // controller first (defensive — UI disables the button while running,
    // but a stale controller could leak through if isRunning was already
    // mid-toggle when handleCreate re-fired).
    submitAbortRef.current?.abort();
    const controller = new AbortController();
    submitAbortRef.current = controller;
    const actor = primaryAccount?.username ?? "unknown";
    const submitTarget = `${selectedAccountIds.size} account(s)`;
    // Inlined re-derivation of the planned-VM count and cross-sub flag so
    // the useCallback dep array stays free of the post-callback `const`s
    // (referencing those in deps would be a TDZ error at first render).
    const plannedVmCount =
      smartMode && liveCatalogEffective && smartVmSizes.length > 0
        ? smartVmSizes.length
        : smartMode
          ? getAllVmSizes().length
          : 1;
    const distinctSubsInSelection = new Set<string>();
    {
      const acctById = new Map(state.accounts.map((a) => [a.id, a] as const));
      for (const id of selectedAccountIds) {
        const acc = acctById.get(id);
        if (acc) distinctSubsInSelection.add(acc.subscriptionId);
      }
    }
    auditLog.record({
      actor,
      action: smartMode ? "create_pools_smart:submit" : "create_pools:submit",
      target: submitTarget,
      status: "success",
      details: {
        accountIds: Array.from(selectedAccountIds),
        smartMode,
        poolIdPrefix: poolIdInput,
        vmSizeCount: plannedVmCount,
        crossSubDispatch: distinctSubsInSelection.size > 1,
      },
    });
    try {
      setConfigError(null);
      setIsRunning(true);

      if (smartMode) {
        // Source-of-truth resolution (uses liveCatalogEffective which
        // already AND-s the user toggle with cache-availability):
        //   1. Effective wire OFF → always use hardcoded list
        //   2. Effective wire ON + user picked SKUs → use the picks
        //   3. Effective wire ON + nothing picked → fall back to hardcoded
        //      so the dispatch is deterministic on a fresh sub.
        const allVmNames =
          liveCatalogEffective && smartVmSizes.length > 0
            ? smartVmSizes
            : getAllVmSizes().map((v) => v.name);

        const environmentSettings = envVars
          .filter((ev) => ev.name.trim() !== "")
          .map((ev) => ({ name: ev.name, value: ev.value }));

        let poolConfig: Record<string, unknown>;
        if (poolDefaults) {
          poolConfig = buildPoolConfigFromDefaults(poolDefaults, {
            id: poolIdInput,
            targetLowPriorityNodes: 0,
            // vmSize sent verbatim — Azure Compute SKU names are case-
            // sensitive (canonical: Standard_NC12s_v3). Lowercasing produces
            // "STANDARD_NC12S_V3 is not supported" when Azure echoes it
            // back. See pool-agent.ts for the matching fix.
            vmSize: allVmNames[0],
          });
          poolConfig.targetDedicatedNodes = 0;
          poolConfig.enableAutoScale = false;
        } else {
          poolConfig = {
            id: poolIdInput,
            vmSize: allVmNames[0],
            virtualMachineConfiguration: {
              nodeAgentSKUId: "batch.node.ubuntu 22.04",
              imageReference: {
                publisher: "canonical",
                offer: "0001-com-ubuntu-server-jammy",
                sku: "22_04-lts-gen2",
                version: "latest",
              },
            },
            resizeTimeout: `PT${resizeTimeoutMin}M`,
            targetDedicatedNodes: 0,
            targetLowPriorityNodes: 0,
            taskSlotsPerNode: 1,
            taskSchedulingPolicy: { nodeFillType: "Pack" },
            enableAutoScale: false,
            enableInterNodeCommunication: interNodeComm,
            certificateReferences: [],
            metadata: [],
            userAccounts: [],
          };
        }
        // Apply per-step overrides from the wizard.
        poolConfig.resizeTimeout = `PT${resizeTimeoutMin}M`;
        poolConfig.enableInterNodeCommunication = interNodeComm;
        if (subnetId) {
          poolConfig.networkConfiguration = { subnetId };
        }
        poolConfig.startTask = {
          commandLine: startTaskCmd,
          environmentSettings,
          maxTaskRetryCount: maxRetryCount,
          resourceFiles: [],
          userIdentity: {
            autoUser: {
              scope: "pool",
              elevationLevel: "admin",
            },
          },
          waitForSuccess,
        };
        await orchestrator.execute({
          action: "create_pools_smart",
          payload: {
            accountIds: Array.from(selectedAccountIds),
            vmSizes: allVmNames,
            poolConfig,
            quotaType: "lowPriority",
          },
          signal: controller.signal,
        });
      } else {
        const poolConfig = JSON.parse(poolConfigJson);
        poolConfig.targetDedicatedNodes = 0;
        await orchestrator.execute({
          action: "create_pools",
          payload: {
            accountIds: Array.from(selectedAccountIds),
            poolConfig,
          },
          signal: controller.signal,
        });
      }

      // Audit-log on successful dispatch. The pool-agent emits its own
      // per-account audit; this is the page-level "submit completed" line
      // that lets us correlate a wizard run with the per-account events.
      auditLog.record({
        actor,
        action: smartMode ? "create_pools_smart:result" : "create_pools:result",
        target: submitTarget,
        status: "success",
        details: {
          accountIds: Array.from(selectedAccountIds),
          smartMode,
          poolIdPrefix: poolIdInput,
        },
      });
      setCreationAnnouncement(
        `Pool creation dispatch completed for ${selectedAccountIds.size} account${selectedAccountIds.size === 1 ? "" : "s"}. Check the Pool Results table below for per-account status.`,
      );

      // Save the just-dispatched config as a template (cap at the last N).
      // Skipped if every field matches the most recent template — avoids
      // the operator ending up with five identical entries from clicking
      // Create on the same config repeatedly.
      const snapshot: PoolTemplate = {
        id: crypto.randomUUID(),
        name: poolIdInput || "untitled",
        savedAt: new Date().toISOString(),
        poolIdPrefix: poolIdInput,
        osCategory,
        resizeTimeoutMin,
        subnetId,
        interNodeComm,
        startTaskCmd,
        maxRetryCount,
        waitForSuccess,
        envVars: envVars.filter((ev) => ev.name.trim() !== ""),
        smartMode,
        smartVmSizes: [...smartVmSizes],
      };
      setTemplates((prev) => {
        const dupOfLatest =
          prev[0] &&
          prev[0].poolIdPrefix === snapshot.poolIdPrefix &&
          prev[0].osCategory === snapshot.osCategory &&
          prev[0].resizeTimeoutMin === snapshot.resizeTimeoutMin &&
          prev[0].subnetId === snapshot.subnetId &&
          prev[0].interNodeComm === snapshot.interNodeComm &&
          prev[0].startTaskCmd === snapshot.startTaskCmd &&
          prev[0].maxRetryCount === snapshot.maxRetryCount &&
          prev[0].waitForSuccess === snapshot.waitForSuccess &&
          prev[0].smartMode === snapshot.smartMode;
        if (dupOfLatest) return prev;
        return [snapshot, ...prev].slice(0, POOL_TEMPLATES_MAX);
      });

      // Persist as new defaults if the operator opted in.
      if (saveAsDefault) {
        persistDefaultsFromForm();
        store.addNotification({
          type: "success",
          message: "Pool defaults updated",
          autoDismissMs: 4000,
        });
      }
    } catch (e) {
      // Distinguish operator-driven abort from real errors so we don't
      // surface a scary banner for "I clicked Stop".
      const aborted =
        controller.signal.aborted ||
        (e instanceof DOMException && e.name === "AbortError");
      if (aborted) {
        auditLog.record({
          actor,
          action: smartMode ? "create_pools_smart:cancel" : "create_pools:cancel",
          target: submitTarget,
          status: "success",
          details: { accountIds: Array.from(selectedAccountIds) },
        });
        store.addNotification({
          type: "info",
          message: "Pool creation cancelled",
          autoDismissMs: 3000,
        });
        setCreationAnnouncement("Pool creation cancelled by operator.");
      } else {
        const message =
          e instanceof Error ? e.message : "Unknown pool-creation error";
        if (e instanceof SyntaxError) {
          setConfigError(`Invalid JSON: ${message}`);
        } else if (e instanceof Error) {
          setConfigError(message);
        }
        auditLog.record({
          actor,
          action: smartMode ? "create_pools_smart:result" : "create_pools:result",
          target: submitTarget,
          status: "failure",
          error: message,
          details: { accountIds: Array.from(selectedAccountIds), smartMode },
        });
        setCreationAnnouncement(`Pool creation failed: ${message}`);
      }
    } finally {
      setIsRunning(false);
      if (submitAbortRef.current === controller) {
        submitAbortRef.current = null;
      }
    }
  }, [
    orchestrator,
    selectedAccountIds,
    poolConfigJson,
    smartMode,
    smartVmSizes,
    startTaskCmd,
    envVars,
    maxRetryCount,
    waitForSuccess,
    poolDefaults,
    poolIdInput,
    osCategory,
    resizeTimeoutMin,
    interNodeComm,
    subnetId,
    saveAsDefault,
    persistDefaultsFromForm,
    setTemplates,
    primaryAccount?.username,
    liveCatalogEffective,
    state.accounts,
    store,
  ]);

  // Load a saved template into the wizard. Replaces every field the
  // template captured; leaves account picks alone (different runs target
  // different accounts even when the config is identical).
  const loadTemplate = React.useCallback(
    (t: PoolTemplate) => {
      setPoolIdInput(t.poolIdPrefix);
      setOsCategory(t.osCategory);
      setResizeTimeoutMin(t.resizeTimeoutMin);
      setSubnetId(t.subnetId);
      setInterNodeComm(t.interNodeComm);
      setStartTaskCmd(t.startTaskCmd);
      setMaxRetryCount(t.maxRetryCount);
      setWaitForSuccess(t.waitForSuccess);
      setEnvVars(t.envVars.map((ev) => ({ name: ev.name, value: ev.value })));
      setSmartMode(t.smartMode);
      setSmartVmSizes([...t.smartVmSizes]);
      store.addNotification({
        type: "info",
        message: `Loaded template "${t.name}"`,
        autoDismissMs: 2500,
      });
    },
    [store],
  );

  const deleteTemplate = React.useCallback(
    (id: string) => {
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    },
    [setTemplates],
  );

  const handleRetryFailedPools = React.useCallback(() => {
    const ids = store.retryFailedPools();
    store.addNotification({
      type: "info",
      message: `Retrying ${ids.length} failed pool(s)...`,
      autoDismissMs: 5000,
    });
  }, [store]);

  const failedPoolCount = state.pools.filter(
    (p) => p.provisioningState === "failed",
  ).length;

  // Loading state: store hasn't been hydrated with any accounts yet.
  const accountsLoading = state.accounts.length === 0;

  // Pre-submit summary numbers for confirmation dialog.
  //
  // BUG FIX: previously `targetVmCount` was always `getAllVmSizes().length`
  // in smart mode (5), ignoring the operator's LiveVmSizeSelect picks.
  // The planning count and the dispatched `vmSizes` array therefore
  // disagreed whenever the operator narrowed Smart Mode to e.g. just
  // ND40rs_v2 + H100_v5 — they'd see "5 VM sizes · 30 pools planned"
  // in the confirm dialog but only 2 SKUs would actually be tried.
  // Now uses the same liveCatalogEffective-aware resolution that the
  // submit path uses, so the displayed number matches reality.
  const effectiveSmartVmCount =
    liveCatalogEffective && smartVmSizes.length > 0
      ? smartVmSizes.length
      : getAllVmSizes().length;
  const targetVmCount = smartMode ? effectiveSmartVmCount : 1;
  const totalPoolsPlanned = selectedAccountIds.size * targetVmCount;
  const targetNodesPerPool = smartMode
    ? "fill remaining LP quota"
    : (() => {
        try {
          const cfg = JSON.parse(poolConfigJson);
          return String(cfg.targetLowPriorityNodes ?? 0);
        } catch {
          return "?";
        }
      })();

  // Tally selected accounts by owning sub so the confirmation can call
  // out a cross-sub dispatch explicitly. An operator who didn't notice
  // they ticked accounts from two different subs really wants this
  // visible before they press Create — once the request leaves the UI
  // there's no rollback path.
  const selectedAccountsBySub = React.useMemo(() => {
    const byId = new Map(state.accounts.map((a) => [a.id, a] as const));
    const map = new Map<string, number>();
    selectedAccountIds.forEach((id) => {
      const acc = byId.get(id);
      const subId = acc?.subscriptionId ?? "(unknown)";
      map.set(subId, (map.get(subId) ?? 0) + 1);
    });
    return Array.from(map.entries()).map(([subId, count]) => {
      const sub = state.subscriptions.find((s) => s.subscriptionId === subId);
      return {
        subId,
        count,
        displayName: sub?.displayName ?? subId.slice(0, 8) + "…",
        ownerAccountLabel: sub?.ownerAccountLabel,
      };
    });
  }, [selectedAccountIds, state.accounts, state.subscriptions]);
  const crossSubDispatch = selectedAccountsBySub.length > 1;

  // ---- Attack-surface preview (corpus-grounded warnings) ----
  // Recomputed on every relevant field change — cheap (constant work in
  // the number of envVars / start-task length). Rendered on the Review
  // pane so the operator sees it before pressing Create.
  const attackSurfaceFindings = React.useMemo(
    () =>
      analyzeAttackSurface({
        subnetId,
        startTaskCmd,
        // The submit path hardcodes admin elevation in handleCreate;
        // keep the analyzer in sync with that source of truth.
        elevationLevel: "admin",
        envVars,
        smartMode,
        selectedAccountCount: selectedAccountIds.size,
        crossSubDispatch,
      }),
    [
      subnetId,
      startTaskCmd,
      envVars,
      smartMode,
      selectedAccountIds.size,
      crossSubDispatch,
    ],
  );
  const worstSeverity = React.useMemo<
    "info" | "warning" | "destructive" | null
  >(() => {
    if (attackSurfaceFindings.some((f) => f.severity === "destructive"))
      return "destructive";
    if (attackSurfaceFindings.some((f) => f.severity === "warning"))
      return "warning";
    if (attackSurfaceFindings.length > 0) return "info";
    return null;
  }, [attackSurfaceFindings]);

  // ---- Sanitized PUT-body preview ----
  // Mirrors the exact body the submit path constructs (smart-mode and
  // manual-JSON). Secret-shaped env vars are redacted in the preview so
  // the operator can copy/paste the body into a ticket without leaking
  // creds. The vmSize is a placeholder in smart mode because the SKU is
  // picked per-account at dispatch time.
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const putBodyPreview = React.useMemo(() => {
    return buildPutBodyPreview({
      smartMode,
      poolIdInput,
      poolConfigJson,
      resizeTimeoutMin,
      subnetId,
      interNodeComm,
      startTaskCmd,
      envVars,
      maxRetryCount,
      waitForSuccess,
      poolDefaults,
      smartVmSizes,
      smartVmCount: effectiveSmartVmCount,
    });
  }, [
    smartMode,
    poolIdInput,
    poolConfigJson,
    resizeTimeoutMin,
    subnetId,
    interNodeComm,
    startTaskCmd,
    envVars,
    maxRetryCount,
    waitForSuccess,
    poolDefaults,
    smartVmSizes,
    effectiveSmartVmCount,
  ]);
  const previewJsonString = React.useMemo(
    () => JSON.stringify(putBodyPreview.body, null, 2),
    [putBodyPreview],
  );

  const confirmMessage = (
    <div className="space-y-2 text-sm leading-relaxed">
      <p className="m-0">
        Create <strong className="text-foreground">{totalPoolsPlanned}</strong>{" "}
        pool(s) across{" "}
        <strong className="text-foreground">{selectedAccountIds.size}</strong>{" "}
        account(s)
        {crossSubDispatch && (
          <>
            {" "}from{" "}
            <strong className="text-foreground">
              {selectedAccountsBySub.length} subscriptions
            </strong>
          </>
        )}
        {smartMode && (
          <>
            , trying up to{" "}
            <strong className="text-foreground">{targetVmCount}</strong> VM
            size(s) per account in priority order
          </>
        )}
        .
      </p>
      {crossSubDispatch && (
        <div className="rounded-md border border-border bg-surface-sunken/60 px-3 py-2 text-xs">
          <div className="font-semibold text-foreground">
            Per-subscription breakdown
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {selectedAccountsBySub.map((row) => (
              <li key={row.subId}>
                <span className="text-foreground">{row.displayName}</span>
                {row.ownerAccountLabel && (
                  <span> · {row.ownerAccountLabel}</span>
                )}
                : <strong className="text-foreground">{row.count}</strong>{" "}
                account{row.count === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-2xs leading-relaxed">
            Pool dispatch uses a per-account Batch token so accounts owned by
            different AAD identities can be hit in the same run.
          </p>
        </div>
      )}
      <p className="m-0">
        Target nodes per pool:{" "}
        <strong className="text-foreground">{targetNodesPerPool}</strong>{" "}
        (low-priority).
      </p>
      {saveAsDefault && (
        <p className="m-0 text-info">
          Settings will also be saved as your pool defaults.
        </p>
      )}
      <p className="m-0 text-muted-foreground">
        This action will create live Azure resources. Continue?
      </p>
    </div>
  );

  const handleRetryDecrement = () => {
    setMaxRetryCount((n) => Math.max(0, n - 1));
  };
  const handleRetryIncrement = () => {
    setMaxRetryCount((n) => Math.min(100, n + 1));
  };
  const handleRetryChange = (raw: string) => {
    if (raw === "") {
      setMaxRetryCount(0);
      return;
    }
    const n = parseInt(raw, 10);
    if (isNaN(n)) {
      setMaxRetryCount(0);
      return;
    }
    setMaxRetryCount(Math.max(0, Math.min(100, n)));
  };

  const handlePoolIdChange = (v: string) => {
    setPoolIdInput(v);
    if (poolIdError) {
      setPoolIdError(validatePoolId(v));
    }
  };

  const handleSubnetChange = (v: string) => {
    setSubnetId(v);
    if (subnetError) {
      setSubnetError(validateSubnetId(v));
    }
  };

  // ---- Render --------------------------------------------------------------
  return (
    <div
      className="flex flex-col gap-4 py-4"
      role="region"
      aria-labelledby="pool-creation-heading"
    >
      <PageHeader
        title="Pool Creation"
        titleId="pool-creation-heading"
        description="Provision GPU pools across selected Azure Batch accounts."
      >
        <TokenExpiryBadge
          secondsUntilExpiry={armTokenTracker.secondsUntilExpiry}
          loading={armTokenTracker.loading}
          onRefresh={() => void armTokenTracker.refresh()}
        />
        {failedPoolCount > 0 && !isRunning && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRetryFailedPools}
            aria-label={`Retry ${failedPoolCount} failed pools`}
          >
            <RotateCw className="h-3.5 w-3.5" />
            Retry Failed Pools ({failedPoolCount})
          </Button>
        )}
      </PageHeader>

      <Tabs
        value={currentStep}
        onValueChange={(value) => goToStep(value as StepKey)}
        orientation="horizontal"
      >
        {/* Step strip — AnimatedTabs renders the sliding gradient pill;
            the outer Tabs root continues to drive panel visibility via
            TabsContent below. `disabled` mirrors the previous reachability
            gate (idx 0 is always reachable, others require their own
            validity to pass). Step number prefixes labels for continuity. */}
        <AnimatedTabs
          size="sm"
          aria-label="Pool creation steps"
          value={currentStep}
          onChange={(id) => goToStep(id as StepKey)}
          tabs={STEPS.map((step, idx) => {
            const Icon = step.icon;
            const reachable = idx === 0 || stepValidity[step.key];
            const isCurrent = step.key === currentStep;
            const isComplete =
              !isCurrent && idx < currentIndex && stepValidity[step.key];
            const isDisabled = !reachable && !isCurrent;
            const LeadIcon = isComplete ? Check : isDisabled ? Lock : Icon;
            return {
              id: step.key,
              disabled: isDisabled,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <LeadIcon className="h-3.5 w-3.5" aria-hidden />
                  <span className="text-2xs font-semibold uppercase tracking-wider tabular-nums opacity-80">
                    {idx + 1}
                  </span>
                  <span>{step.label}</span>
                </span>
              ),
            };
          })}
        />

        {/* -------- Target step -------- */}
        <TabsContent value="target" className="flex flex-col gap-3">
          {/* Hidden file input — clicked by the "Import" button below.
              Lives at the top of the panel so it's available regardless
              of whether `templates.length > 0` (an org member with an
              empty cache needs to be able to import a shared file). */}
          <input
            ref={importTemplatesRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportTemplatesFile(file);
              // Reset so the same file can be re-selected.
              e.target.value = "";
            }}
          />
          <div
            className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border bg-surface-sunken/40 p-2"
            role="group"
            aria-label="Saved pool templates"
          >
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Templates
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={saveCurrentAsTemplate}
              disabled={poolIdInput.trim().length === 0}
              aria-label="Save current wizard form as a template (Ctrl+S)"
              title="Save current wizard form (Ctrl+S)"
              className="gap-1.5"
            >
              <Save className="h-3.5 w-3.5" aria-hidden />
              Save current
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={exportTemplates}
              disabled={templates.length === 0}
              aria-label="Export saved templates as JSON"
              title="Export saved templates as JSON (sharable across the org)"
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Export
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => importTemplatesRef.current?.click()}
              aria-label="Import shared templates from a JSON file"
              title="Import templates from a JSON file (the schema is the same as Export)"
              className="gap-1.5"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden />
              Import
            </Button>
            {templates.length === 0 && (
              <span className="text-2xs italic text-muted-foreground">
                No templates yet — save one with the button above or import
                a JSON file shared by a teammate.
              </span>
            )}
          </div>
          {templates.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border bg-surface-sunken/40 p-2"
              role="group"
              aria-label="Saved pool templates"
            >
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Templates
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Load a saved pool template (${templates.length} available)`}
                    className="gap-1.5"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                    Load template
                    <span className="ml-1 rounded-full bg-muted px-1.5 text-2xs font-semibold tabular-nums text-muted-foreground">
                      {templates.length}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-72 w-[min(28rem,80vw)] overflow-y-auto"
                >
                  <DropdownMenuLabel>
                    Last {templates.length} successful config(s)
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {templates.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-start gap-2 px-2 py-1.5 hover:bg-accent/40"
                    >
                      <button
                        type="button"
                        onClick={() => loadTemplate(t)}
                        className="flex flex-1 flex-col items-start gap-0.5 text-left focus-visible:outline-none"
                        aria-label={`Load template ${t.name}`}
                      >
                        <span className="text-xs font-semibold text-foreground">
                          {t.name}
                        </span>
                        <span className="text-2xs text-muted-foreground">
                          {new Date(t.savedAt).toLocaleString()} ·{" "}
                          {t.smartMode ? "smart" : "manual"} · {t.osCategory}
                        </span>
                        <span className="line-clamp-1 max-w-full font-mono text-3xs text-muted-foreground">
                          {t.startTaskCmd}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteTemplate(t.id)}
                        aria-label={`Delete template ${t.name}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="text-2xs text-muted-foreground">
                Auto-saved after each successful dispatch (last{" "}
                {POOL_TEMPLATES_MAX}). Loads every field except account picks.
              </span>
            </div>
          )}

          {state.subscriptions.length > 0 && (
            <div className="flex max-w-[28rem] flex-col gap-1.5">
              <Label htmlFor={subscriptionFieldId}>
                Subscriptions
                {selectedSubIds.length > 0 && (
                  <span className="ml-2 text-2xs font-normal text-muted-foreground">
                    ({selectedSubIds.length} selected)
                  </span>
                )}
              </Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    id={subscriptionFieldId}
                    aria-label="Azure subscriptions filter"
                    className="justify-between"
                  >
                    <span className="truncate">
                      {selectedSubIds.length === 0
                        ? "All subscriptions"
                        : selectedSubIds.length === 1
                          ? state.subscriptions.find(
                              (s) => s.subscriptionId === selectedSubIds[0],
                            )?.displayName ?? selectedSubIds[0]
                          : `${selectedSubIds.length} subscriptions`}
                    </span>
                    <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-2xs font-semibold text-primary">
                      {selectedSubIds.length || "All"}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-72 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto"
                >
                  <DropdownMenuLabel>Filter accounts by sub</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {(() => {
                    // Group by owning AAD account so an operator with
                    // multiple signed-in accounts can disambiguate subs
                    // that share a tenant. Single-account setups render
                    // unchanged (no group headers when only one owner).
                    const groups = new Map<
                      string,
                      typeof state.subscriptions
                    >();
                    for (const s of state.subscriptions) {
                      const k =
                        s.ownerAccountLabel ||
                        s.homeAccountId ||
                        "Active account";
                      const arr = groups.get(k) ?? [];
                      arr.push(s);
                      groups.set(k, arr);
                    }
                    const entries = Array.from(groups.entries());
                    const showHeaders = entries.length > 1;
                    return entries.flatMap(([owner, subs]) => {
                      const items: React.ReactNode[] = [];
                      if (showHeaders) {
                        items.push(
                          <DropdownMenuLabel
                            key={`hdr-${owner}`}
                            className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                          >
                            {owner}
                          </DropdownMenuLabel>,
                        );
                      }
                      for (const s of subs) {
                        const checked = selectedSubIds.includes(
                          s.subscriptionId,
                        );
                        const isAmbiguous = ambiguousSubIds.has(
                          s.subscriptionId,
                        );
                        items.push(
                          <DropdownMenuCheckboxItem
                            key={s.subscriptionId}
                            checked={checked}
                            onSelect={(e) => e.preventDefault()}
                            onCheckedChange={() =>
                              toggleSubSelection(s.subscriptionId)
                            }
                          >
                            <span className="font-medium">
                              {s.displayName}
                            </span>
                            <span className="ml-2 font-mono text-2xs text-muted-foreground">
                              {s.subscriptionId.substring(0, 8)}
                              &hellip;
                            </span>
                            {isAmbiguous && s.homeAccountId && (
                              <span
                                className="ml-2 inline-flex items-center rounded-sm bg-warning/15 px-1 text-2xs font-mono text-warning"
                                title={`Disambiguator: homeAccountId ${s.homeAccountId}`}
                              >
                                acct {s.homeAccountId.slice(0, 6)}…
                              </span>
                            )}
                          </DropdownMenuCheckboxItem>,
                        );
                      }
                      return items;
                    });
                  })()}
                </DropdownMenuContent>
              </DropdownMenu>
              {autoSelectedSubscription && selectedSubIds.length === 1 && (
                <span className="text-2xs text-muted-foreground">
                  Auto-selected your only subscription
                </span>
              )}
              {selectedSubIds.length === 0 &&
                state.subscriptions.length > 1 && (
                  <span className="text-2xs text-muted-foreground">
                    Showing accounts from all {state.subscriptions.length}{" "}
                    subscriptions. Pick one or more to narrow the list.
                  </span>
                )}
              {selectedSubIds.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1" aria-label="Selected subscriptions">
                  {selectedSubIds.map((id) => {
                    const sub = state.subscriptions.find(
                      (s) => s.subscriptionId === id,
                    );
                    const isAmbiguous = ambiguousSubIds.has(id);
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground"
                        title={`subscriptionId ${id}${sub?.homeAccountId ? ` · homeAccountId ${sub.homeAccountId}` : ""}`}
                      >
                        <span className="font-medium">
                          {sub?.displayName ?? id.slice(0, 8) + "…"}
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {id.slice(0, 8)}…
                        </span>
                        {sub?.ownerAccountLabel && (
                          <span className="text-muted-foreground">
                            · {sub.ownerAccountLabel}
                          </span>
                        )}
                        {isAmbiguous && sub?.homeAccountId && (
                          <span className="font-mono text-warning">
                            (acct {sub.homeAccountId.slice(0, 6)}…)
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleSubSelection(id)}
                          className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          aria-label={`Remove ${sub?.displayName ?? id}`}
                        >
                          <span aria-hidden>x</span>
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Discover-accounts action bar. Always rendered so the operator
              can re-pull at any time (handy when a sub was just signed in
              or when accounts were created outside this UI). */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken/40 p-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDiscoverAccounts}
              disabled={
                discoverProgress !== null &&
                discoverProgress.completed < discoverProgress.total
              }
              loading={
                discoverProgress !== null &&
                discoverProgress.completed < discoverProgress.total
              }
              aria-label="Discover Batch accounts in selected subscriptions"
              className="gap-1.5"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden />
              {discoverProgress &&
              discoverProgress.completed < discoverProgress.total
                ? `Discovering ${discoverProgress.completed}/${discoverProgress.total}…`
                : selectedSubIds.length === 0
                  ? `Discover accounts (all ${state.subscriptions.length} subs)`
                  : `Discover accounts (${selectedSubIds.length} sub${selectedSubIds.length === 1 ? "" : "s"})`}
            </Button>
            <span className="text-2xs text-muted-foreground">
              Pulls Batch accounts from each selected subscription using its
              owning AAD identity — required when the page shows no accounts
              despite valid sign-ins.
            </span>
            {discoverProgress &&
              discoverProgress.completed === discoverProgress.total && (
                <span className="ml-auto text-2xs font-medium text-success">
                  ✓ Discovery complete (+{discoverProgress.importedTotal} new)
                </span>
              )}
          </div>
          {discoverError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="text-xs">
                Discovery error: {discoverError}
              </AlertDescription>
            </Alert>
          )}

          {accountsLoading ? (
            <div aria-busy="true">
              <SkeletonLoader variant="table" rows={4} columns={2} />
            </div>
          ) : eligibleAccountsRaw.length === 0 ? (
            <EmptyState
              icon={Server}
              title="No eligible accounts"
              description={
                state.subscriptions.length > 0
                  ? "Click Discover accounts above to pull Batch accounts from your selected subscriptions, or provision new ones via the Account Provisioning page."
                  : "Sign in to an Azure account before creating pools."
              }
              action={
                state.subscriptions.length > 0
                  ? {
                      label: "Discover accounts",
                      onClick: handleDiscoverAccounts,
                      icon: RotateCw,
                      loading:
                        discoverProgress !== null &&
                        discoverProgress.completed < discoverProgress.total,
                    }
                  : undefined
              }
            />
          ) : (
            <>
              {/* Summary stats over the currently-filtered eligible set.
                  Refreshes as the operator types in the search box or
                  toggles the LP-quota filter, so the numbers always match
                  the rows actually visible in the table below. */}
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="Eligible-accounts summary"
              >
                <SummaryStatItem
                  label="Eligible"
                  value={eligibleAccounts.length}
                  hint={
                    eligibleAccounts.length === eligibleAccountsRaw.length
                      ? undefined
                      : `of ${eligibleAccountsRaw.length}`
                  }
                  compact
                />
                <SummaryStatItem
                  label="With free LP"
                  value={accountStats.withFreeLp}
                  tone={accountStats.withFreeLp > 0 ? "success" : "muted"}
                  compact
                />
                <SummaryStatItem
                  label="Free LP cores"
                  value={accountStats.totalFreeLp}
                  tone={accountStats.totalFreeLp > 0 ? "info" : "muted"}
                  compact
                />
                <SummaryStatItem
                  label="Selected"
                  value={selectedAccountIds.size}
                  tone={selectedAccountIds.size > 0 ? "info" : "muted"}
                  hint={
                    selectedAccountIds.size > 0
                      ? `${selectedStats.totalFreeLp.toLocaleString()} LP cores`
                      : undefined
                  }
                  compact
                />
              </div>

              {/* Filter toolbar — search + region filter + LP gate + bulk
                  actions. All filters compose; "Clear filters" wipes them
                  in one click. Bulk actions operate on the FILTERED set
                  so the operator can narrow first, then "Select all". */}
              <div
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2"
                role="toolbar"
                aria-label="Account filters and bulk actions"
              >
                <div className="relative w-full max-w-[20rem]">
                  <Search
                    className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    placeholder="Search account, region, sub…"
                    value={accountSearch}
                    onChange={(e) => setAccountSearch(e.target.value)}
                    aria-label="Filter accounts by name, region, or subscription"
                    className="pl-7"
                  />
                </div>

                {availableRegions.length > 1 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label="Filter accounts by region"
                        className="gap-1.5"
                      >
                        Regions
                        {regionFilter.size > 0 && (
                          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-2xs font-semibold text-primary">
                            {regionFilter.size}
                          </span>
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      className="max-h-72 overflow-y-auto"
                    >
                      <DropdownMenuLabel>Filter by region</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {availableRegions.map((region) => (
                        <DropdownMenuCheckboxItem
                          key={region}
                          checked={regionFilter.has(region)}
                          onSelect={(e) => e.preventDefault()}
                          onCheckedChange={() => toggleRegionFilter(region)}
                        >
                          <span className="font-mono text-xs">{region}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-sunken/40 px-2 py-1 text-xs">
                  <Switch
                    checked={onlyAccountsWithFreeLp}
                    onCheckedChange={(checked) =>
                      setOnlyAccountsWithFreeLp(checked)
                    }
                    aria-label="Show only accounts with free low-priority cores"
                  />
                  <span>Only with free LP</span>
                  <InfoTooltip
                    side="top"
                    content="Hides accounts whose lowPriorityCoresFree is 0 or whose quota hasn't been refreshed yet. Useful before a Smart-mode dispatch — accounts with zero free LP yield no pools and only clutter the summary."
                  />
                </label>

                {(accountSearch ||
                  onlyAccountsWithFreeLp ||
                  regionFilter.size > 0) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearAllFilters}
                    aria-label="Clear all filters"
                    className="gap-1"
                  >
                    <Eraser className="h-3.5 w-3.5" />
                    Clear filters
                  </Button>
                )}

                <div
                  className="ml-auto flex flex-wrap items-center gap-1"
                  role="group"
                  aria-label="Bulk selection actions"
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={selectAllVisible}
                    disabled={eligibleAccounts.length === 0}
                    aria-label="Select all visible accounts"
                    title="Add every visible row to the selection"
                  >
                    Select all visible
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={selectVisibleWithFreeLp}
                    disabled={accountStats.withFreeLp === 0}
                    aria-label="Select visible accounts with free low-priority cores"
                    title="Add only the visible rows that report lowPriorityCoresFree > 0"
                  >
                    With free LP ({accountStats.withFreeLp})
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={invertVisibleSelection}
                    disabled={eligibleAccounts.length === 0}
                    aria-label="Invert visible selection"
                    title="Tick the unticked visible rows and untick the ticked ones"
                  >
                    Invert
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearAllSelection}
                    disabled={selectedAccountIds.size === 0}
                    aria-label="Clear selected accounts"
                    title="Untick every row, regardless of filter"
                  >
                    Clear ({selectedAccountIds.size})
                  </Button>
                </div>
              </div>

              {eligibleAccounts.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No accounts match the current filters"
                  description="Loosen the search, region picker, or 'Only with free LP' toggle to see more accounts."
                  size="compact"
                  action={{
                    label: "Clear filters",
                    onClick: clearAllFilters,
                    icon: Eraser,
                  }}
                />
              ) : (
                <DataTable<EligibleAccount>
                  tableId="pool-creation-eligible-accounts"
                  rows={eligibleAccounts}
                  columns={accountColumns}
                  rowKey={(row) => row.id}
                  selection={selectedAccountIds}
                  onSelectionChange={setSelectedAccountIds}
                  csvFileName="eligible-accounts.csv"
                  initialSort={{ column: "freeLp", direction: "desc" }}
                  empty={
                    <EmptyState
                      icon={Server}
                      title="No eligible accounts"
                      description="No accounts in this subscription match the eligibility filter."
                    />
                  }
                />
              )}
            </>
          )}

          {selectedAccountIds.size > 0 && (
            <Alert
              variant={
                selectedStats.totalFreeLp === 0 && selectedStats.staleCount === 0
                  ? "warning"
                  : "info"
              }
            >
              <AlertDescription>
                <strong className="text-foreground">
                  {selectedAccountIds.size}
                </strong>{" "}
                account(s) selected
                {selectedStats.staleCount === 0 && (
                  <>
                    {" "}—{" "}
                    <strong className="text-foreground">
                      {selectedStats.totalFreeLp.toLocaleString()}
                    </strong>{" "}
                    free LP cores total
                  </>
                )}
                {selectedStats.withZeroLp > 0 && (
                  <span className="ml-1 text-warning">
                    ({selectedStats.withZeroLp} with zero LP — Smart Mode will
                    skip them)
                  </span>
                )}
                {selectedStats.staleCount > 0 && (
                  <span className="ml-1 text-muted-foreground">
                    ({selectedStats.staleCount} with stale quota — re-run
                    Discover accounts for live numbers)
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}

          <div
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-md border p-3 transition-colors duration-200 ease-out motion-reduce:transition-none",
              smartMode
                ? "border-primary/40 bg-primary/5 shadow-sm"
                : "border-border bg-card",
            )}
          >
            <Lightbulb
              className={cn(
                "h-4 w-4 shrink-0",
                smartMode ? "text-primary" : "text-muted-foreground",
              )}
              aria-hidden
            />
            <Switch
              id={smartModeId}
              checked={smartMode}
              onCheckedChange={(checked) => setSmartMode(checked)}
              aria-label="Toggle smart mode for pool creation"
            />
            <Label
              htmlFor={smartModeId}
              className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-foreground"
            >
              Smart Mode
              <span
                className={cn(
                  "ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider",
                  smartMode
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                Recommended
              </span>
              <InfoTooltip
                side="top"
                content="ON: the orchestrator iterates the VM-size list (default 5 GPU SKUs, or your picks) and creates one pool per (account × SKU) that has free LP quota, sized to fill the remaining cores. OFF: you paste a single Azure Batch pool JSON spec and that exact pool is created on every selected account."
              />
            </Label>
            <span className="text-xs text-muted-foreground">
              {smartMode
                ? "Auto-fills LP quota across selected accounts"
                : "Manual JSON pool config"}
            </span>
            {smartMode && (
              <span className="ml-auto flex items-center gap-3 text-2xs tabular-nums text-muted-foreground">
                <span>
                  <strong className="text-foreground">
                    {selectedAccountIds.size}
                  </strong>{" "}
                  acct
                </span>
                <span aria-hidden>·</span>
                <span>
                  <strong className="text-foreground">
                    {effectiveSmartVmCount}
                  </strong>{" "}
                  VM size{effectiveSmartVmCount === 1 ? "" : "s"}
                </span>
                <span aria-hidden>·</span>
                <span>
                  <strong className="text-info">{totalPoolsPlanned}</strong>{" "}
                  pool{totalPoolsPlanned === 1 ? "" : "s"} planned
                </span>
              </span>
            )}
          </div>

          {smartMode && resizingPools.length > 0 && (
            <Alert variant="warning">
              <AlertDescription>
                {resizingPools.length} pool(s) are currently resizing. Pool
                creation is blocked until they finish.
              </AlertDescription>
            </Alert>
          )}

          {!targetStepValid && selectedAccountIds.size === 0 && (
            <p
              className="text-xs text-muted-foreground"
              id="target-step-hint"
            >
              Select at least one account to continue.
            </p>
          )}
        </TabsContent>

        {/* -------- Image step -------- */}
        <TabsContent value="image" className="flex flex-col gap-3">
          <div className="flex max-w-[28rem] flex-col gap-1.5">
            <Label
              htmlFor={osCategoryFieldId}
              className="inline-flex items-center gap-1.5"
            >
              OS Category
              <InfoTooltip
                side="top"
                content="Picks the node-agent SKU + the default image reference from your Pool Defaults. Switch to Windows for HPC/CUDA workloads that need WSL-free Windows Server, or stay on Linux for the cheaper, more common ND/NC GPU SKUs."
              />
            </Label>
            <Select
              value={osCategory}
              onValueChange={(v) =>
                setOsCategory(v as "linux" | "windows")
              }
            >
              <SelectTrigger
                id={osCategoryFieldId}
                aria-label="Operating system category"
              >
                <SelectValue placeholder="Select OS" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="linux">Linux</SelectItem>
                <SelectItem value="windows">Windows</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              Image is taken from your pool defaults: Ubuntu 22.04 / Windows
              Server 2022. Edit images on the Pool Defaults page.
            </span>
          </div>

          {smartMode && (
            <div
              className="flex flex-wrap items-center gap-2"
              aria-label="VM sizes used by smart mode"
            >
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                VM sizes
              </span>
              {/*
                Master wire toggle. When ON, the live VM-catalog picker
                appears and Smart Mode pulls SKU candidates from the
                cached Microsoft.Compute/skus catalog. When OFF, picker
                is hidden, the dispatch path falls through to the
                hardcoded 5-VM list — the pre-wire UX. Persisted in
                user preferences so the choice survives reloads.
              */}
              <label
                className={cn(
                  "flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-2xs font-medium",
                  catalogAvailability.available
                    ? "cursor-pointer text-muted-foreground hover:bg-muted/40"
                    : "cursor-not-allowed text-muted-foreground/50",
                )}
                title={
                  !catalogAvailability.available
                    ? "Live catalog cache is empty. Open the VM Catalog page to populate it (cached 7 days), then this toggle activates."
                    : liveCatalogEffective
                      ? `Live catalog is wired in (${catalogAvailability.count} SKUs cached). Click to disable and use the hardcoded 5-VM fallback.`
                      : "Live catalog is disabled. Click to enable the picker and pull from Microsoft.Compute/skus."
                }
              >
                <Switch
                  checked={liveCatalogEffective}
                  onCheckedChange={toggleLiveCatalog}
                  disabled={!catalogAvailability.available}
                  aria-label="Toggle live VM catalog"
                />
                Live catalog
                {catalogAvailability.available ? (
                  <span className="ml-1 text-2xs opacity-70 tabular-nums">
                    {catalogAvailability.count}
                  </span>
                ) : (
                  <span className="ml-1 text-2xs italic opacity-70">
                    not loaded
                  </span>
                )}
              </label>
              {/* Catalog freshness chip + manual refresh. The chip exposes
                  the cache `fetchedAt` so the operator can spot a stale
                  SKU set before dispatch; the button invalidates the
                  cached entry — repopulated by visiting /vm-catalog
                  (or by the next boot prefetch). */}
              {catalogAvailability.available && catalogAgeLabel && (
                <span
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-foreground"
                  title={`VM-catalog cache last refreshed ${catalogAgeLabel}. Cache TTL is 7 days for VM SKUs.`}
                  aria-label={`VM catalog last updated ${catalogAgeLabel}`}
                >
                  Last updated {catalogAgeLabel}
                </span>
              )}
              {subscriptionId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleRefreshCatalog}
                  aria-label="Refresh VM catalog cache"
                  title="Clears the cached SKU set for this subscription. Visit the VM Catalog page to repopulate."
                  className="h-7 gap-1 text-2xs text-muted-foreground"
                >
                  <RotateCw className="h-3 w-3" />
                  Refresh catalog
                </Button>
              )}
              {liveCatalogEffective && (
                <LiveVmSizeSelect
                  multi
                  value={smartVmSizes}
                  onChange={setSmartVmSizes}
                  subscriptionId={subscriptionId || undefined}
                  placeholder={`Default GPU set (${getAllVmSizes().length})`}
                  density="compact"
                />
              )}
              {liveCatalogEffective && smartVmSizes.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSmartVmSizes([])}
                  aria-label="Clear VM-size picks and fall back to the default GPU set"
                  title="Drops the picker selection so Smart Mode uses the default 5-VM GPU set"
                  className="gap-1 text-muted-foreground"
                >
                  <Eraser className="h-3.5 w-3.5" />
                  Reset to default
                </Button>
              )}
              {(() => {
                // Build a flat list with extra GPU-type info so we can
                // group + color by type. The two source branches mirror
                // the existing dispatch logic exactly so badges and the
                // submit path stay in sync.
                type BadgeItem = {
                  name: string;
                  isGpu: boolean;
                  gpuType: string;
                };
                const items: BadgeItem[] =
                  liveCatalogEffective && smartVmSizes.length > 0
                    ? smartVmSizes.map((name) => {
                        const info = getVmSizeInfo(name);
                        const isGpu =
                          info?.isGpu ??
                          /^Standard_(ND|NC|NV|NG)/i.test(name);
                        return {
                          name,
                          isGpu,
                          gpuType: info?.gpuType ?? "",
                        };
                      })
                    : getAllVmSizes().map((v) => ({
                        name: v.name,
                        isGpu: v.isGpu === true,
                        gpuType: v.gpuType ?? "",
                      }));

                // Group: known GPU types first (H100 → A100 → V100 → other),
                // CPU/unknown last. Stable within each group.
                const order = ["H100", "A100", "V100"];
                const grouped = [
                  ...order.map((t) =>
                    items.filter((i) => i.gpuType === t),
                  ),
                  items.filter(
                    (i) => i.isGpu && !order.includes(i.gpuType),
                  ),
                  items.filter((i) => !i.isGpu),
                ].filter((g) => g.length > 0);

                // Color rule: H100=default(primary), A100=info,
                // V100=secondary, other GPU=info, non-GPU=secondary.
                // Badge has no `primary` variant — `default` is the
                // primary-toned one in this design system.
                const variantFor = (it: BadgeItem) => {
                  if (!it.isGpu) return "secondary" as const;
                  if (it.gpuType === "H100") return "default" as const;
                  if (it.gpuType === "A100") return "info" as const;
                  if (it.gpuType === "V100") return "secondary" as const;
                  return "info" as const;
                };

                return grouped.map((group, gi) => (
                  <React.Fragment key={`grp-${gi}`}>
                    {gi > 0 && (
                      <span
                        aria-hidden
                        className="mx-0.5 h-4 w-px self-center bg-border"
                      />
                    )}
                    {group.map(({ name, isGpu, gpuType }) => (
                      <Badge
                        key={name}
                        variant={variantFor({ name, isGpu, gpuType })}
                        className="gap-1 font-mono text-2xs transition-colors duration-150 ease-out motion-reduce:transition-none"
                        aria-label={`${name}${
                          isGpu
                            ? `, GPU${gpuType ? ` ${gpuType}` : ""}`
                            : ""
                        }`}
                        title={
                          isGpu && gpuType
                            ? `${name} · ${gpuType}`
                            : name
                        }
                      >
                        {isGpu && <Cpu className="h-3 w-3" aria-hidden />}
                        <span>{name.replace("Standard_", "")}</span>
                        {isGpu && gpuType && (
                          <span className="rounded bg-background/40 px-1 text-[10px] font-bold tracking-wider">
                            {gpuType}
                          </span>
                        )}
                      </Badge>
                    ))}
                  </React.Fragment>
                ));
              })()}
            </div>
          )}
        </TabsContent>

        {/* -------- Scale step -------- */}
        <TabsContent value="scale" className="flex flex-col gap-3">
          {smartMode ? (
            <>
              <Alert variant="info">
                <AlertDescription className="leading-relaxed">
                  <strong className="text-foreground">Smart Mode:</strong>{" "}
                  Automatically fills all free LP quota across selected
                  accounts. Creates pools starting with ND40rs_v2, then
                  H100_v5, NC24s_v3, NC12s_v3, NC6s_v3.
                </AlertDescription>
              </Alert>

              <div className="flex max-w-[20rem] flex-col gap-1.5">
                <Label htmlFor={poolIdFieldId}>Pool ID</Label>
                <Input
                  id={poolIdFieldId}
                  ref={poolIdFieldRef}
                  value={poolIdInput}
                  onChange={(e) => handlePoolIdChange(e.target.value)}
                  aria-describedby={
                    poolIdError ? POOL_ID_ERROR_ID : `${poolIdFieldId}-desc`
                  }
                  aria-invalid={poolIdError ? true : undefined}
                  className={cn(
                    poolIdError &&
                      "border-destructive focus-visible:ring-destructive",
                  )}
                />
                {poolIdError ? (
                  <span
                    id={POOL_ID_ERROR_ID}
                    className="text-xs text-destructive"
                    role="alert"
                  >
                    {poolIdError}
                  </span>
                ) : (
                  <span
                    id={`${poolIdFieldId}-desc`}
                    className="text-xs text-muted-foreground"
                  >
                    1-64 chars, alphanumeric, underscore, hyphen.
                  </span>
                )}
              </div>

              <div className="flex max-w-[20rem] flex-col gap-1.5">
                <Label
                  htmlFor={resizeTimeoutFieldId}
                  className="inline-flex items-center gap-1.5"
                >
                  Resize timeout (minutes)
                  <InfoTooltip
                    side="top"
                    content="How long Batch waits for the requested nodes to allocate before giving up and marking the resize failed. Bump up for hot SKUs (H100, ND40rs_v2) where the regional pool can take several minutes to drain. Min 5, max 120."
                  />
                </Label>
                <Input
                  id={resizeTimeoutFieldId}
                  type="number"
                  min={5}
                  max={120}
                  value={String(resizeTimeoutMin)}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setResizeTimeoutMin(
                      isNaN(n) ? 15 : Math.max(5, Math.min(120, n)),
                    );
                  }}
                  className="tabular-nums"
                  aria-describedby={`${resizeTimeoutFieldId}-desc`}
                />
                <span
                  id={`${resizeTimeoutFieldId}-desc`}
                  className="text-2xs text-muted-foreground tabular-nums"
                >
                  Sent as <code className="font-mono">PT{resizeTimeoutMin}M</code> on
                  the pool spec.
                </span>
                {resizeTimeoutMin < 5 && (
                  <span
                    className="text-xs text-destructive"
                    role="alert"
                  >
                    Resize timeout must be at least 5 minutes.
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <Alert variant="warning">
                <AlertDescription>
                  Manual JSON mode. Note: targetDedicatedNodes will be forced
                  to 0 on submission. Only low-priority/spot nodes are used.
                </AlertDescription>
              </Alert>

              <div
                ref={jsonEditorContainerRef}
                tabIndex={-1}
                aria-describedby={
                  configError ? POOL_JSON_ERROR_ID : undefined
                }
                aria-invalid={configError ? true : undefined}
                className="flex flex-col gap-1.5 outline-none"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label
                    htmlFor={jsonEditorFieldId}
                    className="inline-flex items-center gap-1.5"
                  >
                    Pool Configuration (JSON)
                    <InfoTooltip
                      side="top"
                      content="A full Azure Batch pool definition. See learn.microsoft.com/rest/api/batchservice/pool/add for the schema. `targetDedicatedNodes` is force-zeroed on submit because this page only fans out LP/spot pools."
                    />
                    <span className="ml-1 text-2xs text-muted-foreground tabular-nums">
                      {poolConfigJson.length} chars
                    </span>
                  </Label>
                  <div
                    className="flex flex-wrap items-center gap-1"
                    role="group"
                    aria-label="JSON editor actions"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleJsonFormat}
                      aria-label="Format / pretty-print JSON"
                      title="Pretty-print (2-space indent)"
                      className="gap-1"
                    >
                      <FileCode className="h-3.5 w-3.5" />
                      Format
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleJsonCopy}
                      aria-label="Copy JSON config to clipboard"
                      title="Copy to clipboard"
                      className="gap-1"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleJsonDownload}
                      aria-label="Download JSON config as a file"
                      title="Download as .json"
                      className="gap-1"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleJsonReset}
                      aria-label="Reset JSON to the built-in default"
                      title="Reset to default template"
                      className="gap-1 text-muted-foreground"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      Reset
                    </Button>
                  </div>
                </div>
                <div
                  id={jsonEditorFieldId}
                  className="overflow-hidden rounded-md border border-border"
                >
                  <MonacoEditor
                    language="json"
                    value={poolConfigJson}
                    onChange={(value) => handleEditorChange(value ?? "")}
                    containerStyle={{ height: "300px" }}
                    editorOptions={{
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      lineNumbers: "on",
                      fontSize: 13,
                    }}
                  />
                </div>
                {configError && (
                  <span
                    id={POOL_JSON_ERROR_ID}
                    className="text-xs text-destructive"
                    role="alert"
                  >
                    {configError}
                  </span>
                )}
              </div>
            </>
          )}
        </TabsContent>

        {/* -------- Networking step -------- */}
        <TabsContent value="networking" className="flex flex-col gap-3">
          <div className="flex max-w-[44rem] flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label
                htmlFor={subnetFieldId}
                className="inline-flex items-center gap-1.5"
              >
                Subnet ID (optional)
                <InfoTooltip
                  side="top"
                  content="Full ARM resource ID of an existing subnet. The subnet must live in the same region as each target Batch account, have enough IPs for the planned nodes, and grant Batch the 'Microsoft.Network/virtualNetworks/subnets/join/action' role. Leave blank for default (public) networking."
                />
              </Label>
              <div
                className="flex items-center gap-1"
                role="group"
                aria-label="Subnet field actions"
              >
                {subnetId && (
                  <>
                    <CopyButton
                      value={subnetId}
                      ariaLabel="Copy subnet ID"
                      alwaysVisible
                      iconSize={14}
                      className="h-7 w-7"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSubnetId("");
                        setSubnetError(null);
                      }}
                      aria-label="Clear subnet ID"
                      className="gap-1"
                    >
                      <Eraser className="h-3.5 w-3.5" />
                      Clear
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      if (
                        typeof navigator !== "undefined" &&
                        navigator.clipboard?.readText
                      ) {
                        const text = await navigator.clipboard.readText();
                        const trimmed = text.trim();
                        if (trimmed) {
                          handleSubnetChange(trimmed);
                        }
                      }
                    } catch {
                      // Clipboard permission denied — leave the field as-is.
                    }
                  }}
                  aria-label="Paste subnet ID from clipboard"
                  title="Paste from clipboard (the clipboard text is trimmed and validated)"
                  className="gap-1"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Paste
                </Button>
              </div>
            </div>
            <Input
              id={subnetFieldId}
              ref={subnetFieldRef}
              value={subnetId}
              onChange={(e) => handleSubnetChange(e.target.value)}
              placeholder="/subscriptions/.../subnets/<name>"
              className={cn(
                "font-mono text-[13px]",
                subnetError &&
                  "border-destructive focus-visible:ring-destructive",
              )}
              aria-describedby={
                subnetError ? `${subnetFieldId}-error` : `${subnetFieldId}-desc`
              }
              aria-invalid={subnetError ? true : undefined}
            />
            {subnetError ? (
              <span
                id={`${subnetFieldId}-error`}
                className="text-xs text-destructive"
                role="alert"
              >
                {subnetError}
              </span>
            ) : (
              <span
                id={`${subnetFieldId}-desc`}
                className="text-xs text-muted-foreground"
              >
                Leave blank to skip vnet integration. Expected:{" "}
                <code className="rounded bg-surface-sunken px-1 font-mono text-2xs">
                  /subscriptions/&lt;guid&gt;/resourceGroups/&lt;rg&gt;/providers/Microsoft.Network/virtualNetworks/&lt;vnet&gt;/subnets/&lt;name&gt;
                </code>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id={interNodeCommId}
              checked={interNodeComm}
              onCheckedChange={(checked) => setInterNodeComm(checked)}
              aria-label="Enable inter-node communication"
            />
            <Label
              htmlFor={interNodeCommId}
              className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-foreground"
            >
              Inter-node communication{" "}
              <span className="text-xs text-muted-foreground">
                {interNodeComm ? "On" : "Off"}
              </span>
              <InfoTooltip
                side="top"
                content="Allocates nodes that can reach each other on a private VNet — required for MPI / multi-node training jobs. Reduces the pool's max size (Batch limits inter-node pools more aggressively) and may exclude some VM SKUs."
              />
            </Label>
          </div>
        </TabsContent>

        {/* -------- Tasks step -------- */}
        <TabsContent value="tasks" className="flex flex-col gap-3">
          <div className="flex max-w-[44rem] flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label
                htmlFor={startTaskFieldId}
                className="inline-flex items-center gap-1.5"
              >
                Start Task command line
                <InfoTooltip
                  side="top"
                  content="Shell command executed on every node when the pool starts. Runs as the autoUser identity (admin scope) before the node accepts any user tasks. Failures here either retry (waitForSuccess=false) or mark the node unusable (waitForSuccess=true)."
                />
              </Label>
              <div
                className="flex flex-wrap items-center gap-1"
                role="group"
                aria-label="Start task actions"
              >
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label="Load a start-task preset"
                      className="gap-1.5"
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      Presets
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="max-h-72 w-80 overflow-y-auto"
                  >
                    <DropdownMenuLabel>Start-task presets</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {START_TASK_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyStartTaskPreset(preset)}
                        className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:outline-none"
                      >
                        <span className="text-xs font-semibold text-foreground">
                          {preset.label}
                        </span>
                        <span className="text-2xs leading-relaxed text-muted-foreground">
                          {preset.description}
                        </span>
                        <code className="mt-0.5 block w-full truncate rounded bg-surface-sunken px-1 py-0.5 font-mono text-3xs text-muted-foreground">
                          {preset.commandLine}
                        </code>
                      </button>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <CopyButton
                  value={startTaskCmd}
                  ariaLabel="Copy start-task command"
                  alwaysVisible
                  iconSize={14}
                  className="h-7 w-7"
                />
                {startTaskCmd.trim().length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setStartTaskCmd("")}
                    aria-label="Clear start-task command"
                    className="gap-1"
                  >
                    <Eraser className="h-3.5 w-3.5" />
                    Clear
                  </Button>
                )}
              </div>
            </div>
            <textarea
              id={startTaskFieldId}
              ref={startTaskFieldRef}
              rows={6}
              value={startTaskCmd}
              onChange={(e) => setStartTaskCmd(e.target.value)}
              placeholder='/bin/bash -c "apt-get update && echo setup done"'
              aria-describedby={
                tasksStepValid
                  ? `${startTaskFieldId}-desc`
                  : `${startTaskFieldId}-error`
              }
              aria-invalid={tasksStepValid ? undefined : true}
              className={cn(
                "flex min-h-[120px] w-full rounded-md border border-input bg-surface-sunken px-3 py-2 font-mono text-[13px] text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
                !tasksStepValid &&
                  "border-destructive focus-visible:ring-destructive",
              )}
            />
            {tasksStepValid ? (
              <span
                id={`${startTaskFieldId}-desc`}
                className="text-xs text-muted-foreground"
              >
                Runs once on each node when the pool starts.{" "}
                <span className="tabular-nums">{startTaskCmd.length}</span>{" "}
                character
                {startTaskCmd.length === 1 ? "" : "s"}.
              </span>
            ) : (
              <span
                id={`${startTaskFieldId}-error`}
                className="text-xs text-destructive"
                role="alert"
              >
                Start task command is required.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="inline-flex items-center gap-1.5">
                Start Task environment variables
                <InfoTooltip
                  side="top"
                  content="Key/value pairs exported into the start-task shell. Available to the command via $NAME (Linux) or %NAME% (Windows). Sensitive values are stored in plain text in the pool definition — use a Key Vault reference or fetch at runtime for secrets."
                />
                {envVars.filter((ev) => ev.name.trim() !== "").length > 0 && (
                  <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-2xs font-semibold tabular-nums text-muted-foreground">
                    {envVars.filter((ev) => ev.name.trim() !== "").length}
                  </span>
                )}
                {envDuplicateNames.size > 0 && (
                  <span
                    className="ml-1 inline-flex h-5 items-center rounded-full bg-warning/15 px-1.5 text-2xs font-semibold text-warning"
                    title={`Duplicate names: ${Array.from(envDuplicateNames).join(", ")}`}
                  >
                    {envDuplicateNames.size} dup
                  </span>
                )}
                {envInvalidIndices.size > 0 && (
                  <span
                    className="ml-1 inline-flex h-5 items-center rounded-full bg-destructive/15 px-1.5 text-2xs font-semibold text-destructive"
                    title="One or more env-var names are not valid POSIX identifiers. Fix them before continuing."
                  >
                    {envInvalidIndices.size} invalid
                  </span>
                )}
              </Label>
              <div
                className="flex flex-wrap items-center gap-1"
                role="group"
                aria-label="Env vars bulk actions"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEnvPasteOpen((x) => !x);
                    setEnvPasteWarnings([]);
                  }}
                  aria-expanded={envPasteOpen}
                  aria-controls={envPasteFieldId}
                  className="gap-1"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Paste .env
                </Button>
                {envDuplicateNames.size > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={dedupeEnvVars}
                    aria-label="Remove duplicate env vars (keep last value)"
                    className="gap-1 text-warning hover:text-warning"
                  >
                    Dedupe
                  </Button>
                )}
                {envVars.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearAllEnvVars}
                    aria-label="Remove every environment variable"
                    className="gap-1 text-destructive hover:text-destructive"
                  >
                    <Eraser className="h-3.5 w-3.5" />
                    Clear all
                  </Button>
                )}
              </div>
            </div>

            {envPasteOpen && (
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken/40 p-2.5">
                <Label
                  htmlFor={envPasteFieldId}
                  className="text-xs font-medium text-foreground"
                >
                  Paste KEY=VALUE lines
                </Label>
                <textarea
                  id={envPasteFieldId}
                  rows={4}
                  value={envPasteText}
                  onChange={(e) => setEnvPasteText(e.target.value)}
                  placeholder={
                    "# Comment lines starting with # are ignored\n" +
                    'OMP_NUM_THREADS=8\n' +
                    'CUDA_VISIBLE_DEVICES="0,1"\n' +
                    "export TRANSFORMERS_CACHE=/mnt/batch/tasks/.cache"
                  }
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-2xs"
                  aria-describedby={`${envPasteFieldId}-desc`}
                />
                <span
                  id={`${envPasteFieldId}-desc`}
                  className="text-2xs text-muted-foreground"
                >
                  One `NAME=VALUE` per line. `export ` prefixes and `#` comments
                  are tolerated. Existing names get overwritten by the paste.
                </span>
                {envPasteWarnings.length > 0 && (
                  <ul className="m-0 list-disc space-y-0.5 pl-4 text-2xs text-warning">
                    {envPasteWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    onClick={handleEnvPasteApply}
                    disabled={envPasteText.trim().length === 0}
                    aria-label="Apply pasted environment variables"
                  >
                    Apply paste
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEnvPasteOpen(false);
                      setEnvPasteText("");
                      setEnvPasteWarnings([]);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {envVars.map((ev, idx) => {
              const isDup =
                ev.name.trim() !== "" && envDuplicateNames.has(ev.name);
              const isInvalid = envInvalidIndices.has(idx);
              const nameErrorId = `env-name-error-${idx}`;
              return (
                <div
                  key={idx}
                  className="flex flex-col gap-1"
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      placeholder="Name"
                      value={ev.name}
                      onChange={(e) =>
                        updateEnvVar(idx, "name", e.target.value)
                      }
                      aria-label={`Environment variable ${idx + 1} name`}
                      className={cn(
                        "w-[200px] font-mono text-[13px]",
                        isDup && "border-warning focus-visible:ring-warning",
                        isInvalid &&
                          "border-destructive focus-visible:ring-destructive",
                      )}
                      aria-invalid={isDup || isInvalid || undefined}
                      aria-describedby={isInvalid ? nameErrorId : undefined}
                      title={
                        isInvalid
                          ? "Invalid POSIX env name."
                          : isDup
                            ? "Duplicate name — only last wins on submit."
                            : undefined
                      }
                    />
                    <Input
                      placeholder="Value"
                      value={ev.value}
                      onChange={(e) =>
                        updateEnvVar(idx, "value", e.target.value)
                      }
                      aria-label={`Environment variable ${idx + 1} value`}
                      className="w-[400px] font-mono text-[13px]"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Remove"
                      aria-label={`Remove environment variable ${idx + 1}`}
                      onClick={() => removeEnvVar(idx)}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {isInvalid && (
                    <span
                      id={nameErrorId}
                      role="alert"
                      className="text-2xs text-destructive"
                    >
                      Invalid POSIX env name. Must start with a letter or
                      underscore, then contain only letters, digits, and
                      underscores.
                    </span>
                  )}
                </div>
              );
            })}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addEnvVar}
                className="mt-1"
              >
                <Plus />
                Add environment variable
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-6">
            <div className="flex w-[180px] flex-col gap-1.5">
              <Label
                htmlFor={retryFieldId}
                className="inline-flex items-center gap-1.5"
              >
                Max task retry count
                <InfoTooltip
                  side="top"
                  content="If the start task exits non-zero, Batch retries it this many times before marking the node unusable. Set to 0 for one-shot startup; bump up for flaky network-bound installs."
                />
              </Label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={handleRetryDecrement}
                  disabled={maxRetryCount <= 0}
                  aria-label="Decrement retry count"
                >
                  -
                </Button>
                <Input
                  id={retryFieldId}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={String(maxRetryCount)}
                  onChange={(e) => handleRetryChange(e.target.value)}
                  className="text-center tabular-nums"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={handleRetryIncrement}
                  disabled={maxRetryCount >= 100}
                  aria-label="Increment retry count"
                >
                  +
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id={waitForSuccessId}
                checked={waitForSuccess}
                onCheckedChange={(checked) => setWaitForSuccess(checked)}
                aria-label="Wait for start task success"
              />
              <Label
                htmlFor={waitForSuccessId}
                className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-foreground"
              >
                Wait for success{" "}
                <span className="text-xs text-muted-foreground">
                  {waitForSuccess ? "Yes" : "No"}
                </span>
                <InfoTooltip
                  side="top"
                  content="When ON, a node is held in the 'starting' state until its start task succeeds, so user tasks never run on a half-set-up node. When OFF, tasks may run before the start task finishes — useful when the start task is an opportunistic warm-up rather than a hard requirement."
                />
              </Label>
            </div>
          </div>
        </TabsContent>

        {/* -------- Review step -------- */}
        <TabsContent value="review" className="flex flex-col gap-3">
          {!allStepsValid && (
            <div className="flex flex-col gap-2">
              <ErrorState
                tone="warning"
                size="compact"
                icon={AlertCircle}
                message="Some earlier steps still need attention."
                detail={
                  firstInvalidStep
                    ? `First unresolved: ${
                        STEPS.find((s) => s.key === firstInvalidStep)?.label ??
                        firstInvalidStep
                      } step.`
                    : "Use the stepper above to revisit highlighted steps."
                }
              />
              {firstInvalidStep && (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => goToStep(firstInvalidStep)}
                    aria-label={`Jump to ${firstInvalidStep} step`}
                    className="gap-1.5"
                  >
                    Jump to{" "}
                    {STEPS.find((s) => s.key === firstInvalidStep)?.label}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="rounded-md border border-border bg-card p-4">
            <h2 className="m-0 mb-3 text-base font-semibold text-foreground">
              Review configuration
            </h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Accounts selected
                </dt>
                <dd className="m-0 font-medium tabular-nums">
                  {selectedAccountIds.size}
                  {crossSubDispatch && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-info/10 px-1.5 py-0.5 text-2xs font-semibold text-info">
                      {selectedAccountsBySub.length}-sub fan-out
                    </span>
                  )}
                </dd>
                {crossSubDispatch && (
                  <dd className="m-0 text-2xs text-muted-foreground">
                    {selectedAccountsBySub
                      .map((r) => `${r.displayName}: ${r.count}`)
                      .join(" · ")}
                  </dd>
                )}
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Mode
                </dt>
                <dd className="m-0 font-medium">
                  {smartMode ? "Smart fill" : "Manual JSON"}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  OS
                </dt>
                <dd className="m-0 font-medium capitalize">{osCategory}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Pool ID
                </dt>
                <dd className="m-0 font-mono text-xs">{poolIdInput}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Resize timeout
                </dt>
                <dd className="m-0 font-medium tabular-nums">
                  PT{resizeTimeoutMin}M
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Inter-node comm
                </dt>
                <dd className="m-0 font-medium">
                  {interNodeComm ? "On" : "Off"}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Subnet
                </dt>
                <dd className="m-0 font-mono text-xs">
                  {subnetId || "(none)"}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Start task
                </dt>
                <dd className="m-0 break-words font-mono text-xs">
                  {startTaskCmd}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Total pools planned
                </dt>
                <dd className="m-0 font-medium text-info tabular-nums">
                  {totalPoolsPlanned}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-2xs uppercase tracking-wider text-muted-foreground">
                  Env vars
                </dt>
                <dd className="m-0 font-medium tabular-nums">
                  {envVars.filter((ev) => ev.name.trim() !== "").length}
                </dd>
              </div>
            </dl>
          </div>

          {/* ------- Attack-surface preview -------
              Corpus-grounded warnings: detection cases come from
              `New folder\_analysis_netspi.md §I (IMDS Variants)` and
              `_analysis_netspi.md §III (App Service Token Theft)`.
              We DON'T block creation — only surface the shape so the
              operator sees it before pressing Create. */}
          {attackSurfaceFindings.length > 0 && (
            <div
              className={cn(
                "flex flex-col gap-2 rounded-md border p-3",
                worstSeverity === "destructive"
                  ? "border-destructive/40 bg-destructive/5"
                  : worstSeverity === "warning"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card",
              )}
              role="region"
              aria-label="Attack-surface preview"
            >
              <div className="flex items-center gap-2">
                <ShieldAlert
                  className={cn(
                    "h-4 w-4 shrink-0",
                    worstSeverity === "destructive"
                      ? "text-destructive"
                      : worstSeverity === "warning"
                        ? "text-warning"
                        : "text-info",
                  )}
                  aria-hidden
                />
                <h3 className="m-0 text-sm font-semibold text-foreground">
                  Attack-surface preview
                </h3>
                <Badge
                  variant={
                    worstSeverity === "destructive"
                      ? "destructive"
                      : worstSeverity === "warning"
                        ? "info"
                        : "secondary"
                  }
                  className="font-mono tabular-nums"
                >
                  {attackSurfaceFindings.length} finding
                  {attackSurfaceFindings.length === 1 ? "" : "s"}
                </Badge>
                <span className="ml-auto text-2xs text-muted-foreground">
                  What an attacker would see if these credentials leaked.
                </span>
              </div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {attackSurfaceFindings.map((finding) => (
                  <li
                    key={finding.id}
                    className={cn(
                      "rounded-md border px-3 py-2 text-xs leading-relaxed",
                      finding.severity === "destructive"
                        ? "border-destructive/40 bg-destructive/10"
                        : finding.severity === "warning"
                          ? "border-warning/40 bg-warning/10"
                          : "border-border bg-surface-sunken/60",
                    )}
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span
                        className={cn(
                          "text-2xs font-semibold uppercase tracking-wider",
                          finding.severity === "destructive"
                            ? "text-destructive"
                            : finding.severity === "warning"
                              ? "text-warning"
                              : "text-info",
                        )}
                      >
                        {finding.severity === "destructive"
                          ? "high"
                          : finding.severity}
                      </span>
                      <strong className="text-foreground">
                        {finding.title}
                      </strong>
                    </div>
                    <p className="m-0 mt-1 text-xs text-muted-foreground">
                      {finding.detail}
                    </p>
                    <p className="m-0 mt-1 text-3xs font-mono text-muted-foreground/70">
                      ref: {finding.cite}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ------- Sanitized PUT-body preview -------
              Shows the operator the exact body the submit path will
              construct, with secret-shaped env vars redacted so the
              preview can be copied into a ticket without leaking creds.
              In smart mode, vmSize is a placeholder because the SKU is
              picked per-account at dispatch time. */}
          <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <FileJson
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <h3 className="m-0 text-sm font-semibold text-foreground">
                Pool PUT body preview
              </h3>
              {putBodyPreview.redactedNames.length > 0 && (
                <Badge
                  variant="info"
                  className="font-mono tabular-nums"
                  title={`Redacted env-var names: ${putBodyPreview.redactedNames.join(", ")}`}
                >
                  {putBodyPreview.redactedNames.length} redacted
                </Badge>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPreviewOpen((v) => !v)}
                aria-expanded={previewOpen}
                aria-controls="pool-put-body-preview"
                className="ml-auto h-7 gap-1 text-2xs text-muted-foreground"
              >
                {previewOpen ? "Hide" : "Show"} preview
              </Button>
              {previewOpen && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      if (
                        typeof navigator !== "undefined" &&
                        navigator.clipboard?.writeText
                      ) {
                        await navigator.clipboard.writeText(previewJsonString);
                        store.addNotification({
                          type: "info",
                          message: "Preview JSON copied (secrets redacted).",
                          autoDismissMs: 2500,
                        });
                      }
                    } catch {
                      // ignore — clipboard permission denied
                    }
                  }}
                  aria-label="Copy preview JSON"
                  className="h-7 gap-1 text-2xs text-muted-foreground"
                >
                  <Copy className="h-3 w-3" /> Copy
                </Button>
              )}
            </div>
            {previewOpen ? (
              <pre
                id="pool-put-body-preview"
                className="m-0 max-h-[280px] overflow-auto rounded border border-border/60 bg-surface-sunken px-3 py-2 font-mono text-2xs leading-relaxed text-foreground"
                aria-label="Sanitized pool PUT body"
              >
                {previewJsonString}
              </pre>
            ) : (
              <span className="text-2xs text-muted-foreground">
                Click <em>Show preview</em> to inspect the exact body that will
                be PUT to each Batch account (vmSize is a placeholder in smart
                mode, secret-shaped env vars are redacted).
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id={saveAsDefaultId}
              checked={saveAsDefault}
              onCheckedChange={(checked) =>
                setSaveAsDefault(checked === true)
              }
              aria-label="Save these settings as defaults for future creates"
            />
            <Label
              htmlFor={saveAsDefaultId}
              className="cursor-pointer text-sm font-normal text-foreground"
            >
              Save as default for future creates
            </Label>
          </div>

          {configError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{configError}</AlertDescription>
            </Alert>
          )}
        </TabsContent>
      </Tabs>

      {/* -------- Step navigation -------- */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          onClick={handleBack}
          disabled={currentIndex === 0 || isRunning}
          title={
            currentIndex === 0
              ? "Already on the first step"
              : isRunning
                ? "Pool creation in progress"
                : undefined
          }
        >
          Back
        </Button>
        {currentStep !== "review" ? (
          <Button
            type="button"
            variant="default"
            onClick={handleContinue}
            disabled={!stepValidity[currentStep] || isRunning}
            className="min-w-[10rem] transition-colors duration-200 ease-out motion-reduce:transition-none"
            title={
              isRunning
                ? "Pool creation in progress"
                : !stepValidity[currentStep]
                  ? currentStep === "target"
                    ? "Select at least one account to continue."
                    : currentStep === "scale"
                      ? "Resolve the pool ID and resize timeout."
                      : currentStep === "networking"
                        ? "Subnet ID is invalid."
                        : currentStep === "tasks"
                          ? envHasInvalidNames
                            ? "Fix the invalid POSIX env-var name(s) to continue."
                            : "Start task command is required."
                          : "Resolve the highlighted issue to continue."
                  : undefined
            }
          >
            Continue
          </Button>
        ) : (
          <Button
            type="button"
            variant="default"
            onClick={handleSubmit}
            disabled={!allStepsValid || isRunning}
            className="min-w-[12rem] max-w-[20rem] transition-colors duration-200 ease-out motion-reduce:transition-none"
            title={
              isRunning
                ? "Pool creation in progress"
                : !allStepsValid
                  ? "One or more earlier steps still need attention."
                  : undefined
            }
          >
            {isRunning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {smartMode
                  ? "Creating pools (waiting for resize)..."
                  : "Creating Pools..."}
              </>
            ) : smartMode ? (
              "Create Pools (Smart Fill)"
            ) : (
              `Create Pools on ${selectedAccountIds.size} Accounts`
            )}
          </Button>
        )}
        {isRunning && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              // Abort the per-submit controller first so the catch-branch
              // can distinguish operator-cancel from a real error, then
              // call the orchestrator-wide cancel to mop up any per-agent
              // work that didn't receive our signal.
              submitAbortRef.current?.abort();
              orchestrator.cancel();
            }}
            aria-label="Stop pool creation"
            className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        )}
        <span
          className="ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground"
          title="Keyboard: Ctrl/Cmd + Enter advances the wizard, or opens the confirm dialog on the Review step."
        >
          <Keyboard className="h-3 w-3" aria-hidden />
          <kbd className="rounded border border-border bg-muted px-1 py-px font-mono text-3xs">
            Ctrl+Enter
          </kbd>
          <span>
            {currentStep === "review" ? "to create" : "to continue"}
          </span>
        </span>
      </div>

      {isRunning && (
        <div
          className="mt-2 flex flex-col gap-1.5"
          role="group"
          aria-labelledby="pool-creation-progress-label"
        >
          <span
            id="pool-creation-progress-label"
            className="text-xs font-medium text-foreground"
          >
            Creating pools...
          </span>
          <Progress indeterminate aria-label="Creating pools" />
        </div>
      )}

      {isRunning && (
        <PoolCreationLogPanel logs={state.agentLogs} />
      )}

      {state.pools.length > 0 && (
        <PoolResultsSection
          pools={state.pools}
          accounts={state.accounts}
        />
      )}

      {/* Visually-hidden ARIA-live region for assistive tech. Updated
          when `handleCreate` resolves (success / cancel / failure). The
          on-screen state is communicated by the PoolResultsSection
          badges; this is the audible equivalent for screen-reader users. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {creationAnnouncement}
      </div>

      <ConfirmationDialog
        hidden={confirmHidden}
        title="Confirm Pool Creation"
        message={confirmMessage}
        confirmText={`Create ${totalPoolsPlanned} pool(s)`}
        cancelText="Cancel"
        onConfirm={handleCreate}
        onCancel={() => setConfirmHidden(true)}
        loading={isRunning}
      />
    </div>
  );
};

// =========================================================================
// Sub-components
// =========================================================================

// ---- PoolCreationLogPanel ----
// Live agent-log tail rendered during a smart-mode dispatch. Extracted from
// the inline JSX so we can attach: a 250-line auto-tail buffer, an
// "Auto-scroll" toggle so the operator can pause without losing context,
// a level-filter dropdown, an error counter, and a "Copy log" affordance
// that grabs the visible buffer to the clipboard. The original 20-row
// fire-and-forget render was OK as a status indicator but useless for
// post-mortem — copying the buffer used to require devtools.

interface PoolCreationLogPanelProps {
  /** Full agent-log buffer from store state; we filter to `agent === "pool"`. */
  logs: ReturnType<typeof useMultiRegionState>["agentLogs"];
}

const POOL_LOG_TAIL_LIMIT = 250;

const PoolCreationLogPanel: React.FC<PoolCreationLogPanelProps> = ({
  logs,
}) => {
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [levelFilter, setLevelFilter] = React.useState<
    "all" | "error" | "warn" | "info"
  >("all");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const autoScrollId = React.useId();

  const poolLogs = React.useMemo(
    () => logs.filter((l) => l.agent === "pool"),
    [logs],
  );
  const filtered = React.useMemo(() => {
    if (levelFilter === "all") return poolLogs;
    return poolLogs.filter((l) => l.level === levelFilter);
  }, [poolLogs, levelFilter]);
  const tail = React.useMemo(
    () => filtered.slice(-POOL_LOG_TAIL_LIMIT),
    [filtered],
  );

  // Auto-scroll to the bottom on every new log line — unless the operator
  // turned auto-scroll OFF (they're presumably reading an earlier line).
  React.useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [tail.length, autoScroll]);

  const errorCount = React.useMemo(
    () => poolLogs.filter((l) => l.level === "error").length,
    [poolLogs],
  );
  const warnCount = React.useMemo(
    () => poolLogs.filter((l) => l.level === "warn").length,
    [poolLogs],
  );

  const copyBuffer = React.useCallback(async () => {
    const text = tail
      .map((l) => `[${l.level.toUpperCase()}] ${l.message}`)
      .join("\n");
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // ignore — clipboard permission denied, no fallback for log dump
    }
  }, [tail]);

  return (
    <div
      className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-surface-sunken px-3 py-3"
      aria-label="Smart pool creation progress"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs uppercase tracking-wider text-muted-foreground">
          Smart Creation Progress
        </span>
        <Badge variant="secondary" className="font-mono tabular-nums">
          {poolLogs.length}
        </Badge>
        {errorCount > 0 && (
          <Badge
            variant="destructive"
            className="font-mono tabular-nums"
            title={`${errorCount} error log line${errorCount === 1 ? "" : "s"}`}
          >
            {errorCount} err
          </Badge>
        )}
        {warnCount > 0 && (
          <Badge
            variant="info"
            className="font-mono tabular-nums"
            title={`${warnCount} warning log line${warnCount === 1 ? "" : "s"}`}
          >
            {warnCount} warn
          </Badge>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Select
            value={levelFilter}
            onValueChange={(v) =>
              setLevelFilter(v as "all" | "error" | "warn" | "info")
            }
          >
            <SelectTrigger
              className="h-7 w-[110px] text-2xs"
              aria-label="Filter log lines by level"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levels</SelectItem>
              <SelectItem value="error">Errors</SelectItem>
              <SelectItem value="warn">Warnings</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>
          <label
            htmlFor={autoScrollId}
            className="flex cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-2xs"
            title="Auto-scroll to follow the newest log lines"
          >
            <Switch
              id={autoScrollId}
              checked={autoScroll}
              onCheckedChange={setAutoScroll}
              aria-label="Toggle log auto-scroll"
            />
            Auto-scroll
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copyBuffer}
            disabled={tail.length === 0}
            aria-label="Copy log buffer to clipboard"
            className="h-7 gap-1"
          >
            <Copy className="h-3 w-3" />
            Copy
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        role="status"
        aria-live={autoScroll ? "polite" : "off"}
        aria-atomic="false"
        className="max-h-[300px] overflow-y-auto rounded border border-border/60 bg-background px-2 py-2 font-mono text-xs"
      >
        {tail.length === 0 ? (
          <span className="block py-2 text-center text-2xs italic text-muted-foreground">
            {levelFilter === "all"
              ? "Waiting for log lines..."
              : `No ${levelFilter} entries.`}
          </span>
        ) : (
          tail.map((log, i) => (
            <div
              key={`${log.timestamp ?? i}-${i}`}
              className={cn(
                "mb-0.5 leading-relaxed",
                log.level === "error"
                  ? "text-destructive"
                  : log.level === "warn"
                    ? "text-warning"
                    : "text-success",
              )}
            >
              {log.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// ---- PoolResultsSection ----
// Result table for the just-created pools. The original render was a hand-
// rolled <Table> with no sort, no export, no search, and no copy on the
// pool ID / error column. Swap for the shared DataTable so we pick up
// all of those for free, then add summary stats + an error-only filter
// (the operator usually only cares about the rows that broke).

interface PoolResultsSectionProps {
  pools: ReturnType<typeof useMultiRegionState>["pools"];
  accounts: ReturnType<typeof useMultiRegionState>["accounts"];
}

interface PoolResultRow {
  id: string;
  accountName: string;
  region: string;
  poolId: string;
  status: string;
  error: string;
}

const PoolResultsSection: React.FC<PoolResultsSectionProps> = ({
  pools,
  accounts,
}) => {
  const [showErrorsOnly, setShowErrorsOnly] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const errorsOnlyId = React.useId();

  const accountIndex = React.useMemo(() => {
    const map = new Map<string, (typeof accounts)[number]>();
    for (const a of accounts) map.set(a.id, a);
    return map;
  }, [accounts]);

  const rawRows: PoolResultRow[] = React.useMemo(
    () =>
      pools.map((p) => {
        const acc = accountIndex.get(p.accountId);
        return {
          id: p.id,
          accountName: acc?.accountName ?? "-",
          region: acc?.region ?? "-",
          poolId: p.poolId,
          status: p.provisioningState,
          error: p.error ?? "",
        };
      }),
    [pools, accountIndex],
  );

  const rows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rawRows.filter((r) => {
      if (showErrorsOnly && r.error.length === 0) return false;
      if (needle.length === 0) return true;
      return (
        r.accountName.toLowerCase().includes(needle) ||
        r.region.toLowerCase().includes(needle) ||
        r.poolId.toLowerCase().includes(needle) ||
        r.error.toLowerCase().includes(needle) ||
        r.status.toLowerCase().includes(needle)
      );
    });
  }, [rawRows, showErrorsOnly, search]);

  const stats = React.useMemo(() => {
    let succeeded = 0;
    let failed = 0;
    let creating = 0;
    for (const p of pools) {
      if (p.provisioningState === "created") succeeded += 1;
      else if (p.provisioningState === "failed") failed += 1;
      else creating += 1;
    }
    return { succeeded, failed, creating };
  }, [pools]);

  const columns = React.useMemo<DataTableColumn<PoolResultRow>[]>(
    () => [
      {
        id: "accountName",
        header: "Account",
        cell: (r) => <span className="font-medium">{r.accountName}</span>,
        sort: (a, b) => a.accountName.localeCompare(b.accountName),
        csv: (r) => r.accountName,
      },
      {
        id: "region",
        header: "Region",
        cell: (r) => (
          <span className="font-mono text-2xs">{r.region}</span>
        ),
        sort: (a, b) => a.region.localeCompare(b.region),
        csv: (r) => r.region,
      },
      {
        id: "poolId",
        header: "Pool ID",
        cell: (r) => (
          <CopyableText value={r.poolId} mono />
        ),
        sort: (a, b) => a.poolId.localeCompare(b.poolId),
        csv: (r) => r.poolId,
      },
      {
        id: "status",
        header: "Status",
        cell: (r) => <StatusBadge status={r.status as never} />,
        sort: (a, b) => a.status.localeCompare(b.status),
        csv: (r) => r.status,
      },
      {
        id: "error",
        header: "Error",
        cell: (r) =>
          r.error ? (
            <span className="group/copy inline-flex items-center gap-1 align-middle">
              <span className="text-xs text-destructive line-clamp-2 max-w-[24rem]">
                {r.error}
              </span>
              <CopyButton
                value={r.error}
                ariaLabel="Copy error message"
              />
            </span>
          ) : (
            <span className="text-2xs text-muted-foreground">—</span>
          ),
        sort: (a, b) => a.error.localeCompare(b.error),
        csv: (r) => r.error,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-base font-semibold text-foreground">
          Pool Results
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono tabular-nums">
            {stats.succeeded} ok
          </Badge>
          {stats.failed > 0 && (
            <Badge variant="destructive" className="font-mono tabular-nums">
              {stats.failed} failed
            </Badge>
          )}
          {stats.creating > 0 && (
            <Badge variant="info" className="font-mono tabular-nums">
              {stats.creating} in flight
            </Badge>
          )}
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2"
        role="toolbar"
        aria-label="Pool results filters"
      >
        <div className="relative w-full max-w-[20rem]">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search pool results..."
            aria-label="Filter pool results"
            className="pl-7"
          />
        </div>
        <label
          htmlFor={errorsOnlyId}
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-sunken/40 px-2 py-1 text-xs"
        >
          <Switch
            id={errorsOnlyId}
            checked={showErrorsOnly}
            onCheckedChange={setShowErrorsOnly}
            aria-label="Show only failed pools"
          />
          <span>Errors only</span>
          {stats.failed > 0 && (
            <Badge variant="destructive" className="ml-1 font-mono tabular-nums">
              {stats.failed}
            </Badge>
          )}
        </label>
      </div>

      <DataTable<PoolResultRow>
        tableId="pool-creation-results"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        csvFileName="pool-creation-results.csv"
        jsonFileName="pool-creation-results.json"
        initialSort={{ column: "accountName", direction: "asc" }}
        empty={
          <EmptyState
            icon={Server}
            title={showErrorsOnly ? "No failed pools" : "No matching pools"}
            description={
              showErrorsOnly
                ? "Every pool reported succeeded so far."
                : "Loosen the search filter to see more results."
            }
            size="compact"
          />
        }
      />
    </div>
  );
};

export const PoolCreationPage: React.FC<PoolCreationPageProps> = (props) => (
  <ErrorBoundary>
    <PoolCreationPageInner {...props} />
  </ErrorBoundary>
);
