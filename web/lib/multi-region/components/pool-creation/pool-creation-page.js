import { __awaiter } from "tslib";
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
import { AlertCircle, Check, Copy, Cpu, Download, Eraser, FileCode, FileJson, Image as ImageIcon, Keyboard, Layers, Lightbulb, Loader2, Lock, Network, Plus, RotateCw, Save, Search, Server, ShieldAlert, Sparkles, Square, Terminal, Trash2, Upload, ClipboardCheck, } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, } from "@/components/ui/tabs";
import { AnimatedTabs } from "@/components/ui/effects";
import { cn } from "@/lib/utils";
import { MonacoEditor } from "@azure/bonito-ui/lib/components";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { buildPoolConfigFromDefaults, } from "../../store/pool-defaults";
import { DataTable, } from "../shared/enhanced-table";
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
import { cachePeek, invalidateQuotaCache, subscribeQuotaCache, vmSkusCacheKey, } from "../../services/quota-service";
// ---- Constants -----------------------------------------------------------
// Azure Batch pool ID: 1-64 chars, alphanumeric, hyphen, underscore.
const POOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const POOL_ID_ERROR_ID = "pool-id-error";
const POOL_JSON_ERROR_ID = "pool-json-error";
const SUBNET_ID_PATTERN = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/;
// POSIX env-var name: must start with letter/underscore, then alnum/underscore.
// Used by BOTH the inline env-var Name input and the .env paste parser — keep
// them in sync so a name that's invalid via paste is also invalid via type.
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// localStorage key for the saved-templates feature (last 5 successful configs).
const POOL_TEMPLATES_KEY = "pool-creation:templates:v1";
const POOL_TEMPLATES_MAX = 5;
const STEPS = [
    { key: "target", label: "Target", icon: Server },
    { key: "image", label: "Image", icon: ImageIcon },
    { key: "scale", label: "Scale", icon: Layers },
    { key: "networking", label: "Networking", icon: Network },
    { key: "tasks", label: "Tasks", icon: Terminal },
    { key: "review", label: "Review", icon: ClipboardCheck },
];
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
const START_TASK_PRESETS = [
    {
        id: "hello",
        label: "Hello (smoke test)",
        description: "Minimal echo — verifies the start-task channel works.",
        commandLine: '/bin/bash -c "echo Hello from $(hostname)"',
    },
    {
        id: "nvidia-smi",
        label: "NVIDIA driver check",
        description: "Prints driver + GPU inventory. Fails the start-task if the GPU SKU lost its driver.",
        commandLine: '/bin/bash -c "nvidia-smi || (echo NO_GPU_DRIVER && exit 1)"',
    },
    {
        id: "apt-update",
        label: "apt-get update + base tools",
        description: "Refreshes apt caches and installs git/curl/jq. Common warm-up for Ubuntu pools.",
        commandLine: '/bin/bash -c "apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl jq"',
    },
    {
        id: "pip-torch",
        label: "Python + PyTorch (CUDA)",
        description: "Installs python3-pip and PyTorch with CUDA 12.1. Long-running on cold nodes.",
        commandLine: '/bin/bash -c "apt-get update -y && apt-get install -y python3-pip && pip3 install --upgrade pip && pip3 install torch --index-url https://download.pytorch.org/whl/cu121"',
    },
    {
        id: "docker-warm",
        label: "Docker warm-up",
        description: "Pulls a canary image and runs `--gpus all` to validate the docker-GPU bridge.",
        commandLine: '/bin/bash -c "docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi"',
    },
];
function parseEnvPaste(raw) {
    const out = [];
    const warnings = [];
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.length === 0)
            continue;
        if (line.startsWith("#"))
            continue;
        if (line.startsWith("export "))
            line = line.slice(7).trimStart();
        const eq = line.indexOf("=");
        if (eq <= 0) {
            warnings.push(`Line ${i + 1}: missing "=", skipped (${line.slice(0, 40)})`);
            continue;
        }
        const name = line.slice(0, eq).trim();
        if (!ENV_NAME_PATTERN.test(name)) {
            warnings.push(`Line ${i + 1}: invalid POSIX env name "${name}", skipped (must start with letter/underscore, then alnum/underscore)`);
            continue;
        }
        let value = line.slice(eq + 1);
        // Strip a single matching pair of surrounding quotes.
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out.push({ name, value });
    }
    return { parsed: out, warnings };
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
    /\bchmod\s+[+u]\w*[sx]\b/i,
    /\bchown\s+root\b/i,
    /\bsudo\b/i,
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
function analyzeAttackSurface(input) {
    var _a;
    const out = [];
    const cmd = (_a = input.startTaskCmd) !== null && _a !== void 0 ? _a : "";
    const isPublic = input.subnetId.trim().length === 0;
    const isAdmin = input.elevationLevel === "admin";
    const fetches = OUTBOUND_FETCH_PATTERNS.some((p) => p.test(cmd));
    const fsWrite = FS_WRITE_PATTERNS.some((p) => p.test(cmd));
    // 1. Compute-hijack shape: public IP + outbound + admin StartTask.
    if (isPublic && fetches && isAdmin) {
        out.push({
            id: "compute-hijack",
            severity: "destructive",
            title: "Compute-hijack shape: public IP + outbound fetch + admin StartTask",
            detail: "Pool nodes will boot on the public Batch fleet (no subnet attached), the StartTask will fetch from the internet, and it runs as root. A compromised apt/pip/docker mirror — or a single MITM on the fetch path — yields a root shell with IMDS access. The classic Azure VM IMDS at 169.254.169.254 (Metadata: true header) will mint managed-identity tokens for whatever identity the Batch account has, which AzureHound / MicroBurst then graph into the wider tenant. Mitigations: attach a subnet with a deny-by-default NSG, pin checksums on every fetched artifact, or drop elevation to nonadmin.",
            cite: "_analysis_netspi.md §I (IMDS Variants — Azure VM row)",
        });
    }
    else if (isPublic && fetches) {
        out.push({
            id: "outbound-public",
            severity: "warning",
            title: "Public networking + outbound fetch in StartTask",
            detail: "No subnet attached, so the node uses default public networking. The StartTask reaches out to the internet during boot. A poisoned apt/pip/docker mirror compromises every node in the pool. Consider pinning checksums, mirroring artifacts to a private storage account, or attaching a subnet with controlled egress.",
            cite: "_analysis_netspi.md §I (IMDS Variants)",
        });
    }
    else if (isAdmin && fsWrite) {
        out.push({
            id: "admin-fs-write",
            severity: "warning",
            title: "StartTask is elevated AND writes outside the task directory",
            detail: "elevationLevel=admin combined with chmod/chown/tar/install-D to system paths means a buggy or malicious StartTask leaves persistent state on the node. Even after the pool deallocates and a node is recycled into a new pool, Batch reformats the OS disk — but secrets baked into the start-task script remain in the pool's stored definition. Prefer dropping privileges (nonadmin) or fencing writes to /mnt/batch/tasks/.",
            cite: "_analysis_netspi.md §III (App Service Token Theft — same blast-radius pattern)",
        });
    }
    // 2. Secret-shaped env vars in the pool definition.
    const secretEnvs = input.envVars
        .filter((ev) => ev.name.trim() !== "")
        .filter((ev) => SECRET_ENV_PATTERNS.some((p) => p.test(ev.name.trim())))
        .map((ev) => ev.name);
    if (secretEnvs.length > 0) {
        out.push({
            id: "secret-env",
            severity: "warning",
            title: `${secretEnvs.length} env-var name(s) look like secret(s)`,
            detail: `Plain-text env vars on a pool definition are visible to anyone with Reader on the Batch account — they're returned by the pool GET API, the Azure Portal, and pool exports. Names: ${secretEnvs.slice(0, 5).join(", ")}${secretEnvs.length > 5 ? ", …" : ""}. Move these to a Key Vault reference (Batch supports it natively) or fetch at runtime from an identity-bound source.`,
            cite: "_analysis_netspi.md §VI (Key Vault enumeration / Get-AzPasswords)",
        });
    }
    // 3. Cross-sub dispatch advisory.
    if (input.smartMode && input.crossSubDispatch) {
        out.push({
            id: "cross-sub-dispatch",
            severity: "info",
            title: "Cross-subscription dispatch in progress",
            detail: "Selected accounts span multiple subscriptions / AAD identities. The orchestrator routes a fresh Batch token per account, but the StartTask above runs identically in every account. Verify the command does not embed sub-specific paths, role assignments, or storage accounts that only exist in one of the targets.",
            cite: "_bypass_tenant_switch.md §multi-tenant token routing",
        });
    }
    // 4. Pool-scale warning: many accounts × many SKUs = many nodes.
    if (input.smartMode && input.selectedAccountCount >= 10) {
        out.push({
            id: "pool-scale",
            severity: "info",
            title: `Large dispatch: ${input.selectedAccountCount} accounts in smart-fill mode`,
            detail: "Each account fills its remaining LP quota, so the per-account node count is bounded by quota — but the aggregate fleet you're about to bring up could be thousands of nodes. Every node will run the StartTask above. A bug in the StartTask amplifies across the whole fleet.",
            cite: "(operational guidance — not a corpus citation)",
        });
    }
    return out;
}
function buildPutBodyPreview(input) {
    var _a;
    const redactedNames = [];
    if (!input.smartMode) {
        try {
            const parsed = JSON.parse(input.poolConfigJson);
            parsed.targetDedicatedNodes = 0;
            // Redact secret-shaped env vars in the manual JSON preview too.
            const env = (_a = parsed.startTask) === null || _a === void 0 ? void 0 : _a.environmentSettings;
            if (Array.isArray(env)) {
                const sanitized = env.map((e) => {
                    const item = e;
                    const name = typeof item.name === "string" ? item.name : "";
                    const looksSecret = SECRET_ENV_PATTERNS.some((p) => p.test(name));
                    if (looksSecret)
                        redactedNames.push(name);
                    return looksSecret
                        ? { name, value: "<redacted in preview>" }
                        : { name, value: typeof item.value === "string" ? item.value : "" };
                });
                parsed.startTask.environmentSettings =
                    sanitized;
            }
            return { body: parsed, redactedNames };
        }
        catch (e) {
            return {
                body: { _previewError: `Invalid JSON: ${e.message}` },
                redactedNames: [],
            };
        }
    }
    const vmSizePlaceholder = input.smartVmSizes.length > 0
        ? `<one of ${input.smartVmSizes.length} picked SKUs>`
        : `<one of ${input.smartVmCount} default GPU SKUs>`;
    const environmentSettings = input.envVars
        .filter((ev) => ev.name.trim() !== "")
        .map((ev) => {
        const looksSecret = SECRET_ENV_PATTERNS.some((p) => p.test(ev.name));
        if (looksSecret)
            redactedNames.push(ev.name);
        return {
            name: ev.name,
            value: looksSecret ? "<redacted in preview>" : ev.value,
        };
    });
    let body;
    if (input.poolDefaults) {
        body = buildPoolConfigFromDefaults(input.poolDefaults, {
            id: input.poolIdInput,
            targetLowPriorityNodes: 0,
            vmSize: vmSizePlaceholder,
        });
        body.targetDedicatedNodes = 0;
        body.enableAutoScale = false;
    }
    else {
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
function validatePoolId(id) {
    if (typeof id !== "string" || id.length === 0) {
        return "Pool ID is required.";
    }
    if (!POOL_ID_PATTERN.test(id)) {
        return "Pool ID must be 1-64 chars, alphanumeric/underscore/hyphen only.";
    }
    return null;
}
function validateSubnetId(id) {
    if (id.length === 0)
        return null; // optional
    if (!SUBNET_ID_PATTERN.test(id)) {
        return "Subnet must be a full Azure resource ID: /subscriptions/.../subnets/<name>.";
    }
    return null;
}
// ---- Eligible-account columns (defined out-of-component for stability) --
function buildAccountColumns() {
    return [
        {
            id: "accountName",
            header: "Account",
            cell: (row) => (React.createElement("span", { className: "group/copy inline-flex items-center gap-1.5 align-middle" },
                React.createElement("span", { className: "font-medium" }, row.accountName),
                React.createElement(CopyButton, { value: row.accountName, ariaLabel: `Copy account name ${row.accountName}` }))),
            sort: (a, b) => a.accountName.localeCompare(b.accountName),
            csv: (row) => row.accountName,
        },
        {
            id: "region",
            header: "Region",
            cell: (row) => (React.createElement("span", { className: "font-mono text-2xs" }, row.region)),
            sort: (a, b) => a.region.localeCompare(b.region),
            csv: (row) => row.region,
        },
        {
            id: "subscription",
            header: "Subscription",
            cell: (row) => (React.createElement("span", { className: "block max-w-[14rem] truncate text-xs text-muted-foreground", title: row.subscriptionName || row.subscriptionId }, row.subscriptionName || row.subscriptionId.slice(0, 8) + "…")),
            sort: (a, b) => a.subscriptionName.localeCompare(b.subscriptionName),
            csv: (row) => row.subscriptionName || row.subscriptionId,
            defaultHidden: true,
        },
        {
            id: "freeLp",
            header: "Free LP cores",
            cell: (row) => {
                if (row.quotaStale) {
                    return (React.createElement("span", { className: "text-2xs italic text-muted-foreground", title: "Quota not yet refreshed \u2014 click Discover accounts above." }, "not loaded"));
                }
                const tone = row.lowPriorityCoresFree > 0
                    ? "text-success"
                    : "text-muted-foreground";
                return (React.createElement("span", { className: cn("font-mono tabular-nums text-xs", tone) }, row.lowPriorityCoresFree.toLocaleString()));
            },
            sort: (a, b) => a.lowPriorityCoresFree - b.lowPriorityCoresFree,
            csv: (row) => (row.quotaStale ? "" : row.lowPriorityCoresFree),
        },
        {
            id: "freeDedicated",
            header: "Free dedicated",
            cell: (row) => row.quotaStale ? (React.createElement("span", { className: "text-2xs italic text-muted-foreground" }, "\u2014")) : (React.createElement("span", { className: "font-mono tabular-nums text-xs text-muted-foreground" }, row.dedicatedCoresFree.toLocaleString())),
            sort: (a, b) => a.dedicatedCoresFree - b.dedicatedCoresFree,
            csv: (row) => (row.quotaStale ? "" : row.dedicatedCoresFree),
            defaultHidden: true,
        },
        {
            id: "pools",
            header: "Pools",
            cell: (row) => row.quotaStale ? (React.createElement("span", { className: "text-2xs italic text-muted-foreground" }, "\u2014")) : (React.createElement("span", { className: "font-mono tabular-nums text-xs text-muted-foreground" },
                row.poolCount,
                " / ",
                row.poolQuota || "?")),
            sort: (a, b) => a.poolCount - b.poolCount,
            csv: (row) => row.quotaStale ? "" : `${row.poolCount}/${row.poolQuota || ""}`,
        },
    ];
}
// ---- Component -----------------------------------------------------------
const PoolCreationPageInner = ({ orchestrator, }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const poolDefaults = state
        .poolDefaults;
    // Page-level ARM-token tracker. Drives the TokenExpiryBadge in the
    // header so the operator gets a visible heads-up before the token
    // flips mid-dispatch — pool creation can run for minutes (smart-mode
    // fan-out across dozens of accounts/VM sizes) and a stale token would
    // surface as an opaque mid-batch 401. We don't bridge this token
    // back into the orchestrator's per-account flow; that path keeps its
    // own per-sub token resolver. This is purely the expiry-awareness UI.
    const primaryAccount = ((_a = state.azureAccounts) !== null && _a !== void 0 ? _a : [])[0];
    const armTokenTracker = useArmToken(primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.homeAccountId, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.tenantId);
    // Step state — URL-synced per Contract §3.7 / §4.3.
    const [stepState, setStepState] = useUrlState({ step: "target" }, { replace: true });
    const currentStep = STEPS.some((s) => s.key === stepState.step)
        ? stepState.step
        : "target";
    // ---- Form state ----
    const [poolConfigJson, setPoolConfigJson] = React.useState(JSON.stringify(DEFAULT_POOL_CONFIG, null, 2));
    const [configError, setConfigError] = React.useState(null);
    const [selectedAccountIds, setSelectedAccountIds] = React.useState(new Set());
    const [isRunning, setIsRunning] = React.useState(false);
    // Discovery progress for the explicit "Discover accounts" button. Mirrors
    // the per-sub flow used by the orchestrator so the operator can see which
    // subs the page is still walking through. `null` ⇒ no discovery in flight.
    const [discoverProgress, setDiscoverProgress] = React.useState(null);
    const [discoverError, setDiscoverError] = React.useState(null);
    const [smartMode, setSmartMode] = React.useState(true);
    // Smart-mode VM SKU set. Empty = "use the live catalog defaults" which
    // expands to the GPU-only catalog (or the hardcoded 5 fallback when
    // the catalog hasn't been populated yet). Non-empty = user override
    // via the LiveVmSizeSelect multi-picker below the smart-mode toggle.
    const [smartVmSizes, setSmartVmSizes] = React.useState([]);
    // ---- One-time URL-param hydration (deep-link from Unused Quota) ----
    // The Unused Quota page's "Use in Smart Mode" button navigates here
    // with `?accountIds=...&vmSizes=...&smartMode=on`. We read those
    // params ONCE on mount and pre-fill the Target step + Smart Mode
    // picker. Subsequent edits via the wizard own the state.
    const urlHydratedRef = React.useRef(false);
    React.useEffect(() => {
        var _a;
        if (urlHydratedRef.current)
            return;
        urlHydratedRef.current = true;
        const params = new URLSearchParams((_a = window.location.hash.split("?")[1]) !== null && _a !== void 0 ? _a : "");
        const accountIdsParam = params.get("accountIds");
        if (accountIdsParam) {
            const ids = accountIdsParam.split(",").filter(Boolean);
            if (ids.length > 0)
                setSelectedAccountIds(new Set(ids));
        }
        const vmSizesParam = params.get("vmSizes");
        if (vmSizesParam) {
            const vms = vmSizesParam.split(",").filter(Boolean);
            if (vms.length > 0)
                setSmartVmSizes(vms);
        }
        if (params.get("smartMode") === "on") {
            setSmartMode(true);
        }
        else if (params.get("smartMode") === "off") {
            setSmartMode(false);
        }
    }, []);
    // Master wire-up toggle. Hydrated from user preferences so the choice
    // sticks across reloads. When OFF, the LiveVmSizeSelect picker is
    // hidden, smartVmSizes is treated as empty, and Smart Mode falls
    // through to the hardcoded 5-VM list — the pre-wire UX.
    const [liveCatalogEnabled, setLiveCatalogEnabled] = React.useState(() => store.getUserPreferences().liveVmCatalogEnabled);
    const toggleLiveCatalog = React.useCallback((next) => {
        setLiveCatalogEnabled(next);
        store.saveUserPreferences({ liveVmCatalogEnabled: next });
        // When disabling, clear the picker selection so the smart-mode
        // dispatch deterministically falls back to the hardcoded list.
        if (!next)
            setSmartVmSizes([]);
    }, [store]);
    const [poolIdInput, setPoolIdInput] = React.useState("pool");
    const [poolIdError, setPoolIdError] = React.useState(null);
    // Multi-pick subscription filter. When empty, the eligible-accounts
    // table shows every created account across every signed-in sub —
    // operators can then cross-select accounts that span different subs
    // (and even different AAD identities) in a single create_pools_smart
    // dispatch. The per-sub Batch token resolver in pool-agent makes
    // that cross-tenant case actually work.
    const [selectedSubIds, setSelectedSubIds] = React.useState([]);
    // Mirror of the FIRST picked sub (or empty when none / many). Used
    // only by call sites that need a single value — live VM-catalog
    // availability check, the per-sub VM-size picker, etc. These call
    // sites are inherently single-sub today; treating them as "primary"
    // is the least-disruptive way to keep them working.
    const subscriptionId = selectedSubIds.length > 0 ? selectedSubIds[0] : "";
    // Catalog-availability dependency: the toggle is meaningless when the
    // cache has no data (no SKUs to pick from). Disable the switch in
    // that case and surface a "populate first" hint. Reactive — flips
    // back to enabled the moment the cache fills. Declared AFTER
    // subscriptionId so the hook receives the live state value (not
    // a TDZ-undefined reference — the previous ordering crashed with
    // ReferenceError).
    const catalogAvailability = useLiveCatalogAvailable(subscriptionId || undefined);
    // Effective on/off: the user's stored preference AND the catalog
    // actually has data. If the catalog goes empty (TTL expiry, manual
    // invalidate) the picker hides automatically — Smart Mode falls back
    // to the hardcoded list without surprising the user.
    const liveCatalogEffective = liveCatalogEnabled && catalogAvailability.available;
    // Catalog freshness — exposed in the UI as a "Last updated: X ago" chip
    // so the operator can spot a stale cache before a dispatch picks the
    // wrong SKU set. Pulls the underlying `fetchedAt` from the quota-service
    // cache item and re-reads on cache pub/sub changes (covers TTL expiry,
    // operator-driven invalidate, vm-catalog page refresh).
    const [catalogFetchedAt, setCatalogFetchedAt] = React.useState(null);
    React.useEffect(() => {
        if (!subscriptionId) {
            setCatalogFetchedAt(null);
            return;
        }
        const read = () => {
            var _a, _b;
            const all = cachePeek(vmSkusCacheKey(subscriptionId, false));
            const gpu = cachePeek(vmSkusCacheKey(subscriptionId, true));
            // Prefer whichever is fresher — they're populated independently.
            const fetched = Math.max((_a = all === null || all === void 0 ? void 0 : all.fetchedAt) !== null && _a !== void 0 ? _a : 0, (_b = gpu === null || gpu === void 0 ? void 0 : gpu.fetchedAt) !== null && _b !== void 0 ? _b : 0);
            setCatalogFetchedAt(fetched > 0 ? fetched : null);
        };
        read();
        return subscribeQuotaCache((key) => {
            if (!subscriptionId ||
                key === "*" ||
                key === vmSkusCacheKey(subscriptionId, true) ||
                key === vmSkusCacheKey(subscriptionId, false)) {
                read();
            }
        });
    }, [subscriptionId]);
    // Tick once a minute so the relative "X min ago" label refreshes even
    // when the cache itself isn't changing. Cheap — single setInterval.
    const [, setNowTick] = React.useState(0);
    React.useEffect(() => {
        const id = window.setInterval(() => setNowTick((n) => n + 1), 60000);
        return () => window.clearInterval(id);
    }, []);
    const catalogAgeLabel = React.useMemo(() => {
        if (catalogFetchedAt == null)
            return null;
        const ageMs = Date.now() - catalogFetchedAt;
        if (ageMs < 0)
            return "just now";
        const min = Math.floor(ageMs / 60000);
        if (min < 1)
            return "just now";
        if (min < 60)
            return `${min} min ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24)
            return `${hr}h ago`;
        const d = Math.floor(hr / 24);
        return `${d}d ago`;
    }, [catalogFetchedAt]);
    // Manual refresh — invalidates the cached SKU set for the current sub
    // and routes the operator to the VM Catalog page where the prefetch
    // will re-populate. We don't have a direct "fetch VM SKUs" action on
    // the orchestrator (boot prefetch in dashboard-shell owns that path),
    // so the safe contract is invalidate-and-navigate.
    const handleRefreshCatalog = React.useCallback(() => {
        var _a;
        if (!subscriptionId)
            return;
        invalidateQuotaCache(subscriptionId);
        auditLog.record({
            actor: (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _a !== void 0 ? _a : "unknown",
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
    }, [subscriptionId, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username, store]);
    const [autoSelectedSubscription, setAutoSelectedSubscription] = React.useState(false);
    // Image step
    const [osCategory, setOsCategory] = React.useState((_b = poolDefaults === null || poolDefaults === void 0 ? void 0 : poolDefaults.osCategory) !== null && _b !== void 0 ? _b : "linux");
    // Scale step
    const [resizeTimeoutMin, setResizeTimeoutMin] = React.useState((_c = poolDefaults === null || poolDefaults === void 0 ? void 0 : poolDefaults.resizeTimeoutMinutes) !== null && _c !== void 0 ? _c : 15);
    // Networking step
    const [subnetId, setSubnetId] = React.useState((_d = poolDefaults === null || poolDefaults === void 0 ? void 0 : poolDefaults.subnetId) !== null && _d !== void 0 ? _d : "");
    const [subnetError, setSubnetError] = React.useState(null);
    const [interNodeComm, setInterNodeComm] = React.useState((_e = poolDefaults === null || poolDefaults === void 0 ? void 0 : poolDefaults.enableInterNodeCommunication) !== null && _e !== void 0 ? _e : false);
    // Tasks step
    const [startTaskCmd, setStartTaskCmd] = React.useState((_g = (_f = poolDefaults === null || poolDefaults === void 0 ? void 0 : poolDefaults.startTask) === null || _f === void 0 ? void 0 : _f.commandLine) !== null && _g !== void 0 ? _g : DEFAULT_POOL_CONFIG.startTask.commandLine);
    const [envVars, setEnvVars] = React.useState([]);
    const [maxRetryCount, setMaxRetryCount] = React.useState(3);
    const [waitForSuccess, setWaitForSuccess] = React.useState(true);
    // Review step
    const [saveAsDefault, setSaveAsDefault] = React.useState(false);
    const [confirmHidden, setConfirmHidden] = React.useState(true);
    // ---- Saved templates (last N successful configs) ----
    const [templates, setTemplates] = usePersistedState(POOL_TEMPLATES_KEY, []);
    // ---- Per-submit AbortController ----
    // Lets the operator cancel a long-running smart-fill dispatch via the
    // "Stop" button and also auto-cancels on unmount. The orchestrator
    // already accepts `params.signal` and forwards it to the per-agent
    // cancellation tracker; we just supply the controller here.
    const submitAbortRef = React.useRef(null);
    // Separate controller for the "Discover accounts" action so the
    // operator typing in the sub picker (changes selectedSubIds) can abort
    // the previous discovery without nuking the in-flight pool create.
    const discoverAbortRef = React.useRef(null);
    // Mount-effect-only abort on unmount.
    React.useEffect(() => {
        return () => {
            var _a, _b;
            (_a = submitAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
            (_b = discoverAbortRef.current) === null || _b === void 0 ? void 0 : _b.abort();
        };
    }, []);
    // ---- Refs / IDs ----
    const poolIdFieldRef = React.useRef(null);
    const subnetFieldRef = React.useRef(null);
    const startTaskFieldRef = React.useRef(null);
    const jsonEditorContainerRef = React.useRef(null);
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
        var _a;
        if (state.subscriptions.length === 1 &&
            selectedSubIds.length === 0 &&
            ((_a = state.subscriptions[0]) === null || _a === void 0 ? void 0 : _a.subscriptionId)) {
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
    const toggleSubSelection = React.useCallback((subId) => {
        setAutoSelectedSubscription(false);
        setSelectedSubIds((prev) => prev.includes(subId)
            ? prev.filter((x) => x !== subId)
            : [...prev, subId]);
    }, []);
    // Explicit "Discover accounts" handler — walks the operator's chosen
    // subs (or every signed-in sub when the filter is empty) and asks the
    // orchestrator to re-pull Batch accounts from each. Each call passes
    // a specific `subscriptionId` so the orchestrator's per-sub token
    // resolver routes through the owning MSAL identity — without that,
    // subs owned by a non-primary signed-in account silently return
    // nothing and the operator sees the "No eligible accounts" stub.
    const handleDiscoverAccounts = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _o, _p, _q, _r;
        const targetSubs = selectedSubIds.length > 0
            ? selectedSubIds
            : state.subscriptions.map((s) => s.subscriptionId);
        if (targetSubs.length === 0) {
            setDiscoverError("No subscriptions to discover. Sign in to an Azure account first.");
            return;
        }
        setDiscoverError(null);
        // Spin a fresh controller; aborts any in-flight discovery from a
        // previous click before starting the new walk.
        (_o = discoverAbortRef.current) === null || _o === void 0 ? void 0 : _o.abort();
        discoverAbortRef.current = new AbortController();
        setDiscoverProgress({
            completed: 0,
            total: targetSubs.length,
            currentSubId: (_p = targetSubs[0]) !== null && _p !== void 0 ? _p : null,
            importedTotal: 0,
        });
        const before = state.accounts.length;
        const errors = [];
        try {
            for (let i = 0; i < targetSubs.length; i++) {
                const subId = targetSubs[i];
                setDiscoverProgress((prev) => prev
                    ? Object.assign(Object.assign({}, prev), { completed: i, currentSubId: subId }) : prev);
                try {
                    yield orchestrator.execute({
                        action: "discover_accounts",
                        payload: { subscriptionId: subId },
                        signal: (_q = discoverAbortRef.current) === null || _q === void 0 ? void 0 : _q.signal,
                    });
                }
                catch (err) {
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
                yield orchestrator.execute({
                    action: "refresh_account_info",
                    payload: {},
                    signal: (_r = discoverAbortRef.current) === null || _r === void 0 ? void 0 : _r.signal,
                });
            }
            catch (err) {
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
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setDiscoverError(message);
        }
    }), [orchestrator, selectedSubIds, state.subscriptions, state.accounts.length]);
    // Save pool config to preferences when editor value changes (debounced).
    const saveTimerRef = React.useRef(null);
    const handleEditorChange = React.useCallback((value) => {
        setPoolConfigJson(value);
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }
        saveTimerRef.current = setTimeout(() => {
            store.saveUserPreferences({ lastPoolConfig: value });
        }, 1000);
    }, [store]);
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
    const subFilterSet = React.useMemo(() => new Set(selectedSubIds), [selectedSubIds]);
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
        var _a, _b, _c, _d;
        const counts = new Map();
        for (const s of state.subscriptions) {
            const key = `${s.displayName}|${(_a = s.ownerAccountLabel) !== null && _a !== void 0 ? _a : ""}`;
            counts.set(key, ((_b = counts.get(key)) !== null && _b !== void 0 ? _b : 0) + 1);
        }
        const ids = new Set();
        for (const s of state.subscriptions) {
            const key = `${s.displayName}|${(_c = s.ownerAccountLabel) !== null && _c !== void 0 ? _c : ""}`;
            if (((_d = counts.get(key)) !== null && _d !== void 0 ? _d : 0) > 1)
                ids.add(s.subscriptionId);
        }
        return ids;
    }, [state.subscriptions]);
    // Index account-info by account id so we can splice quota numbers into
    // each eligible-account row without re-walking the array per row. Stale
    // (no entry) is treated as "quota not loaded" rather than zero — zero
    // would silently hide accounts behind the LP filter below.
    const accountInfoIndex = React.useMemo(() => {
        var _a;
        const map = new Map();
        for (const ai of (_a = state.accountInfos) !== null && _a !== void 0 ? _a : []) {
            map.set(ai.id, ai);
        }
        return map;
    }, [state.accountInfos]);
    // Sub-id → displayName index for the new Subscription column. Cheap to
    // rebuild on subscription changes (typical N is < 20) and avoids an
    // O(n*m) lookup inside the row mapper.
    const subscriptionNameIndex = React.useMemo(() => {
        var _a;
        const map = new Map();
        for (const s of (_a = state.subscriptions) !== null && _a !== void 0 ? _a : []) {
            map.set(s.subscriptionId, s.displayName);
        }
        return map;
    }, [state.subscriptions]);
    // Operator-driven UX filters layered ON TOP of the existing sub filter.
    // Both default to "off" so the page renders identically out-of-the-box.
    const [accountSearch, setAccountSearch] = React.useState("");
    const [onlyAccountsWithFreeLp, setOnlyAccountsWithFreeLp] = React.useState(false);
    // Region multi-pick filter. Empty set = no region filter (matches the
    // sub-filter convention).
    const [regionFilter, setRegionFilter] = React.useState(() => new Set());
    const eligibleAccountsRaw = React.useMemo(() => state.accounts
        .filter((a) => a.provisioningState === "created" &&
        (subFilterSet.size === 0 || subFilterSet.has(a.subscriptionId)))
        .map((a) => {
        var _a, _b, _c, _d, _e;
        const info = accountInfoIndex.get(a.id);
        return {
            id: a.id,
            accountName: a.accountName,
            region: a.region,
            subscriptionId: a.subscriptionId,
            subscriptionName: (_a = subscriptionNameIndex.get(a.subscriptionId)) !== null && _a !== void 0 ? _a : "",
            lowPriorityCoresFree: (_b = info === null || info === void 0 ? void 0 : info.lowPriorityCoresFree) !== null && _b !== void 0 ? _b : 0,
            dedicatedCoresFree: (_c = info === null || info === void 0 ? void 0 : info.dedicatedCoresFree) !== null && _c !== void 0 ? _c : 0,
            poolCount: (_d = info === null || info === void 0 ? void 0 : info.poolCount) !== null && _d !== void 0 ? _d : 0,
            poolQuota: (_e = info === null || info === void 0 ? void 0 : info.poolQuota) !== null && _e !== void 0 ? _e : 0,
            quotaStale: info == null,
        };
    }), [state.accounts, subFilterSet, accountInfoIndex, subscriptionNameIndex]);
    // Region list for the filter dropdown — derived from the raw rows (BEFORE
    // the search/quota filters) so the dropdown options stay stable while the
    // operator types.
    const availableRegions = React.useMemo(() => {
        const set = new Set();
        for (const a of eligibleAccountsRaw)
            set.add(a.region);
        return Array.from(set).sort();
    }, [eligibleAccountsRaw]);
    // Apply the search, region, and "only with free LP" filters last. Search
    // matches case-insensitively against accountName / region / sub name —
    // the three columns the operator can actually see.
    const eligibleAccounts = React.useMemo(() => {
        const needle = accountSearch.trim().toLowerCase();
        return eligibleAccountsRaw.filter((row) => {
            if (onlyAccountsWithFreeLp && row.lowPriorityCoresFree <= 0)
                return false;
            if (regionFilter.size > 0 && !regionFilter.has(row.region))
                return false;
            if (needle.length === 0)
                return true;
            return (row.accountName.toLowerCase().includes(needle) ||
                row.region.toLowerCase().includes(needle) ||
                row.subscriptionName.toLowerCase().includes(needle) ||
                row.subscriptionId.toLowerCase().includes(needle));
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
            if (a.quotaStale)
                continue;
            totalFreeLp += a.lowPriorityCoresFree;
            totalFreeDed += a.dedicatedCoresFree;
            if (a.lowPriorityCoresFree > 0)
                withFreeLp += 1;
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
            if (!selectedAccountIds.has(a.id))
                continue;
            if (a.quotaStale) {
                staleCount += 1;
                continue;
            }
            totalFreeLp += a.lowPriorityCoresFree;
            if (a.lowPriorityCoresFree <= 0)
                withZeroLp += 1;
        }
        return { totalFreeLp, staleCount, withZeroLp };
    }, [eligibleAccountsRaw, selectedAccountIds]);
    // ---- Env var helpers ----
    const addEnvVar = React.useCallback(() => {
        setEnvVars((prev) => [...prev, { name: "", value: "" }]);
    }, []);
    const removeEnvVar = React.useCallback((index) => {
        setEnvVars((prev) => prev.filter((_, i) => i !== index));
    }, []);
    const updateEnvVar = React.useCallback((index, field, val) => {
        setEnvVars((prev) => prev.map((ev, i) => (i === index ? Object.assign(Object.assign({}, ev), { [field]: val }) : ev)));
    }, []);
    // ---- env-var bulk-edit helpers ----
    // Operator-facing controls for the env-vars table: paste a .env blob,
    // clear everything, or dedupe by name. Each goes through the same
    // immutable updater so the React tree re-renders normally.
    const [envPasteOpen, setEnvPasteOpen] = React.useState(false);
    const [envPasteText, setEnvPasteText] = React.useState("");
    const [envPasteWarnings, setEnvPasteWarnings] = React.useState([]);
    const envPasteFieldId = React.useId();
    const handleEnvPasteApply = React.useCallback(() => {
        const result = parseEnvPaste(envPasteText);
        setEnvPasteWarnings(result.warnings);
        if (result.parsed.length === 0) {
            // Nothing to add — keep the modal open so the warnings can be read.
            return;
        }
        setEnvVars((prev) => {
            var _a;
            // Merge: existing values stay, new keys appended, duplicate keys
            // replace the existing value (last-write-wins, matches shell `export`).
            const byName = new Map();
            for (const ev of prev) {
                if (ev.name.trim() !== "")
                    byName.set(ev.name, ev.value);
            }
            for (const p of result.parsed)
                byName.set(p.name, p.value);
            const merged = [];
            // Preserve order: existing names first (in their original order),
            // then new ones appended in paste order.
            const existingNames = new Set(prev.filter((ev) => ev.name.trim() !== "").map((ev) => ev.name));
            for (const ev of prev) {
                if (ev.name.trim() === "")
                    continue;
                merged.push({ name: ev.name, value: (_a = byName.get(ev.name)) !== null && _a !== void 0 ? _a : ev.value });
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
            const seen = new Map();
            for (const ev of prev) {
                if (ev.name.trim() === "")
                    continue;
                seen.set(ev.name, ev);
            }
            return Array.from(seen.values());
        });
    }, []);
    // Detect duplicate env-var names so the UI can highlight them inline.
    // Single source of truth so the inline badge + the submit dialog agree.
    const envDuplicateNames = React.useMemo(() => {
        var _a;
        const counts = new Map();
        for (const ev of envVars) {
            const k = ev.name.trim();
            if (k === "")
                continue;
            counts.set(k, ((_a = counts.get(k)) !== null && _a !== void 0 ? _a : 0) + 1);
        }
        const dups = new Set();
        for (const [k, n] of counts)
            if (n > 1)
                dups.add(k);
        return dups;
    }, [envVars]);
    // POSIX-invalid env-var names. An operator can type `123-bad` directly
    // into the inline name input; we don't drop that on submit (it'd be a
    // silent fail), we highlight inline and block submit on the Tasks step.
    const envInvalidIndices = React.useMemo(() => {
        const set = new Set();
        envVars.forEach((ev, idx) => {
            const k = ev.name.trim();
            if (k !== "" && !ENV_NAME_PATTERN.test(k))
                set.add(idx);
        });
        return set;
    }, [envVars]);
    const envHasInvalidNames = envInvalidIndices.size > 0;
    // ---- start-task helpers ----
    const applyStartTaskPreset = React.useCallback((preset) => {
        setStartTaskCmd(preset.commandLine);
        requestAnimationFrame(() => {
            var _a, _b;
            (_a = startTaskFieldRef.current) === null || _a === void 0 ? void 0 : _a.focus();
            (_b = startTaskFieldRef.current) === null || _b === void 0 ? void 0 : _b.setSelectionRange(preset.commandLine.length, preset.commandLine.length);
        });
    }, []);
    // ---- JSON-mode helpers ----
    const handleJsonFormat = React.useCallback(() => {
        var _a;
        try {
            const parsed = JSON.parse(poolConfigJson);
            setPoolConfigJson(JSON.stringify(parsed, null, 2));
            setConfigError(null);
        }
        catch (e) {
            setConfigError(`Cannot format: ${(_a = e.message) !== null && _a !== void 0 ? _a : "invalid JSON"}`);
        }
    }, [poolConfigJson]);
    const handleJsonReset = React.useCallback(() => {
        setPoolConfigJson(JSON.stringify(DEFAULT_POOL_CONFIG, null, 2));
        setConfigError(null);
    }, []);
    const handleJsonCopy = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _s;
        try {
            if (typeof navigator !== "undefined" &&
                ((_s = navigator.clipboard) === null || _s === void 0 ? void 0 : _s.writeText)) {
                yield navigator.clipboard.writeText(poolConfigJson);
                store.addNotification({
                    type: "success",
                    message: "Pool config copied to clipboard",
                    autoDismissMs: 2500,
                });
            }
        }
        catch (_t) {
            // Silent — CopyButton elsewhere on the page does its own retry path.
        }
    }), [poolConfigJson, store]);
    const handleJsonDownload = React.useCallback(() => {
        var _a;
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
        }
        catch (e) {
            setConfigError(`Download failed: ${(_a = e.message) !== null && _a !== void 0 ? _a : "unknown error"}`);
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
            for (const a of eligibleAccounts)
                next.add(a.id);
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
                if (!a.quotaStale && a.lowPriorityCoresFree > 0)
                    next.add(a.id);
            }
            return next;
        });
    }, [eligibleAccounts]);
    const invertVisibleSelection = React.useCallback(() => {
        setSelectedAccountIds((prev) => {
            const next = new Set(prev);
            for (const a of eligibleAccounts) {
                if (next.has(a.id))
                    next.delete(a.id);
                else
                    next.add(a.id);
            }
            return next;
        });
    }, [eligibleAccounts]);
    const toggleRegionFilter = React.useCallback((region) => {
        setRegionFilter((prev) => {
            const next = new Set(prev);
            if (next.has(region))
                next.delete(region);
            else
                next.add(region);
            return next;
        });
    }, []);
    const clearAllFilters = React.useCallback(() => {
        setAccountSearch("");
        setOnlyAccountsWithFreeLp(false);
        setRegionFilter(new Set());
    }, []);
    // Pools currently resizing — block creation in smart mode while true.
    const resizingPools = React.useMemo(() => {
        var _a;
        return ((_a = state.poolInfos) !== null && _a !== void 0 ? _a : []).filter((p) => p.allocationState === "resizing" ||
            p.allocationState === "stopping");
    }, [state.poolInfos]);
    // ---- Per-step validity ----
    const targetStepValid = selectedAccountIds.size > 0 &&
        (smartMode ? resizingPools.length === 0 : true);
    const imageStepValid = osCategory === "linux" || osCategory === "windows";
    const scaleStepValid = (() => {
        if (!smartMode) {
            try {
                const parsed = JSON.parse(poolConfigJson);
                const id = parsed === null || parsed === void 0 ? void 0 : parsed.id;
                return validatePoolId(id) === null;
            }
            catch (_a) {
                return false;
            }
        }
        return validatePoolId(poolIdInput) === null && resizeTimeoutMin >= 5;
    })();
    const networkingStepValid = validateSubnetId(subnetId) === null;
    const tasksStepValid = startTaskCmd.trim().length > 0 && !envHasInvalidNames;
    const stepValidity = {
        target: targetStepValid,
        image: targetStepValid && imageStepValid,
        scale: targetStepValid && imageStepValid && scaleStepValid,
        networking: targetStepValid &&
            imageStepValid &&
            scaleStepValid &&
            networkingStepValid,
        tasks: targetStepValid &&
            imageStepValid &&
            scaleStepValid &&
            networkingStepValid &&
            tasksStepValid,
        review: targetStepValid &&
            imageStepValid &&
            scaleStepValid &&
            networkingStepValid &&
            tasksStepValid,
    };
    const allStepsValid = stepValidity.tasks; // every gate up to tasks passed.
    const goToStep = React.useCallback((key) => {
        setStepState({ step: key });
    }, [setStepState]);
    const stepOrder = STEPS.map((s) => s.key);
    const currentIndex = Math.max(0, stepOrder.indexOf(currentStep));
    const handleContinue = React.useCallback(() => {
        var _a;
        // Re-validate the current step and surface inline errors before advancing.
        if (currentStep === "scale" && smartMode) {
            const idErr = validatePoolId(poolIdInput);
            setPoolIdError(idErr);
            if (idErr) {
                requestAnimationFrame(() => { var _a; return (_a = poolIdFieldRef.current) === null || _a === void 0 ? void 0 : _a.focus(); });
                return;
            }
        }
        if (currentStep === "scale" && !smartMode) {
            try {
                const parsed = JSON.parse(poolConfigJson);
                const idErr = validatePoolId(parsed === null || parsed === void 0 ? void 0 : parsed.id);
                if (idErr) {
                    setConfigError(`Pool config: ${idErr}`);
                    requestAnimationFrame(() => { var _a; return (_a = jsonEditorContainerRef.current) === null || _a === void 0 ? void 0 : _a.focus(); });
                    return;
                }
                setConfigError(null);
            }
            catch (e) {
                setConfigError(`Invalid JSON: ${(_a = e.message) !== null && _a !== void 0 ? _a : "parse error"}`);
                requestAnimationFrame(() => { var _a; return (_a = jsonEditorContainerRef.current) === null || _a === void 0 ? void 0 : _a.focus(); });
                return;
            }
        }
        if (currentStep === "networking") {
            const err = validateSubnetId(subnetId);
            setSubnetError(err);
            if (err) {
                requestAnimationFrame(() => { var _a; return (_a = subnetFieldRef.current) === null || _a === void 0 ? void 0 : _a.focus(); });
                return;
            }
        }
        if (currentStep === "tasks" && !tasksStepValid) {
            requestAnimationFrame(() => { var _a; return (_a = startTaskFieldRef.current) === null || _a === void 0 ? void 0 : _a.focus(); });
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
    const firstInvalidStep = React.useMemo(() => {
        const order = ["target", "image", "scale", "networking", "tasks"];
        for (const k of order) {
            if (!stepValidity[k])
                return k;
        }
        return null;
    }, [stepValidity]);
    // ---- Submit ----
    const handleSubmit = React.useCallback(() => {
        setConfigError(null);
        setPoolIdError(null);
        if (!allStepsValid)
            return;
        if (smartMode && resizingPools.length > 0) {
            setConfigError(`Cannot create pools while ${resizingPools.length} pool(s) are still resizing. Wait for them to finish or stop them first.`);
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
    useShortcut("Mod+Enter", React.useCallback((event) => {
        var _a;
        const target = event.target;
        if (target) {
            const tag = target.tagName;
            if (tag === "TEXTAREA")
                return;
            // Monaco renders inside contenteditable=true descendants — skip.
            const ce = (_a = target.closest("[contenteditable='true']")) !== null && _a !== void 0 ? _a : target.closest(".monaco-editor");
            if (ce)
                return;
        }
        if (isRunning)
            return;
        event.preventDefault();
        if (currentStep === "review") {
            handleSubmit();
        }
        else {
            handleContinue();
        }
    }, [currentStep, isRunning, handleSubmit, handleContinue]), { allowInInputs: true, preventDefault: false });
    // Esc — close the confirmation dialog if open. Doesn't otherwise
    // interfere; the dropdown menus / Monaco / etc. handle their own Esc
    // before this listener (window-level) gets the event.
    useShortcut("Escape", React.useCallback(() => {
        if (!confirmHidden) {
            setConfirmHidden(true);
        }
    }, [confirmHidden]), { allowInInputs: true, preventDefault: false });
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
        if (poolIdInput.trim().length === 0)
            return;
        const snapshot = {
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
    useShortcut("Mod+s", React.useCallback((event) => {
        var _a;
        // Monaco's own Ctrl+S handler should win when focus is inside.
        const target = event.target;
        if (target) {
            const ce = (_a = target.closest("[contenteditable='true']")) !== null && _a !== void 0 ? _a : target.closest(".monaco-editor");
            if (ce)
                return;
        }
        event.preventDefault();
        saveCurrentAsTemplate();
    }, [saveCurrentAsTemplate]), { allowInInputs: true, preventDefault: false });
    // Export / import templates as JSON — the "share with the rest of the
    // org" affordance. A template is a denormalised wizard snapshot
    // (NOT the orchestrator payload), so a JSON exchange is safe to share
    // — no account IDs, no tokens. Schema is captured by the
    // `format: "pool-creation-templates"` envelope so a future
    // schema-version bump can be detected on import.
    const exportTemplates = React.useCallback(() => {
        var _a;
        if (templates.length === 0) {
            store.addNotification({
                type: "info",
                message: "No saved templates to export.",
                autoDismissMs: 2500,
            });
            return;
        }
        const blob = new Blob([
            JSON.stringify({
                format: "pool-creation-templates",
                schemaVersion: 1,
                exportedAt: new Date().toISOString(),
                templates,
            }, null, 2),
        ], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pool-templates-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        auditLog.record({
            actor: (_a = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _a !== void 0 ? _a : "unknown",
            action: "pool_templates:export",
            target: `${templates.length} template(s)`,
            status: "success",
            details: { count: templates.length },
        });
    }, [templates, store, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username]);
    // Hidden file input — clicking the "Import templates" button forwards
    // here. Conservative parser: rejects anything not matching the envelope,
    // drops individual entries that fail per-field validation rather than
    // bailing the whole import.
    const importTemplatesRef = React.useRef(null);
    const handleImportTemplatesFile = React.useCallback((file) => __awaiter(void 0, void 0, void 0, function* () {
        var _u, _v;
        try {
            const text = yield file.text();
            const parsed = JSON.parse(text);
            if ((parsed === null || parsed === void 0 ? void 0 : parsed.format) !== "pool-creation-templates") {
                store.addNotification({
                    type: "error",
                    message: 'Import failed: expected {"format": "pool-creation-templates"} envelope.',
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
            const valid = [];
            const skipped = [];
            for (const candidate of raw) {
                const c = candidate;
                if (typeof c.poolIdPrefix !== "string" ||
                    (c.osCategory !== "linux" && c.osCategory !== "windows") ||
                    typeof c.startTaskCmd !== "string" ||
                    typeof c.resizeTimeoutMin !== "number") {
                    skipped.push((_u = c === null || c === void 0 ? void 0 : c.name) !== null && _u !== void 0 ? _u : "<unnamed>");
                    continue;
                }
                valid.push({
                    id: typeof c.id === "string" && c.id.length > 0 ? c.id : crypto.randomUUID(),
                    name: typeof c.name === "string" ? c.name : c.poolIdPrefix,
                    savedAt: typeof c.savedAt === "string" ? c.savedAt : new Date().toISOString(),
                    poolIdPrefix: c.poolIdPrefix,
                    osCategory: c.osCategory,
                    resizeTimeoutMin: c.resizeTimeoutMin,
                    subnetId: typeof c.subnetId === "string" ? c.subnetId : "",
                    interNodeComm: c.interNodeComm === true,
                    startTaskCmd: c.startTaskCmd,
                    maxRetryCount: typeof c.maxRetryCount === "number" ? c.maxRetryCount : 3,
                    waitForSuccess: c.waitForSuccess !== false,
                    envVars: Array.isArray(c.envVars)
                        ? c.envVars
                            .filter((ev) => ev != null &&
                            typeof ev.name === "string" &&
                            typeof ev.value === "string")
                            .map((ev) => ({ name: ev.name, value: ev.value }))
                        : [],
                    smartMode: c.smartMode !== false,
                    smartVmSizes: Array.isArray(c.smartVmSizes)
                        ? c.smartVmSizes.filter((s) => typeof s === "string")
                        : [],
                });
            }
            setTemplates((prev) => 
            // Dedupe by id, keep imported entries first, cap at the persisted max.
            [...valid, ...prev]
                .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
                .slice(0, POOL_TEMPLATES_MAX));
            store.addNotification({
                type: valid.length > 0 ? "success" : "warning",
                message: `Imported ${valid.length} template(s)` +
                    (skipped.length > 0 ? `; skipped ${skipped.length} malformed entry(ies).` : "."),
                autoDismissMs: 4000,
            });
            auditLog.record({
                actor: (_v = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _v !== void 0 ? _v : "unknown",
                action: "pool_templates:import",
                target: file.name,
                status: "success",
                details: { imported: valid.length, skipped: skipped.length },
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            store.addNotification({
                type: "error",
                message: `Import failed: ${msg}`,
                autoDismissMs: 5000,
            });
        }
    }), [setTemplates, store, primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username]);
    const persistDefaultsFromForm = React.useCallback(() => {
        var _a, _b, _c, _d;
        const updater = store;
        if (typeof updater.updatePoolDefaults !== "function")
            return;
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
                resourceFiles: (_b = (_a = poolDefaults === null || poolDefaults === void 0 ? void 0 : poolDefaults.startTask) === null || _a === void 0 ? void 0 : _a.resourceFiles) !== null && _b !== void 0 ? _b : [],
                userIdentity: (_d = (_c = poolDefaults === null || poolDefaults === void 0 ? void 0 : poolDefaults.startTask) === null || _c === void 0 ? void 0 : _c.userIdentity) !== null && _d !== void 0 ? _d : {
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
    const handleCreate = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _w, _x;
        setConfirmHidden(true);
        // Spin a fresh controller for this submit. Abort any previous in-flight
        // controller first (defensive — UI disables the button while running,
        // but a stale controller could leak through if isRunning was already
        // mid-toggle when handleCreate re-fired).
        (_w = submitAbortRef.current) === null || _w === void 0 ? void 0 : _w.abort();
        const controller = new AbortController();
        submitAbortRef.current = controller;
        const actor = (_x = primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username) !== null && _x !== void 0 ? _x : "unknown";
        const submitTarget = `${selectedAccountIds.size} account(s)`;
        // Inlined re-derivation of the planned-VM count and cross-sub flag so
        // the useCallback dep array stays free of the post-callback `const`s
        // (referencing those in deps would be a TDZ error at first render).
        const plannedVmCount = smartMode && liveCatalogEffective && smartVmSizes.length > 0
            ? smartVmSizes.length
            : smartMode
                ? getAllVmSizes().length
                : 1;
        const distinctSubsInSelection = new Set();
        {
            const acctById = new Map(state.accounts.map((a) => [a.id, a]));
            for (const id of selectedAccountIds) {
                const acc = acctById.get(id);
                if (acc)
                    distinctSubsInSelection.add(acc.subscriptionId);
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
                const allVmNames = liveCatalogEffective && smartVmSizes.length > 0
                    ? smartVmSizes
                    : getAllVmSizes().map((v) => v.name);
                const environmentSettings = envVars
                    .filter((ev) => ev.name.trim() !== "")
                    .map((ev) => ({ name: ev.name, value: ev.value }));
                let poolConfig;
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
                }
                else {
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
                yield orchestrator.execute({
                    action: "create_pools_smart",
                    payload: {
                        accountIds: Array.from(selectedAccountIds),
                        vmSizes: allVmNames,
                        poolConfig,
                        quotaType: "lowPriority",
                    },
                    signal: controller.signal,
                });
            }
            else {
                const poolConfig = JSON.parse(poolConfigJson);
                poolConfig.targetDedicatedNodes = 0;
                yield orchestrator.execute({
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
            setCreationAnnouncement(`Pool creation dispatch completed for ${selectedAccountIds.size} account${selectedAccountIds.size === 1 ? "" : "s"}. Check the Pool Results table below for per-account status.`);
            // Save the just-dispatched config as a template (cap at the last N).
            // Skipped if every field matches the most recent template — avoids
            // the operator ending up with five identical entries from clicking
            // Create on the same config repeatedly.
            const snapshot = {
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
                const dupOfLatest = prev[0] &&
                    prev[0].poolIdPrefix === snapshot.poolIdPrefix &&
                    prev[0].osCategory === snapshot.osCategory &&
                    prev[0].resizeTimeoutMin === snapshot.resizeTimeoutMin &&
                    prev[0].subnetId === snapshot.subnetId &&
                    prev[0].interNodeComm === snapshot.interNodeComm &&
                    prev[0].startTaskCmd === snapshot.startTaskCmd &&
                    prev[0].maxRetryCount === snapshot.maxRetryCount &&
                    prev[0].waitForSuccess === snapshot.waitForSuccess &&
                    prev[0].smartMode === snapshot.smartMode;
                if (dupOfLatest)
                    return prev;
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
        }
        catch (e) {
            // Distinguish operator-driven abort from real errors so we don't
            // surface a scary banner for "I clicked Stop".
            const aborted = controller.signal.aborted ||
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
            }
            else {
                const message = e instanceof Error ? e.message : "Unknown pool-creation error";
                if (e instanceof SyntaxError) {
                    setConfigError(`Invalid JSON: ${message}`);
                }
                else if (e instanceof Error) {
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
        }
        finally {
            setIsRunning(false);
            if (submitAbortRef.current === controller) {
                submitAbortRef.current = null;
            }
        }
    }), [
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
        primaryAccount === null || primaryAccount === void 0 ? void 0 : primaryAccount.username,
        liveCatalogEffective,
        state.accounts,
        store,
    ]);
    // Load a saved template into the wizard. Replaces every field the
    // template captured; leaves account picks alone (different runs target
    // different accounts even when the config is identical).
    const loadTemplate = React.useCallback((t) => {
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
    }, [store]);
    const deleteTemplate = React.useCallback((id) => {
        setTemplates((prev) => prev.filter((t) => t.id !== id));
    }, [setTemplates]);
    const handleRetryFailedPools = React.useCallback(() => {
        const ids = store.retryFailedPools();
        store.addNotification({
            type: "info",
            message: `Retrying ${ids.length} failed pool(s)...`,
            autoDismissMs: 5000,
        });
    }, [store]);
    const failedPoolCount = state.pools.filter((p) => p.provisioningState === "failed").length;
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
    const effectiveSmartVmCount = liveCatalogEffective && smartVmSizes.length > 0
        ? smartVmSizes.length
        : getAllVmSizes().length;
    const targetVmCount = smartMode ? effectiveSmartVmCount : 1;
    const totalPoolsPlanned = selectedAccountIds.size * targetVmCount;
    const targetNodesPerPool = smartMode
        ? "fill remaining LP quota"
        : (() => {
            var _a;
            try {
                const cfg = JSON.parse(poolConfigJson);
                return String((_a = cfg.targetLowPriorityNodes) !== null && _a !== void 0 ? _a : 0);
            }
            catch (_b) {
                return "?";
            }
        })();
    // Tally selected accounts by owning sub so the confirmation can call
    // out a cross-sub dispatch explicitly. An operator who didn't notice
    // they ticked accounts from two different subs really wants this
    // visible before they press Create — once the request leaves the UI
    // there's no rollback path.
    const selectedAccountsBySub = React.useMemo(() => {
        const byId = new Map(state.accounts.map((a) => [a.id, a]));
        const map = new Map();
        selectedAccountIds.forEach((id) => {
            var _a, _b;
            const acc = byId.get(id);
            const subId = (_a = acc === null || acc === void 0 ? void 0 : acc.subscriptionId) !== null && _a !== void 0 ? _a : "(unknown)";
            map.set(subId, ((_b = map.get(subId)) !== null && _b !== void 0 ? _b : 0) + 1);
        });
        return Array.from(map.entries()).map(([subId, count]) => {
            var _a;
            const sub = state.subscriptions.find((s) => s.subscriptionId === subId);
            return {
                subId,
                count,
                displayName: (_a = sub === null || sub === void 0 ? void 0 : sub.displayName) !== null && _a !== void 0 ? _a : subId.slice(0, 8) + "…",
                ownerAccountLabel: sub === null || sub === void 0 ? void 0 : sub.ownerAccountLabel,
            };
        });
    }, [selectedAccountIds, state.accounts, state.subscriptions]);
    const crossSubDispatch = selectedAccountsBySub.length > 1;
    // ---- Attack-surface preview (corpus-grounded warnings) ----
    // Recomputed on every relevant field change — cheap (constant work in
    // the number of envVars / start-task length). Rendered on the Review
    // pane so the operator sees it before pressing Create.
    const attackSurfaceFindings = React.useMemo(() => analyzeAttackSurface({
        subnetId,
        startTaskCmd,
        // The submit path hardcodes admin elevation in handleCreate;
        // keep the analyzer in sync with that source of truth.
        elevationLevel: "admin",
        envVars,
        smartMode,
        selectedAccountCount: selectedAccountIds.size,
        crossSubDispatch,
    }), [
        subnetId,
        startTaskCmd,
        envVars,
        smartMode,
        selectedAccountIds.size,
        crossSubDispatch,
    ]);
    const worstSeverity = React.useMemo(() => {
        if (attackSurfaceFindings.some((f) => f.severity === "destructive"))
            return "destructive";
        if (attackSurfaceFindings.some((f) => f.severity === "warning"))
            return "warning";
        if (attackSurfaceFindings.length > 0)
            return "info";
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
    const previewJsonString = React.useMemo(() => JSON.stringify(putBodyPreview.body, null, 2), [putBodyPreview]);
    const confirmMessage = (React.createElement("div", { className: "space-y-2 text-sm leading-relaxed" },
        React.createElement("p", { className: "m-0" },
            "Create ",
            React.createElement("strong", { className: "text-foreground" }, totalPoolsPlanned),
            " ",
            "pool(s) across",
            " ",
            React.createElement("strong", { className: "text-foreground" }, selectedAccountIds.size),
            " ",
            "account(s)",
            crossSubDispatch && (React.createElement(React.Fragment, null,
                " ",
                "from",
                " ",
                React.createElement("strong", { className: "text-foreground" },
                    selectedAccountsBySub.length,
                    " subscriptions"))),
            smartMode && (React.createElement(React.Fragment, null,
                ", trying up to",
                " ",
                React.createElement("strong", { className: "text-foreground" }, targetVmCount),
                " VM size(s) per account in priority order")),
            "."),
        crossSubDispatch && (React.createElement("div", { className: "rounded-md border border-border bg-surface-sunken/60 px-3 py-2 text-xs" },
            React.createElement("div", { className: "font-semibold text-foreground" }, "Per-subscription breakdown"),
            React.createElement("ul", { className: "mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground" }, selectedAccountsBySub.map((row) => (React.createElement("li", { key: row.subId },
                React.createElement("span", { className: "text-foreground" }, row.displayName),
                row.ownerAccountLabel && (React.createElement("span", null,
                    " \u00B7 ",
                    row.ownerAccountLabel)),
                ": ",
                React.createElement("strong", { className: "text-foreground" }, row.count),
                " ",
                "account",
                row.count === 1 ? "" : "s")))),
            React.createElement("p", { className: "mt-1.5 text-2xs leading-relaxed" }, "Pool dispatch uses a per-account Batch token so accounts owned by different AAD identities can be hit in the same run."))),
        React.createElement("p", { className: "m-0" },
            "Target nodes per pool:",
            " ",
            React.createElement("strong", { className: "text-foreground" }, targetNodesPerPool),
            " ",
            "(low-priority)."),
        saveAsDefault && (React.createElement("p", { className: "m-0 text-info" }, "Settings will also be saved as your pool defaults.")),
        React.createElement("p", { className: "m-0 text-muted-foreground" }, "This action will create live Azure resources. Continue?")));
    const handleRetryDecrement = () => {
        setMaxRetryCount((n) => Math.max(0, n - 1));
    };
    const handleRetryIncrement = () => {
        setMaxRetryCount((n) => Math.min(100, n + 1));
    };
    const handleRetryChange = (raw) => {
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
    const handlePoolIdChange = (v) => {
        setPoolIdInput(v);
        if (poolIdError) {
            setPoolIdError(validatePoolId(v));
        }
    };
    const handleSubnetChange = (v) => {
        setSubnetId(v);
        if (subnetError) {
            setSubnetError(validateSubnetId(v));
        }
    };
    // ---- Render --------------------------------------------------------------
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4", role: "region", "aria-labelledby": "pool-creation-heading" },
        React.createElement(PageHeader, { title: "Pool Creation", titleId: "pool-creation-heading", description: "Provision GPU pools across selected Azure Batch accounts." },
            React.createElement(TokenExpiryBadge, { secondsUntilExpiry: armTokenTracker.secondsUntilExpiry, loading: armTokenTracker.loading, onRefresh: () => void armTokenTracker.refresh() }),
            failedPoolCount > 0 && !isRunning && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleRetryFailedPools, "aria-label": `Retry ${failedPoolCount} failed pools` },
                React.createElement(RotateCw, { className: "h-3.5 w-3.5" }),
                "Retry Failed Pools (",
                failedPoolCount,
                ")"))),
        React.createElement(Tabs, { value: currentStep, onValueChange: (value) => goToStep(value), orientation: "horizontal" },
            React.createElement(AnimatedTabs, { size: "sm", "aria-label": "Pool creation steps", value: currentStep, onChange: (id) => goToStep(id), tabs: STEPS.map((step, idx) => {
                    const Icon = step.icon;
                    const reachable = idx === 0 || stepValidity[step.key];
                    const isCurrent = step.key === currentStep;
                    const isComplete = !isCurrent && idx < currentIndex && stepValidity[step.key];
                    const isDisabled = !reachable && !isCurrent;
                    const LeadIcon = isComplete ? Check : isDisabled ? Lock : Icon;
                    return {
                        id: step.key,
                        disabled: isDisabled,
                        label: (React.createElement("span", { className: "inline-flex items-center gap-1.5" },
                            React.createElement(LeadIcon, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                            React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider tabular-nums opacity-80" }, idx + 1),
                            React.createElement("span", null, step.label))),
                    };
                }) }),
            React.createElement(TabsContent, { value: "target", className: "flex flex-col gap-3" },
                React.createElement("input", { ref: importTemplatesRef, type: "file", accept: "application/json,.json", className: "hidden", "aria-hidden": true, tabIndex: -1, onChange: (e) => {
                        var _a;
                        const file = (_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0];
                        if (file)
                            void handleImportTemplatesFile(file);
                        // Reset so the same file can be re-selected.
                        e.target.value = "";
                    } }),
                React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border bg-surface-sunken/40 p-2", role: "group", "aria-label": "Saved pool templates" },
                    React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Templates"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: saveCurrentAsTemplate, disabled: poolIdInput.trim().length === 0, "aria-label": "Save current wizard form as a template (Ctrl+S)", title: "Save current wizard form (Ctrl+S)", className: "gap-1.5" },
                        React.createElement(Save, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Save current"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: exportTemplates, disabled: templates.length === 0, "aria-label": "Export saved templates as JSON", title: "Export saved templates as JSON (sharable across the org)", className: "gap-1.5" },
                        React.createElement(Download, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Export"),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => { var _a; return (_a = importTemplatesRef.current) === null || _a === void 0 ? void 0 : _a.click(); }, "aria-label": "Import shared templates from a JSON file", title: "Import templates from a JSON file (the schema is the same as Export)", className: "gap-1.5" },
                        React.createElement(Upload, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Import"),
                    templates.length === 0 && (React.createElement("span", { className: "text-2xs italic text-muted-foreground" }, "No templates yet \u2014 save one with the button above or import a JSON file shared by a teammate."))),
                templates.length > 0 && (React.createElement("div", { className: "flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border bg-surface-sunken/40 p-2", role: "group", "aria-label": "Saved pool templates" },
                    React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Templates"),
                    React.createElement(DropdownMenu, null,
                        React.createElement(DropdownMenuTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", "aria-label": `Load a saved pool template (${templates.length} available)`, className: "gap-1.5" },
                                React.createElement(Sparkles, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                "Load template",
                                React.createElement("span", { className: "ml-1 rounded-full bg-muted px-1.5 text-2xs font-semibold tabular-nums text-muted-foreground" }, templates.length))),
                        React.createElement(DropdownMenuContent, { align: "start", className: "max-h-72 w-[min(28rem,80vw)] overflow-y-auto" },
                            React.createElement(DropdownMenuLabel, null,
                                "Last ",
                                templates.length,
                                " successful config(s)"),
                            React.createElement(DropdownMenuSeparator, null),
                            templates.map((t) => (React.createElement("div", { key: t.id, className: "flex items-start gap-2 px-2 py-1.5 hover:bg-accent/40" },
                                React.createElement("button", { type: "button", onClick: () => loadTemplate(t), className: "flex flex-1 flex-col items-start gap-0.5 text-left focus-visible:outline-none", "aria-label": `Load template ${t.name}` },
                                    React.createElement("span", { className: "text-xs font-semibold text-foreground" }, t.name),
                                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                                        new Date(t.savedAt).toLocaleString(),
                                        " \u00B7",
                                        " ",
                                        t.smartMode ? "smart" : "manual",
                                        " \u00B7 ",
                                        t.osCategory),
                                    React.createElement("span", { className: "line-clamp-1 max-w-full font-mono text-3xs text-muted-foreground" }, t.startTaskCmd)),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => deleteTemplate(t.id), "aria-label": `Delete template ${t.name}`, className: "text-muted-foreground hover:text-destructive" },
                                    React.createElement(Trash2, { className: "h-3 w-3" }))))))),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "Auto-saved after each successful dispatch (last",
                        " ",
                        POOL_TEMPLATES_MAX,
                        "). Loads every field except account picks."))),
                state.subscriptions.length > 0 && (React.createElement("div", { className: "flex max-w-[28rem] flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: subscriptionFieldId },
                        "Subscriptions",
                        selectedSubIds.length > 0 && (React.createElement("span", { className: "ml-2 text-2xs font-normal text-muted-foreground" },
                            "(",
                            selectedSubIds.length,
                            " selected)"))),
                    React.createElement(DropdownMenu, null,
                        React.createElement(DropdownMenuTrigger, { asChild: true },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", id: subscriptionFieldId, "aria-label": "Azure subscriptions filter", className: "justify-between" },
                                React.createElement("span", { className: "truncate" }, selectedSubIds.length === 0
                                    ? "All subscriptions"
                                    : selectedSubIds.length === 1
                                        ? (_j = (_h = state.subscriptions.find((s) => s.subscriptionId === selectedSubIds[0])) === null || _h === void 0 ? void 0 : _h.displayName) !== null && _j !== void 0 ? _j : selectedSubIds[0]
                                        : `${selectedSubIds.length} subscriptions`),
                                React.createElement("span", { className: "ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-2xs font-semibold text-primary" }, selectedSubIds.length || "All"))),
                        React.createElement(DropdownMenuContent, { align: "start", className: "max-h-72 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto" },
                            React.createElement(DropdownMenuLabel, null, "Filter accounts by sub"),
                            React.createElement(DropdownMenuSeparator, null),
                            (() => {
                                var _a;
                                // Group by owning AAD account so an operator with
                                // multiple signed-in accounts can disambiguate subs
                                // that share a tenant. Single-account setups render
                                // unchanged (no group headers when only one owner).
                                const groups = new Map();
                                for (const s of state.subscriptions) {
                                    const k = s.ownerAccountLabel ||
                                        s.homeAccountId ||
                                        "Active account";
                                    const arr = (_a = groups.get(k)) !== null && _a !== void 0 ? _a : [];
                                    arr.push(s);
                                    groups.set(k, arr);
                                }
                                const entries = Array.from(groups.entries());
                                const showHeaders = entries.length > 1;
                                return entries.flatMap(([owner, subs]) => {
                                    const items = [];
                                    if (showHeaders) {
                                        items.push(React.createElement(DropdownMenuLabel, { key: `hdr-${owner}`, className: "text-2xs font-semibold uppercase tracking-wide text-muted-foreground" }, owner));
                                    }
                                    for (const s of subs) {
                                        const checked = selectedSubIds.includes(s.subscriptionId);
                                        const isAmbiguous = ambiguousSubIds.has(s.subscriptionId);
                                        items.push(React.createElement(DropdownMenuCheckboxItem, { key: s.subscriptionId, checked: checked, onSelect: (e) => e.preventDefault(), onCheckedChange: () => toggleSubSelection(s.subscriptionId) },
                                            React.createElement("span", { className: "font-medium" }, s.displayName),
                                            React.createElement("span", { className: "ml-2 font-mono text-2xs text-muted-foreground" },
                                                s.subscriptionId.substring(0, 8),
                                                "\u2026"),
                                            isAmbiguous && s.homeAccountId && (React.createElement("span", { className: "ml-2 inline-flex items-center rounded-sm bg-warning/15 px-1 text-2xs font-mono text-warning", title: `Disambiguator: homeAccountId ${s.homeAccountId}` },
                                                "acct ",
                                                s.homeAccountId.slice(0, 6),
                                                "\u2026"))));
                                    }
                                    return items;
                                });
                            })())),
                    autoSelectedSubscription && selectedSubIds.length === 1 && (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Auto-selected your only subscription")),
                    selectedSubIds.length === 0 &&
                        state.subscriptions.length > 1 && (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "Showing accounts from all ",
                        state.subscriptions.length,
                        " ",
                        "subscriptions. Pick one or more to narrow the list.")),
                    selectedSubIds.length > 0 && (React.createElement("div", { className: "mt-1 flex flex-wrap gap-1", "aria-label": "Selected subscriptions" }, selectedSubIds.map((id) => {
                        var _a, _b;
                        const sub = state.subscriptions.find((s) => s.subscriptionId === id);
                        const isAmbiguous = ambiguousSubIds.has(id);
                        return (React.createElement("span", { key: id, className: "inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-2xs text-foreground", title: `subscriptionId ${id}${(sub === null || sub === void 0 ? void 0 : sub.homeAccountId) ? ` · homeAccountId ${sub.homeAccountId}` : ""}` },
                            React.createElement("span", { className: "font-medium" }, (_a = sub === null || sub === void 0 ? void 0 : sub.displayName) !== null && _a !== void 0 ? _a : id.slice(0, 8) + "…"),
                            React.createElement("span", { className: "font-mono text-muted-foreground" },
                                id.slice(0, 8),
                                "\u2026"),
                            (sub === null || sub === void 0 ? void 0 : sub.ownerAccountLabel) && (React.createElement("span", { className: "text-muted-foreground" },
                                "\u00B7 ",
                                sub.ownerAccountLabel)),
                            isAmbiguous && (sub === null || sub === void 0 ? void 0 : sub.homeAccountId) && (React.createElement("span", { className: "font-mono text-warning" },
                                "(acct ",
                                sub.homeAccountId.slice(0, 6),
                                "\u2026)")),
                            React.createElement("button", { type: "button", onClick: () => toggleSubSelection(id), className: "rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", "aria-label": `Remove ${(_b = sub === null || sub === void 0 ? void 0 : sub.displayName) !== null && _b !== void 0 ? _b : id}` },
                                React.createElement("span", { "aria-hidden": true }, "x"))));
                    }))))),
                React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken/40 p-2.5" },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleDiscoverAccounts, disabled: discoverProgress !== null &&
                            discoverProgress.completed < discoverProgress.total, loading: discoverProgress !== null &&
                            discoverProgress.completed < discoverProgress.total, "aria-label": "Discover Batch accounts in selected subscriptions", className: "gap-1.5" },
                        React.createElement(RotateCw, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        discoverProgress &&
                            discoverProgress.completed < discoverProgress.total
                            ? `Discovering ${discoverProgress.completed}/${discoverProgress.total}…`
                            : selectedSubIds.length === 0
                                ? `Discover accounts (all ${state.subscriptions.length} subs)`
                                : `Discover accounts (${selectedSubIds.length} sub${selectedSubIds.length === 1 ? "" : "s"})`),
                    React.createElement("span", { className: "text-2xs text-muted-foreground" }, "Pulls Batch accounts from each selected subscription using its owning AAD identity \u2014 required when the page shows no accounts despite valid sign-ins."),
                    discoverProgress &&
                        discoverProgress.completed === discoverProgress.total && (React.createElement("span", { className: "ml-auto text-2xs font-medium text-success" },
                        "\u2713 Discovery complete (+",
                        discoverProgress.importedTotal,
                        " new)"))),
                discoverError && (React.createElement(Alert, { variant: "destructive", role: "alert" },
                    React.createElement(AlertDescription, { className: "text-xs" },
                        "Discovery error: ",
                        discoverError))),
                accountsLoading ? (React.createElement("div", { "aria-busy": "true" },
                    React.createElement(SkeletonLoader, { variant: "table", rows: 4, columns: 2 }))) : eligibleAccountsRaw.length === 0 ? (React.createElement(EmptyState, { icon: Server, title: "No eligible accounts", description: state.subscriptions.length > 0
                        ? "Click Discover accounts above to pull Batch accounts from your selected subscriptions, or provision new ones via the Account Provisioning page."
                        : "Sign in to an Azure account before creating pools.", action: state.subscriptions.length > 0
                        ? {
                            label: "Discover accounts",
                            onClick: handleDiscoverAccounts,
                            icon: RotateCw,
                            loading: discoverProgress !== null &&
                                discoverProgress.completed < discoverProgress.total,
                        }
                        : undefined })) : (React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "flex flex-wrap gap-2", role: "group", "aria-label": "Eligible-accounts summary" },
                        React.createElement(SummaryStatItem, { label: "Eligible", value: eligibleAccounts.length, hint: eligibleAccounts.length === eligibleAccountsRaw.length
                                ? undefined
                                : `of ${eligibleAccountsRaw.length}`, compact: true }),
                        React.createElement(SummaryStatItem, { label: "With free LP", value: accountStats.withFreeLp, tone: accountStats.withFreeLp > 0 ? "success" : "muted", compact: true }),
                        React.createElement(SummaryStatItem, { label: "Free LP cores", value: accountStats.totalFreeLp, tone: accountStats.totalFreeLp > 0 ? "info" : "muted", compact: true }),
                        React.createElement(SummaryStatItem, { label: "Selected", value: selectedAccountIds.size, tone: selectedAccountIds.size > 0 ? "info" : "muted", hint: selectedAccountIds.size > 0
                                ? `${selectedStats.totalFreeLp.toLocaleString()} LP cores`
                                : undefined, compact: true })),
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2", role: "toolbar", "aria-label": "Account filters and bulk actions" },
                        React.createElement("div", { className: "relative w-full max-w-[20rem]" },
                            React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                            React.createElement(Input, { type: "search", placeholder: "Search account, region, sub\u2026", value: accountSearch, onChange: (e) => setAccountSearch(e.target.value), "aria-label": "Filter accounts by name, region, or subscription", className: "pl-7" })),
                        availableRegions.length > 1 && (React.createElement(DropdownMenu, null,
                            React.createElement(DropdownMenuTrigger, { asChild: true },
                                React.createElement(Button, { type: "button", variant: "outline", size: "sm", "aria-label": "Filter accounts by region", className: "gap-1.5" },
                                    "Regions",
                                    regionFilter.size > 0 && (React.createElement("span", { className: "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-2xs font-semibold text-primary" }, regionFilter.size)))),
                            React.createElement(DropdownMenuContent, { align: "start", className: "max-h-72 overflow-y-auto" },
                                React.createElement(DropdownMenuLabel, null, "Filter by region"),
                                React.createElement(DropdownMenuSeparator, null),
                                availableRegions.map((region) => (React.createElement(DropdownMenuCheckboxItem, { key: region, checked: regionFilter.has(region), onSelect: (e) => e.preventDefault(), onCheckedChange: () => toggleRegionFilter(region) },
                                    React.createElement("span", { className: "font-mono text-xs" }, region))))))),
                        React.createElement("label", { className: "flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-sunken/40 px-2 py-1 text-xs" },
                            React.createElement(Switch, { checked: onlyAccountsWithFreeLp, onCheckedChange: (checked) => setOnlyAccountsWithFreeLp(checked), "aria-label": "Show only accounts with free low-priority cores" }),
                            React.createElement("span", null, "Only with free LP"),
                            React.createElement(InfoTooltip, { side: "top", content: "Hides accounts whose lowPriorityCoresFree is 0 or whose quota hasn't been refreshed yet. Useful before a Smart-mode dispatch \u2014 accounts with zero free LP yield no pools and only clutter the summary." })),
                        (accountSearch ||
                            onlyAccountsWithFreeLp ||
                            regionFilter.size > 0) && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearAllFilters, "aria-label": "Clear all filters", className: "gap-1" },
                            React.createElement(Eraser, { className: "h-3.5 w-3.5" }),
                            "Clear filters")),
                        React.createElement("div", { className: "ml-auto flex flex-wrap items-center gap-1", role: "group", "aria-label": "Bulk selection actions" },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: selectAllVisible, disabled: eligibleAccounts.length === 0, "aria-label": "Select all visible accounts", title: "Add every visible row to the selection" }, "Select all visible"),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: selectVisibleWithFreeLp, disabled: accountStats.withFreeLp === 0, "aria-label": "Select visible accounts with free low-priority cores", title: "Add only the visible rows that report lowPriorityCoresFree > 0" },
                                "With free LP (",
                                accountStats.withFreeLp,
                                ")"),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: invertVisibleSelection, disabled: eligibleAccounts.length === 0, "aria-label": "Invert visible selection", title: "Tick the unticked visible rows and untick the ticked ones" }, "Invert"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearAllSelection, disabled: selectedAccountIds.size === 0, "aria-label": "Clear selected accounts", title: "Untick every row, regardless of filter" },
                                "Clear (",
                                selectedAccountIds.size,
                                ")"))),
                    eligibleAccounts.length === 0 ? (React.createElement(EmptyState, { icon: Search, title: "No accounts match the current filters", description: "Loosen the search, region picker, or 'Only with free LP' toggle to see more accounts.", size: "compact", action: {
                            label: "Clear filters",
                            onClick: clearAllFilters,
                            icon: Eraser,
                        } })) : (React.createElement(DataTable, { tableId: "pool-creation-eligible-accounts", rows: eligibleAccounts, columns: accountColumns, rowKey: (row) => row.id, selection: selectedAccountIds, onSelectionChange: setSelectedAccountIds, csvFileName: "eligible-accounts.csv", initialSort: { column: "freeLp", direction: "desc" }, empty: React.createElement(EmptyState, { icon: Server, title: "No eligible accounts", description: "No accounts in this subscription match the eligibility filter." }) })))),
                selectedAccountIds.size > 0 && (React.createElement(Alert, { variant: selectedStats.totalFreeLp === 0 && selectedStats.staleCount === 0
                        ? "warning"
                        : "info" },
                    React.createElement(AlertDescription, null,
                        React.createElement("strong", { className: "text-foreground" }, selectedAccountIds.size),
                        " ",
                        "account(s) selected",
                        selectedStats.staleCount === 0 && (React.createElement(React.Fragment, null,
                            " ",
                            "\u2014",
                            " ",
                            React.createElement("strong", { className: "text-foreground" }, selectedStats.totalFreeLp.toLocaleString()),
                            " ",
                            "free LP cores total")),
                        selectedStats.withZeroLp > 0 && (React.createElement("span", { className: "ml-1 text-warning" },
                            "(",
                            selectedStats.withZeroLp,
                            " with zero LP \u2014 Smart Mode will skip them)")),
                        selectedStats.staleCount > 0 && (React.createElement("span", { className: "ml-1 text-muted-foreground" },
                            "(",
                            selectedStats.staleCount,
                            " with stale quota \u2014 re-run Discover accounts for live numbers)"))))),
                React.createElement("div", { className: cn("flex flex-wrap items-center gap-3 rounded-md border p-3 transition-colors duration-200 ease-out motion-reduce:transition-none", smartMode
                        ? "border-primary/40 bg-primary/5 shadow-sm"
                        : "border-border bg-card") },
                    React.createElement(Lightbulb, { className: cn("h-4 w-4 shrink-0", smartMode ? "text-primary" : "text-muted-foreground"), "aria-hidden": true }),
                    React.createElement(Switch, { id: smartModeId, checked: smartMode, onCheckedChange: (checked) => setSmartMode(checked), "aria-label": "Toggle smart mode for pool creation" }),
                    React.createElement(Label, { htmlFor: smartModeId, className: "inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-foreground" },
                        "Smart Mode",
                        React.createElement("span", { className: cn("ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider", smartMode
                                ? "bg-primary/15 text-primary"
                                : "bg-muted text-muted-foreground") }, "Recommended"),
                        React.createElement(InfoTooltip, { side: "top", content: "ON: the orchestrator iterates the VM-size list (default 5 GPU SKUs, or your picks) and creates one pool per (account \u00D7 SKU) that has free LP quota, sized to fill the remaining cores. OFF: you paste a single Azure Batch pool JSON spec and that exact pool is created on every selected account." })),
                    React.createElement("span", { className: "text-xs text-muted-foreground" }, smartMode
                        ? "Auto-fills LP quota across selected accounts"
                        : "Manual JSON pool config"),
                    smartMode && (React.createElement("span", { className: "ml-auto flex items-center gap-3 text-2xs tabular-nums text-muted-foreground" },
                        React.createElement("span", null,
                            React.createElement("strong", { className: "text-foreground" }, selectedAccountIds.size),
                            " ",
                            "acct"),
                        React.createElement("span", { "aria-hidden": true }, "\u00B7"),
                        React.createElement("span", null,
                            React.createElement("strong", { className: "text-foreground" }, effectiveSmartVmCount),
                            " ",
                            "VM size",
                            effectiveSmartVmCount === 1 ? "" : "s"),
                        React.createElement("span", { "aria-hidden": true }, "\u00B7"),
                        React.createElement("span", null,
                            React.createElement("strong", { className: "text-info" }, totalPoolsPlanned),
                            " ",
                            "pool",
                            totalPoolsPlanned === 1 ? "" : "s",
                            " planned")))),
                smartMode && resizingPools.length > 0 && (React.createElement(Alert, { variant: "warning" },
                    React.createElement(AlertDescription, null,
                        resizingPools.length,
                        " pool(s) are currently resizing. Pool creation is blocked until they finish."))),
                !targetStepValid && selectedAccountIds.size === 0 && (React.createElement("p", { className: "text-xs text-muted-foreground", id: "target-step-hint" }, "Select at least one account to continue."))),
            React.createElement(TabsContent, { value: "image", className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex max-w-[28rem] flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: osCategoryFieldId, className: "inline-flex items-center gap-1.5" },
                        "OS Category",
                        React.createElement(InfoTooltip, { side: "top", content: "Picks the node-agent SKU + the default image reference from your Pool Defaults. Switch to Windows for HPC/CUDA workloads that need WSL-free Windows Server, or stay on Linux for the cheaper, more common ND/NC GPU SKUs." })),
                    React.createElement(Select, { value: osCategory, onValueChange: (v) => setOsCategory(v) },
                        React.createElement(SelectTrigger, { id: osCategoryFieldId, "aria-label": "Operating system category" },
                            React.createElement(SelectValue, { placeholder: "Select OS" })),
                        React.createElement(SelectContent, null,
                            React.createElement(SelectItem, { value: "linux" }, "Linux"),
                            React.createElement(SelectItem, { value: "windows" }, "Windows"))),
                    React.createElement("span", { className: "text-xs text-muted-foreground" }, "Image is taken from your pool defaults: Ubuntu 22.04 / Windows Server 2022. Edit images on the Pool Defaults page.")),
                smartMode && (React.createElement("div", { className: "flex flex-wrap items-center gap-2", "aria-label": "VM sizes used by smart mode" },
                    React.createElement("span", { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "VM sizes"),
                    React.createElement("label", { className: cn("flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-2xs font-medium", catalogAvailability.available
                            ? "cursor-pointer text-muted-foreground hover:bg-muted/40"
                            : "cursor-not-allowed text-muted-foreground/50"), title: !catalogAvailability.available
                            ? "Live catalog cache is empty. Open the VM Catalog page to populate it (cached 7 days), then this toggle activates."
                            : liveCatalogEffective
                                ? `Live catalog is wired in (${catalogAvailability.count} SKUs cached). Click to disable and use the hardcoded 5-VM fallback.`
                                : "Live catalog is disabled. Click to enable the picker and pull from Microsoft.Compute/skus." },
                        React.createElement(Switch, { checked: liveCatalogEffective, onCheckedChange: toggleLiveCatalog, disabled: !catalogAvailability.available, "aria-label": "Toggle live VM catalog" }),
                        "Live catalog",
                        catalogAvailability.available ? (React.createElement("span", { className: "ml-1 text-2xs opacity-70 tabular-nums" }, catalogAvailability.count)) : (React.createElement("span", { className: "ml-1 text-2xs italic opacity-70" }, "not loaded"))),
                    catalogAvailability.available && catalogAgeLabel && (React.createElement("span", { className: "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-foreground", title: `VM-catalog cache last refreshed ${catalogAgeLabel}. Cache TTL is 7 days for VM SKUs.`, "aria-label": `VM catalog last updated ${catalogAgeLabel}` },
                        "Last updated ",
                        catalogAgeLabel)),
                    subscriptionId && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: handleRefreshCatalog, "aria-label": "Refresh VM catalog cache", title: "Clears the cached SKU set for this subscription. Visit the VM Catalog page to repopulate.", className: "h-7 gap-1 text-2xs text-muted-foreground" },
                        React.createElement(RotateCw, { className: "h-3 w-3" }),
                        "Refresh catalog")),
                    liveCatalogEffective && (React.createElement(LiveVmSizeSelect, { multi: true, value: smartVmSizes, onChange: setSmartVmSizes, subscriptionId: subscriptionId || undefined, placeholder: `Default GPU set (${getAllVmSizes().length})`, density: "compact" })),
                    liveCatalogEffective && smartVmSizes.length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setSmartVmSizes([]), "aria-label": "Clear VM-size picks and fall back to the default GPU set", title: "Drops the picker selection so Smart Mode uses the default 5-VM GPU set", className: "gap-1 text-muted-foreground" },
                        React.createElement(Eraser, { className: "h-3.5 w-3.5" }),
                        "Reset to default")),
                    (() => {
                        const items = liveCatalogEffective && smartVmSizes.length > 0
                            ? smartVmSizes.map((name) => {
                                var _a, _b;
                                const info = getVmSizeInfo(name);
                                const isGpu = (_a = info === null || info === void 0 ? void 0 : info.isGpu) !== null && _a !== void 0 ? _a : /^Standard_(ND|NC|NV|NG)/i.test(name);
                                return {
                                    name,
                                    isGpu,
                                    gpuType: (_b = info === null || info === void 0 ? void 0 : info.gpuType) !== null && _b !== void 0 ? _b : "",
                                };
                            })
                            : getAllVmSizes().map((v) => {
                                var _a;
                                return ({
                                    name: v.name,
                                    isGpu: v.isGpu === true,
                                    gpuType: (_a = v.gpuType) !== null && _a !== void 0 ? _a : "",
                                });
                            });
                        // Group: known GPU types first (H100 → A100 → V100 → other),
                        // CPU/unknown last. Stable within each group.
                        const order = ["H100", "A100", "V100"];
                        const grouped = [
                            ...order.map((t) => items.filter((i) => i.gpuType === t)),
                            items.filter((i) => i.isGpu && !order.includes(i.gpuType)),
                            items.filter((i) => !i.isGpu),
                        ].filter((g) => g.length > 0);
                        // Color rule: H100=default(primary), A100=info,
                        // V100=secondary, other GPU=info, non-GPU=secondary.
                        // Badge has no `primary` variant — `default` is the
                        // primary-toned one in this design system.
                        const variantFor = (it) => {
                            if (!it.isGpu)
                                return "secondary";
                            if (it.gpuType === "H100")
                                return "default";
                            if (it.gpuType === "A100")
                                return "info";
                            if (it.gpuType === "V100")
                                return "secondary";
                            return "info";
                        };
                        return grouped.map((group, gi) => (React.createElement(React.Fragment, { key: `grp-${gi}` },
                            gi > 0 && (React.createElement("span", { "aria-hidden": true, className: "mx-0.5 h-4 w-px self-center bg-border" })),
                            group.map(({ name, isGpu, gpuType }) => (React.createElement(Badge, { key: name, variant: variantFor({ name, isGpu, gpuType }), className: "gap-1 font-mono text-2xs transition-colors duration-150 ease-out motion-reduce:transition-none", "aria-label": `${name}${isGpu
                                    ? `, GPU${gpuType ? ` ${gpuType}` : ""}`
                                    : ""}`, title: isGpu && gpuType
                                    ? `${name} · ${gpuType}`
                                    : name },
                                isGpu && React.createElement(Cpu, { className: "h-3 w-3", "aria-hidden": true }),
                                React.createElement("span", null, name.replace("Standard_", "")),
                                isGpu && gpuType && (React.createElement("span", { className: "rounded bg-background/40 px-1 text-[10px] font-bold tracking-wider" }, gpuType))))))));
                    })()))),
            React.createElement(TabsContent, { value: "scale", className: "flex flex-col gap-3" }, smartMode ? (React.createElement(React.Fragment, null,
                React.createElement(Alert, { variant: "info" },
                    React.createElement(AlertDescription, { className: "leading-relaxed" },
                        React.createElement("strong", { className: "text-foreground" }, "Smart Mode:"),
                        " ",
                        "Automatically fills all free LP quota across selected accounts. Creates pools starting with ND40rs_v2, then H100_v5, NC24s_v3, NC12s_v3, NC6s_v3.")),
                React.createElement("div", { className: "flex max-w-[20rem] flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: poolIdFieldId }, "Pool ID"),
                    React.createElement(Input, { id: poolIdFieldId, ref: poolIdFieldRef, value: poolIdInput, onChange: (e) => handlePoolIdChange(e.target.value), "aria-describedby": poolIdError ? POOL_ID_ERROR_ID : `${poolIdFieldId}-desc`, "aria-invalid": poolIdError ? true : undefined, className: cn(poolIdError &&
                            "border-destructive focus-visible:ring-destructive") }),
                    poolIdError ? (React.createElement("span", { id: POOL_ID_ERROR_ID, className: "text-xs text-destructive", role: "alert" }, poolIdError)) : (React.createElement("span", { id: `${poolIdFieldId}-desc`, className: "text-xs text-muted-foreground" }, "1-64 chars, alphanumeric, underscore, hyphen."))),
                React.createElement("div", { className: "flex max-w-[20rem] flex-col gap-1.5" },
                    React.createElement(Label, { htmlFor: resizeTimeoutFieldId, className: "inline-flex items-center gap-1.5" },
                        "Resize timeout (minutes)",
                        React.createElement(InfoTooltip, { side: "top", content: "How long Batch waits for the requested nodes to allocate before giving up and marking the resize failed. Bump up for hot SKUs (H100, ND40rs_v2) where the regional pool can take several minutes to drain. Min 5, max 120." })),
                    React.createElement(Input, { id: resizeTimeoutFieldId, type: "number", min: 5, max: 120, value: String(resizeTimeoutMin), onChange: (e) => {
                            const n = parseInt(e.target.value, 10);
                            setResizeTimeoutMin(isNaN(n) ? 15 : Math.max(5, Math.min(120, n)));
                        }, className: "tabular-nums", "aria-describedby": `${resizeTimeoutFieldId}-desc` }),
                    React.createElement("span", { id: `${resizeTimeoutFieldId}-desc`, className: "text-2xs text-muted-foreground tabular-nums" },
                        "Sent as ",
                        React.createElement("code", { className: "font-mono" },
                            "PT",
                            resizeTimeoutMin,
                            "M"),
                        " on the pool spec."),
                    resizeTimeoutMin < 5 && (React.createElement("span", { className: "text-xs text-destructive", role: "alert" }, "Resize timeout must be at least 5 minutes."))))) : (React.createElement(React.Fragment, null,
                React.createElement(Alert, { variant: "warning" },
                    React.createElement(AlertDescription, null, "Manual JSON mode. Note: targetDedicatedNodes will be forced to 0 on submission. Only low-priority/spot nodes are used.")),
                React.createElement("div", { ref: jsonEditorContainerRef, tabIndex: -1, "aria-describedby": configError ? POOL_JSON_ERROR_ID : undefined, "aria-invalid": configError ? true : undefined, className: "flex flex-col gap-1.5 outline-none" },
                    React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                        React.createElement(Label, { htmlFor: jsonEditorFieldId, className: "inline-flex items-center gap-1.5" },
                            "Pool Configuration (JSON)",
                            React.createElement(InfoTooltip, { side: "top", content: "A full Azure Batch pool definition. See learn.microsoft.com/rest/api/batchservice/pool/add for the schema. `targetDedicatedNodes` is force-zeroed on submit because this page only fans out LP/spot pools." }),
                            React.createElement("span", { className: "ml-1 text-2xs text-muted-foreground tabular-nums" },
                                poolConfigJson.length,
                                " chars")),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "JSON editor actions" },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleJsonFormat, "aria-label": "Format / pretty-print JSON", title: "Pretty-print (2-space indent)", className: "gap-1" },
                                React.createElement(FileCode, { className: "h-3.5 w-3.5" }),
                                "Format"),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleJsonCopy, "aria-label": "Copy JSON config to clipboard", title: "Copy to clipboard", className: "gap-1" },
                                React.createElement(Copy, { className: "h-3.5 w-3.5" }),
                                "Copy"),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleJsonDownload, "aria-label": "Download JSON config as a file", title: "Download as .json", className: "gap-1" },
                                React.createElement(Download, { className: "h-3.5 w-3.5" }),
                                "Download"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: handleJsonReset, "aria-label": "Reset JSON to the built-in default", title: "Reset to default template", className: "gap-1 text-muted-foreground" },
                                React.createElement(RotateCw, { className: "h-3.5 w-3.5" }),
                                "Reset"))),
                    React.createElement("div", { id: jsonEditorFieldId, className: "overflow-hidden rounded-md border border-border" },
                        React.createElement(MonacoEditor, { language: "json", value: poolConfigJson, onChange: (value) => handleEditorChange(value !== null && value !== void 0 ? value : ""), containerStyle: { height: "300px" }, editorOptions: {
                                minimap: { enabled: false },
                                scrollBeyondLastLine: false,
                                lineNumbers: "on",
                                fontSize: 13,
                            } })),
                    configError && (React.createElement("span", { id: POOL_JSON_ERROR_ID, className: "text-xs text-destructive", role: "alert" }, configError)))))),
            React.createElement(TabsContent, { value: "networking", className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex max-w-[44rem] flex-col gap-1.5" },
                    React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                        React.createElement(Label, { htmlFor: subnetFieldId, className: "inline-flex items-center gap-1.5" },
                            "Subnet ID (optional)",
                            React.createElement(InfoTooltip, { side: "top", content: "Full ARM resource ID of an existing subnet. The subnet must live in the same region as each target Batch account, have enough IPs for the planned nodes, and grant Batch the 'Microsoft.Network/virtualNetworks/subnets/join/action' role. Leave blank for default (public) networking." })),
                        React.createElement("div", { className: "flex items-center gap-1", role: "group", "aria-label": "Subnet field actions" },
                            subnetId && (React.createElement(React.Fragment, null,
                                React.createElement(CopyButton, { value: subnetId, ariaLabel: "Copy subnet ID", alwaysVisible: true, iconSize: 14, className: "h-7 w-7" }),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => {
                                        setSubnetId("");
                                        setSubnetError(null);
                                    }, "aria-label": "Clear subnet ID", className: "gap-1" },
                                    React.createElement(Eraser, { className: "h-3.5 w-3.5" }),
                                    "Clear"))),
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => __awaiter(void 0, void 0, void 0, function* () {
                                    var _y;
                                    try {
                                        if (typeof navigator !== "undefined" &&
                                            ((_y = navigator.clipboard) === null || _y === void 0 ? void 0 : _y.readText)) {
                                            const text = yield navigator.clipboard.readText();
                                            const trimmed = text.trim();
                                            if (trimmed) {
                                                handleSubnetChange(trimmed);
                                            }
                                        }
                                    }
                                    catch (_z) {
                                        // Clipboard permission denied — leave the field as-is.
                                    }
                                }), "aria-label": "Paste subnet ID from clipboard", title: "Paste from clipboard (the clipboard text is trimmed and validated)", className: "gap-1" },
                                React.createElement(Upload, { className: "h-3.5 w-3.5" }),
                                "Paste"))),
                    React.createElement(Input, { id: subnetFieldId, ref: subnetFieldRef, value: subnetId, onChange: (e) => handleSubnetChange(e.target.value), placeholder: "/subscriptions/.../subnets/<name>", className: cn("font-mono text-[13px]", subnetError &&
                            "border-destructive focus-visible:ring-destructive"), "aria-describedby": subnetError ? `${subnetFieldId}-error` : `${subnetFieldId}-desc`, "aria-invalid": subnetError ? true : undefined }),
                    subnetError ? (React.createElement("span", { id: `${subnetFieldId}-error`, className: "text-xs text-destructive", role: "alert" }, subnetError)) : (React.createElement("span", { id: `${subnetFieldId}-desc`, className: "text-xs text-muted-foreground" },
                        "Leave blank to skip vnet integration. Expected:",
                        " ",
                        React.createElement("code", { className: "rounded bg-surface-sunken px-1 font-mono text-2xs" }, "/subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<name>")))),
                React.createElement("div", { className: "flex items-center gap-2" },
                    React.createElement(Switch, { id: interNodeCommId, checked: interNodeComm, onCheckedChange: (checked) => setInterNodeComm(checked), "aria-label": "Enable inter-node communication" }),
                    React.createElement(Label, { htmlFor: interNodeCommId, className: "inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-foreground" },
                        "Inter-node communication",
                        " ",
                        React.createElement("span", { className: "text-xs text-muted-foreground" }, interNodeComm ? "On" : "Off"),
                        React.createElement(InfoTooltip, { side: "top", content: "Allocates nodes that can reach each other on a private VNet \u2014 required for MPI / multi-node training jobs. Reduces the pool's max size (Batch limits inter-node pools more aggressively) and may exclude some VM SKUs." })))),
            React.createElement(TabsContent, { value: "tasks", className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex max-w-[44rem] flex-col gap-1.5" },
                    React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                        React.createElement(Label, { htmlFor: startTaskFieldId, className: "inline-flex items-center gap-1.5" },
                            "Start Task command line",
                            React.createElement(InfoTooltip, { side: "top", content: "Shell command executed on every node when the pool starts. Runs as the autoUser identity (admin scope) before the node accepts any user tasks. Failures here either retry (waitForSuccess=false) or mark the node unusable (waitForSuccess=true)." })),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Start task actions" },
                            React.createElement(DropdownMenu, null,
                                React.createElement(DropdownMenuTrigger, { asChild: true },
                                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", "aria-label": "Load a start-task preset", className: "gap-1.5" },
                                        React.createElement(Sparkles, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                                        "Presets")),
                                React.createElement(DropdownMenuContent, { align: "end", className: "max-h-72 w-80 overflow-y-auto" },
                                    React.createElement(DropdownMenuLabel, null, "Start-task presets"),
                                    React.createElement(DropdownMenuSeparator, null),
                                    START_TASK_PRESETS.map((preset) => (React.createElement("button", { key: preset.id, type: "button", onClick: () => applyStartTaskPreset(preset), className: "flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:outline-none" },
                                        React.createElement("span", { className: "text-xs font-semibold text-foreground" }, preset.label),
                                        React.createElement("span", { className: "text-2xs leading-relaxed text-muted-foreground" }, preset.description),
                                        React.createElement("code", { className: "mt-0.5 block w-full truncate rounded bg-surface-sunken px-1 py-0.5 font-mono text-3xs text-muted-foreground" }, preset.commandLine)))))),
                            React.createElement(CopyButton, { value: startTaskCmd, ariaLabel: "Copy start-task command", alwaysVisible: true, iconSize: 14, className: "h-7 w-7" }),
                            startTaskCmd.trim().length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setStartTaskCmd(""), "aria-label": "Clear start-task command", className: "gap-1" },
                                React.createElement(Eraser, { className: "h-3.5 w-3.5" }),
                                "Clear")))),
                    React.createElement("textarea", { id: startTaskFieldId, ref: startTaskFieldRef, rows: 6, value: startTaskCmd, onChange: (e) => setStartTaskCmd(e.target.value), placeholder: '/bin/bash -c "apt-get update && echo setup done"', "aria-describedby": tasksStepValid
                            ? `${startTaskFieldId}-desc`
                            : `${startTaskFieldId}-error`, "aria-invalid": tasksStepValid ? undefined : true, className: cn("flex min-h-[120px] w-full rounded-md border border-input bg-surface-sunken px-3 py-2 font-mono text-[13px] text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50", !tasksStepValid &&
                            "border-destructive focus-visible:ring-destructive") }),
                    tasksStepValid ? (React.createElement("span", { id: `${startTaskFieldId}-desc`, className: "text-xs text-muted-foreground" },
                        "Runs once on each node when the pool starts.",
                        " ",
                        React.createElement("span", { className: "tabular-nums" }, startTaskCmd.length),
                        " ",
                        "character",
                        startTaskCmd.length === 1 ? "" : "s",
                        ".")) : (React.createElement("span", { id: `${startTaskFieldId}-error`, className: "text-xs text-destructive", role: "alert" }, "Start task command is required."))),
                React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
                        React.createElement(Label, { className: "inline-flex items-center gap-1.5" },
                            "Start Task environment variables",
                            React.createElement(InfoTooltip, { side: "top", content: "Key/value pairs exported into the start-task shell. Available to the command via $NAME (Linux) or %NAME% (Windows). Sensitive values are stored in plain text in the pool definition \u2014 use a Key Vault reference or fetch at runtime for secrets." }),
                            envVars.filter((ev) => ev.name.trim() !== "").length > 0 && (React.createElement("span", { className: "ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-2xs font-semibold tabular-nums text-muted-foreground" }, envVars.filter((ev) => ev.name.trim() !== "").length)),
                            envDuplicateNames.size > 0 && (React.createElement("span", { className: "ml-1 inline-flex h-5 items-center rounded-full bg-warning/15 px-1.5 text-2xs font-semibold text-warning", title: `Duplicate names: ${Array.from(envDuplicateNames).join(", ")}` },
                                envDuplicateNames.size,
                                " dup")),
                            envInvalidIndices.size > 0 && (React.createElement("span", { className: "ml-1 inline-flex h-5 items-center rounded-full bg-destructive/15 px-1.5 text-2xs font-semibold text-destructive", title: "One or more env-var names are not valid POSIX identifiers. Fix them before continuing." },
                                envInvalidIndices.size,
                                " invalid"))),
                        React.createElement("div", { className: "flex flex-wrap items-center gap-1", role: "group", "aria-label": "Env vars bulk actions" },
                            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => {
                                    setEnvPasteOpen((x) => !x);
                                    setEnvPasteWarnings([]);
                                }, "aria-expanded": envPasteOpen, "aria-controls": envPasteFieldId, className: "gap-1" },
                                React.createElement(Upload, { className: "h-3.5 w-3.5" }),
                                "Paste .env"),
                            envDuplicateNames.size > 0 && (React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: dedupeEnvVars, "aria-label": "Remove duplicate env vars (keep last value)", className: "gap-1 text-warning hover:text-warning" }, "Dedupe")),
                            envVars.length > 0 && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: clearAllEnvVars, "aria-label": "Remove every environment variable", className: "gap-1 text-destructive hover:text-destructive" },
                                React.createElement(Eraser, { className: "h-3.5 w-3.5" }),
                                "Clear all")))),
                    envPasteOpen && (React.createElement("div", { className: "flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken/40 p-2.5" },
                        React.createElement(Label, { htmlFor: envPasteFieldId, className: "text-xs font-medium text-foreground" }, "Paste KEY=VALUE lines"),
                        React.createElement("textarea", { id: envPasteFieldId, rows: 4, value: envPasteText, onChange: (e) => setEnvPasteText(e.target.value), placeholder: "# Comment lines starting with # are ignored\n" +
                                'OMP_NUM_THREADS=8\n' +
                                'CUDA_VISIBLE_DEVICES="0,1"\n' +
                                "export TRANSFORMERS_CACHE=/mnt/batch/tasks/.cache", className: "w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-2xs", "aria-describedby": `${envPasteFieldId}-desc` }),
                        React.createElement("span", { id: `${envPasteFieldId}-desc`, className: "text-2xs text-muted-foreground" }, "One `NAME=VALUE` per line. `export ` prefixes and `#` comments are tolerated. Existing names get overwritten by the paste."),
                        envPasteWarnings.length > 0 && (React.createElement("ul", { className: "m-0 list-disc space-y-0.5 pl-4 text-2xs text-warning" }, envPasteWarnings.map((w, i) => (React.createElement("li", { key: i }, w))))),
                        React.createElement("div", { className: "flex items-center gap-1.5" },
                            React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: handleEnvPasteApply, disabled: envPasteText.trim().length === 0, "aria-label": "Apply pasted environment variables" }, "Apply paste"),
                            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => {
                                    setEnvPasteOpen(false);
                                    setEnvPasteText("");
                                    setEnvPasteWarnings([]);
                                } }, "Cancel")))),
                    envVars.map((ev, idx) => {
                        const isDup = ev.name.trim() !== "" && envDuplicateNames.has(ev.name);
                        const isInvalid = envInvalidIndices.has(idx);
                        const nameErrorId = `env-name-error-${idx}`;
                        return (React.createElement("div", { key: idx, className: "flex flex-col gap-1" },
                            React.createElement("div", { className: "flex flex-wrap items-end gap-2" },
                                React.createElement(Input, { placeholder: "Name", value: ev.name, onChange: (e) => updateEnvVar(idx, "name", e.target.value), "aria-label": `Environment variable ${idx + 1} name`, className: cn("w-[200px] font-mono text-[13px]", isDup && "border-warning focus-visible:ring-warning", isInvalid &&
                                        "border-destructive focus-visible:ring-destructive"), "aria-invalid": isDup || isInvalid || undefined, "aria-describedby": isInvalid ? nameErrorId : undefined, title: isInvalid
                                        ? "Invalid POSIX env name."
                                        : isDup
                                            ? "Duplicate name — only last wins on submit."
                                            : undefined }),
                                React.createElement(Input, { placeholder: "Value", value: ev.value, onChange: (e) => updateEnvVar(idx, "value", e.target.value), "aria-label": `Environment variable ${idx + 1} value`, className: "w-[400px] font-mono text-[13px]" }),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "icon", title: "Remove", "aria-label": `Remove environment variable ${idx + 1}`, onClick: () => removeEnvVar(idx), className: "text-destructive hover:bg-destructive/10 hover:text-destructive" },
                                    React.createElement(Trash2, null))),
                            isInvalid && (React.createElement("span", { id: nameErrorId, role: "alert", className: "text-2xs text-destructive" }, "Invalid POSIX env name. Must start with a letter or underscore, then contain only letters, digits, and underscores."))));
                    }),
                    React.createElement("div", null,
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: addEnvVar, className: "mt-1" },
                            React.createElement(Plus, null),
                            "Add environment variable"))),
                React.createElement("div", { className: "flex flex-wrap items-end gap-6" },
                    React.createElement("div", { className: "flex w-[180px] flex-col gap-1.5" },
                        React.createElement(Label, { htmlFor: retryFieldId, className: "inline-flex items-center gap-1.5" },
                            "Max task retry count",
                            React.createElement(InfoTooltip, { side: "top", content: "If the start task exits non-zero, Batch retries it this many times before marking the node unusable. Set to 0 for one-shot startup; bump up for flaky network-bound installs." })),
                        React.createElement("div", { className: "flex items-center gap-1" },
                            React.createElement(Button, { type: "button", variant: "outline", size: "icon-sm", onClick: handleRetryDecrement, disabled: maxRetryCount <= 0, "aria-label": "Decrement retry count" }, "-"),
                            React.createElement(Input, { id: retryFieldId, type: "number", min: 0, max: 100, step: 1, value: String(maxRetryCount), onChange: (e) => handleRetryChange(e.target.value), className: "text-center tabular-nums" }),
                            React.createElement(Button, { type: "button", variant: "outline", size: "icon-sm", onClick: handleRetryIncrement, disabled: maxRetryCount >= 100, "aria-label": "Increment retry count" }, "+"))),
                    React.createElement("div", { className: "flex items-center gap-2" },
                        React.createElement(Switch, { id: waitForSuccessId, checked: waitForSuccess, onCheckedChange: (checked) => setWaitForSuccess(checked), "aria-label": "Wait for start task success" }),
                        React.createElement(Label, { htmlFor: waitForSuccessId, className: "inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-foreground" },
                            "Wait for success",
                            " ",
                            React.createElement("span", { className: "text-xs text-muted-foreground" }, waitForSuccess ? "Yes" : "No"),
                            React.createElement(InfoTooltip, { side: "top", content: "When ON, a node is held in the 'starting' state until its start task succeeds, so user tasks never run on a half-set-up node. When OFF, tasks may run before the start task finishes \u2014 useful when the start task is an opportunistic warm-up rather than a hard requirement." }))))),
            React.createElement(TabsContent, { value: "review", className: "flex flex-col gap-3" },
                !allStepsValid && (React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement(ErrorState, { tone: "warning", size: "compact", icon: AlertCircle, message: "Some earlier steps still need attention.", detail: firstInvalidStep
                            ? `First unresolved: ${(_l = (_k = STEPS.find((s) => s.key === firstInvalidStep)) === null || _k === void 0 ? void 0 : _k.label) !== null && _l !== void 0 ? _l : firstInvalidStep} step.`
                            : "Use the stepper above to revisit highlighted steps." }),
                    firstInvalidStep && (React.createElement("div", null,
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => goToStep(firstInvalidStep), "aria-label": `Jump to ${firstInvalidStep} step`, className: "gap-1.5" },
                            "Jump to",
                            " ", (_m = STEPS.find((s) => s.key === firstInvalidStep)) === null || _m === void 0 ? void 0 :
                            _m.label))))),
                React.createElement("div", { className: "rounded-md border border-border bg-card p-4" },
                    React.createElement("h2", { className: "m-0 mb-3 text-base font-semibold text-foreground" }, "Review configuration"),
                    React.createElement("dl", { className: "grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2" },
                        React.createElement("div", { className: "flex flex-col gap-0.5" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Accounts selected"),
                            React.createElement("dd", { className: "m-0 font-medium tabular-nums" },
                                selectedAccountIds.size,
                                crossSubDispatch && (React.createElement("span", { className: "ml-2 inline-flex items-center rounded-full bg-info/10 px-1.5 py-0.5 text-2xs font-semibold text-info" },
                                    selectedAccountsBySub.length,
                                    "-sub fan-out"))),
                            crossSubDispatch && (React.createElement("dd", { className: "m-0 text-2xs text-muted-foreground" }, selectedAccountsBySub
                                .map((r) => `${r.displayName}: ${r.count}`)
                                .join(" · ")))),
                        React.createElement("div", { className: "flex flex-col gap-0.5" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Mode"),
                            React.createElement("dd", { className: "m-0 font-medium" }, smartMode ? "Smart fill" : "Manual JSON")),
                        React.createElement("div", { className: "flex flex-col gap-0.5" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "OS"),
                            React.createElement("dd", { className: "m-0 font-medium capitalize" }, osCategory)),
                        React.createElement("div", { className: "flex flex-col gap-0.5" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Pool ID"),
                            React.createElement("dd", { className: "m-0 font-mono text-xs" }, poolIdInput)),
                        React.createElement("div", { className: "flex flex-col gap-0.5" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Resize timeout"),
                            React.createElement("dd", { className: "m-0 font-medium tabular-nums" },
                                "PT",
                                resizeTimeoutMin,
                                "M")),
                        React.createElement("div", { className: "flex flex-col gap-0.5" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Inter-node comm"),
                            React.createElement("dd", { className: "m-0 font-medium" }, interNodeComm ? "On" : "Off")),
                        React.createElement("div", { className: "flex flex-col gap-0.5 sm:col-span-2" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Subnet"),
                            React.createElement("dd", { className: "m-0 font-mono text-xs" }, subnetId || "(none)")),
                        React.createElement("div", { className: "flex flex-col gap-0.5 sm:col-span-2" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Start task"),
                            React.createElement("dd", { className: "m-0 break-words font-mono text-xs" }, startTaskCmd)),
                        React.createElement("div", { className: "flex flex-col gap-0.5" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Total pools planned"),
                            React.createElement("dd", { className: "m-0 font-medium text-info tabular-nums" }, totalPoolsPlanned)),
                        React.createElement("div", { className: "flex flex-col gap-0.5" },
                            React.createElement("dt", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Env vars"),
                            React.createElement("dd", { className: "m-0 font-medium tabular-nums" }, envVars.filter((ev) => ev.name.trim() !== "").length)))),
                attackSurfaceFindings.length > 0 && (React.createElement("div", { className: cn("flex flex-col gap-2 rounded-md border p-3", worstSeverity === "destructive"
                        ? "border-destructive/40 bg-destructive/5"
                        : worstSeverity === "warning"
                            ? "border-warning/40 bg-warning/5"
                            : "border-border bg-card"), role: "region", "aria-label": "Attack-surface preview" },
                    React.createElement("div", { className: "flex items-center gap-2" },
                        React.createElement(ShieldAlert, { className: cn("h-4 w-4 shrink-0", worstSeverity === "destructive"
                                ? "text-destructive"
                                : worstSeverity === "warning"
                                    ? "text-warning"
                                    : "text-info"), "aria-hidden": true }),
                        React.createElement("h3", { className: "m-0 text-sm font-semibold text-foreground" }, "Attack-surface preview"),
                        React.createElement(Badge, { variant: worstSeverity === "destructive"
                                ? "destructive"
                                : worstSeverity === "warning"
                                    ? "info"
                                    : "secondary", className: "font-mono tabular-nums" },
                            attackSurfaceFindings.length,
                            " finding",
                            attackSurfaceFindings.length === 1 ? "" : "s"),
                        React.createElement("span", { className: "ml-auto text-2xs text-muted-foreground" }, "What an attacker would see if these credentials leaked.")),
                    React.createElement("ul", { className: "m-0 flex list-none flex-col gap-2 p-0" }, attackSurfaceFindings.map((finding) => (React.createElement("li", { key: finding.id, className: cn("rounded-md border px-3 py-2 text-xs leading-relaxed", finding.severity === "destructive"
                            ? "border-destructive/40 bg-destructive/10"
                            : finding.severity === "warning"
                                ? "border-warning/40 bg-warning/10"
                                : "border-border bg-surface-sunken/60") },
                        React.createElement("div", { className: "flex flex-wrap items-baseline gap-2" },
                            React.createElement("span", { className: cn("text-2xs font-semibold uppercase tracking-wider", finding.severity === "destructive"
                                    ? "text-destructive"
                                    : finding.severity === "warning"
                                        ? "text-warning"
                                        : "text-info") }, finding.severity === "destructive"
                                ? "high"
                                : finding.severity),
                            React.createElement("strong", { className: "text-foreground" }, finding.title)),
                        React.createElement("p", { className: "m-0 mt-1 text-xs text-muted-foreground" }, finding.detail),
                        React.createElement("p", { className: "m-0 mt-1 text-3xs font-mono text-muted-foreground/70" },
                            "ref: ",
                            finding.cite))))))),
                React.createElement("div", { className: "flex flex-col gap-2 rounded-md border border-border bg-card p-3" },
                    React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                        React.createElement(FileJson, { className: "h-4 w-4 shrink-0 text-muted-foreground", "aria-hidden": true }),
                        React.createElement("h3", { className: "m-0 text-sm font-semibold text-foreground" }, "Pool PUT body preview"),
                        putBodyPreview.redactedNames.length > 0 && (React.createElement(Badge, { variant: "info", className: "font-mono tabular-nums", title: `Redacted env-var names: ${putBodyPreview.redactedNames.join(", ")}` },
                            putBodyPreview.redactedNames.length,
                            " redacted")),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setPreviewOpen((v) => !v), "aria-expanded": previewOpen, "aria-controls": "pool-put-body-preview", className: "ml-auto h-7 gap-1 text-2xs text-muted-foreground" },
                            previewOpen ? "Hide" : "Show",
                            " preview"),
                        previewOpen && (React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => __awaiter(void 0, void 0, void 0, function* () {
                                var _0;
                                try {
                                    if (typeof navigator !== "undefined" &&
                                        ((_0 = navigator.clipboard) === null || _0 === void 0 ? void 0 : _0.writeText)) {
                                        yield navigator.clipboard.writeText(previewJsonString);
                                        store.addNotification({
                                            type: "info",
                                            message: "Preview JSON copied (secrets redacted).",
                                            autoDismissMs: 2500,
                                        });
                                    }
                                }
                                catch (_1) {
                                    // ignore — clipboard permission denied
                                }
                            }), "aria-label": "Copy preview JSON", className: "h-7 gap-1 text-2xs text-muted-foreground" },
                            React.createElement(Copy, { className: "h-3 w-3" }),
                            " Copy"))),
                    previewOpen ? (React.createElement("pre", { id: "pool-put-body-preview", className: "m-0 max-h-[280px] overflow-auto rounded border border-border/60 bg-surface-sunken px-3 py-2 font-mono text-2xs leading-relaxed text-foreground", "aria-label": "Sanitized pool PUT body" }, previewJsonString)) : (React.createElement("span", { className: "text-2xs text-muted-foreground" },
                        "Click ",
                        React.createElement("em", null, "Show preview"),
                        " to inspect the exact body that will be PUT to each Batch account (vmSize is a placeholder in smart mode, secret-shaped env vars are redacted)."))),
                React.createElement("div", { className: "flex items-center gap-2" },
                    React.createElement(Checkbox, { id: saveAsDefaultId, checked: saveAsDefault, onCheckedChange: (checked) => setSaveAsDefault(checked === true), "aria-label": "Save these settings as defaults for future creates" }),
                    React.createElement(Label, { htmlFor: saveAsDefaultId, className: "cursor-pointer text-sm font-normal text-foreground" }, "Save as default for future creates")),
                configError && (React.createElement(Alert, { variant: "destructive", role: "alert" },
                    React.createElement(AlertDescription, null, configError))))),
        React.createElement("div", { className: "flex flex-wrap items-center gap-2 pt-1" },
            React.createElement(Button, { type: "button", variant: "outline", onClick: handleBack, disabled: currentIndex === 0 || isRunning, title: currentIndex === 0
                    ? "Already on the first step"
                    : isRunning
                        ? "Pool creation in progress"
                        : undefined }, "Back"),
            currentStep !== "review" ? (React.createElement(Button, { type: "button", variant: "default", onClick: handleContinue, disabled: !stepValidity[currentStep] || isRunning, className: "min-w-[10rem] transition-colors duration-200 ease-out motion-reduce:transition-none", title: isRunning
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
                        : undefined }, "Continue")) : (React.createElement(Button, { type: "button", variant: "default", onClick: handleSubmit, disabled: !allStepsValid || isRunning, className: "min-w-[12rem] max-w-[20rem] transition-colors duration-200 ease-out motion-reduce:transition-none", title: isRunning
                    ? "Pool creation in progress"
                    : !allStepsValid
                        ? "One or more earlier steps still need attention."
                        : undefined }, isRunning ? (React.createElement(React.Fragment, null,
                React.createElement(Loader2, { className: "h-3.5 w-3.5 animate-spin" }),
                smartMode
                    ? "Creating pools (waiting for resize)..."
                    : "Creating Pools...")) : smartMode ? ("Create Pools (Smart Fill)") : (`Create Pools on ${selectedAccountIds.size} Accounts`))),
            isRunning && (React.createElement(Button, { type: "button", variant: "outline", onClick: () => {
                    var _a;
                    // Abort the per-submit controller first so the catch-branch
                    // can distinguish operator-cancel from a real error, then
                    // call the orchestrator-wide cancel to mop up any per-agent
                    // work that didn't receive our signal.
                    (_a = submitAbortRef.current) === null || _a === void 0 ? void 0 : _a.abort();
                    orchestrator.cancel();
                }, "aria-label": "Stop pool creation", className: "border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive" },
                React.createElement(Square, { className: "h-3.5 w-3.5" }),
                "Stop")),
            React.createElement("span", { className: "ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground", title: "Keyboard: Ctrl/Cmd + Enter advances the wizard, or opens the confirm dialog on the Review step." },
                React.createElement(Keyboard, { className: "h-3 w-3", "aria-hidden": true }),
                React.createElement("kbd", { className: "rounded border border-border bg-muted px-1 py-px font-mono text-3xs" }, "Ctrl+Enter"),
                React.createElement("span", null, currentStep === "review" ? "to create" : "to continue"))),
        isRunning && (React.createElement("div", { className: "mt-2 flex flex-col gap-1.5", role: "group", "aria-labelledby": "pool-creation-progress-label" },
            React.createElement("span", { id: "pool-creation-progress-label", className: "text-xs font-medium text-foreground" }, "Creating pools..."),
            React.createElement(Progress, { indeterminate: true, "aria-label": "Creating pools" }))),
        isRunning && (React.createElement(PoolCreationLogPanel, { logs: state.agentLogs })),
        state.pools.length > 0 && (React.createElement(PoolResultsSection, { pools: state.pools, accounts: state.accounts })),
        React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only" }, creationAnnouncement),
        React.createElement(ConfirmationDialog, { hidden: confirmHidden, title: "Confirm Pool Creation", message: confirmMessage, confirmText: `Create ${totalPoolsPlanned} pool(s)`, cancelText: "Cancel", onConfirm: handleCreate, onCancel: () => setConfirmHidden(true), loading: isRunning })));
};
const POOL_LOG_TAIL_LIMIT = 250;
const PoolCreationLogPanel = ({ logs, }) => {
    const [autoScroll, setAutoScroll] = React.useState(true);
    const [levelFilter, setLevelFilter] = React.useState("all");
    const scrollRef = React.useRef(null);
    const autoScrollId = React.useId();
    const poolLogs = React.useMemo(() => logs.filter((l) => l.agent === "pool"), [logs]);
    const filtered = React.useMemo(() => {
        if (levelFilter === "all")
            return poolLogs;
        return poolLogs.filter((l) => l.level === levelFilter);
    }, [poolLogs, levelFilter]);
    const tail = React.useMemo(() => filtered.slice(-POOL_LOG_TAIL_LIMIT), [filtered]);
    // Auto-scroll to the bottom on every new log line — unless the operator
    // turned auto-scroll OFF (they're presumably reading an earlier line).
    React.useEffect(() => {
        if (!autoScroll)
            return;
        const el = scrollRef.current;
        if (!el)
            return;
        el.scrollTop = el.scrollHeight;
    }, [tail.length, autoScroll]);
    const errorCount = React.useMemo(() => poolLogs.filter((l) => l.level === "error").length, [poolLogs]);
    const warnCount = React.useMemo(() => poolLogs.filter((l) => l.level === "warn").length, [poolLogs]);
    const copyBuffer = React.useCallback(() => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        const text = tail
            .map((l) => `[${l.level.toUpperCase()}] ${l.message}`)
            .join("\n");
        try {
            if (typeof navigator !== "undefined" &&
                ((_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText)) {
                yield navigator.clipboard.writeText(text);
            }
        }
        catch (_b) {
            // ignore — clipboard permission denied, no fallback for log dump
        }
    }), [tail]);
    return (React.createElement("div", { className: "mt-2 flex flex-col gap-2 rounded-md border border-border bg-surface-sunken px-3 py-3", "aria-label": "Smart pool creation progress" },
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Smart Creation Progress"),
            React.createElement(Badge, { variant: "secondary", className: "font-mono tabular-nums" }, poolLogs.length),
            errorCount > 0 && (React.createElement(Badge, { variant: "destructive", className: "font-mono tabular-nums", title: `${errorCount} error log line${errorCount === 1 ? "" : "s"}` },
                errorCount,
                " err")),
            warnCount > 0 && (React.createElement(Badge, { variant: "info", className: "font-mono tabular-nums", title: `${warnCount} warning log line${warnCount === 1 ? "" : "s"}` },
                warnCount,
                " warn")),
            React.createElement("div", { className: "ml-auto flex flex-wrap items-center gap-1" },
                React.createElement(Select, { value: levelFilter, onValueChange: (v) => setLevelFilter(v) },
                    React.createElement(SelectTrigger, { className: "h-7 w-[110px] text-2xs", "aria-label": "Filter log lines by level" },
                        React.createElement(SelectValue, null)),
                    React.createElement(SelectContent, null,
                        React.createElement(SelectItem, { value: "all" }, "All levels"),
                        React.createElement(SelectItem, { value: "error" }, "Errors"),
                        React.createElement(SelectItem, { value: "warn" }, "Warnings"),
                        React.createElement(SelectItem, { value: "info" }, "Info"))),
                React.createElement("label", { htmlFor: autoScrollId, className: "flex cursor-pointer items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-2xs", title: "Auto-scroll to follow the newest log lines" },
                    React.createElement(Switch, { id: autoScrollId, checked: autoScroll, onCheckedChange: setAutoScroll, "aria-label": "Toggle log auto-scroll" }),
                    "Auto-scroll"),
                React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: copyBuffer, disabled: tail.length === 0, "aria-label": "Copy log buffer to clipboard", className: "h-7 gap-1" },
                    React.createElement(Copy, { className: "h-3 w-3" }),
                    "Copy"))),
        React.createElement("div", { ref: scrollRef, role: "status", "aria-live": autoScroll ? "polite" : "off", "aria-atomic": "false", className: "max-h-[300px] overflow-y-auto rounded border border-border/60 bg-background px-2 py-2 font-mono text-xs" }, tail.length === 0 ? (React.createElement("span", { className: "block py-2 text-center text-2xs italic text-muted-foreground" }, levelFilter === "all"
            ? "Waiting for log lines..."
            : `No ${levelFilter} entries.`)) : (tail.map((log, i) => {
            var _a;
            return (React.createElement("div", { key: `${(_a = log.timestamp) !== null && _a !== void 0 ? _a : i}-${i}`, className: cn("mb-0.5 leading-relaxed", log.level === "error"
                    ? "text-destructive"
                    : log.level === "warn"
                        ? "text-warning"
                        : "text-success") }, log.message));
        })))));
};
const PoolResultsSection = ({ pools, accounts, }) => {
    const [showErrorsOnly, setShowErrorsOnly] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const errorsOnlyId = React.useId();
    const accountIndex = React.useMemo(() => {
        const map = new Map();
        for (const a of accounts)
            map.set(a.id, a);
        return map;
    }, [accounts]);
    const rawRows = React.useMemo(() => pools.map((p) => {
        var _a, _b, _c;
        const acc = accountIndex.get(p.accountId);
        return {
            id: p.id,
            accountName: (_a = acc === null || acc === void 0 ? void 0 : acc.accountName) !== null && _a !== void 0 ? _a : "-",
            region: (_b = acc === null || acc === void 0 ? void 0 : acc.region) !== null && _b !== void 0 ? _b : "-",
            poolId: p.poolId,
            status: p.provisioningState,
            error: (_c = p.error) !== null && _c !== void 0 ? _c : "",
        };
    }), [pools, accountIndex]);
    const rows = React.useMemo(() => {
        const needle = search.trim().toLowerCase();
        return rawRows.filter((r) => {
            if (showErrorsOnly && r.error.length === 0)
                return false;
            if (needle.length === 0)
                return true;
            return (r.accountName.toLowerCase().includes(needle) ||
                r.region.toLowerCase().includes(needle) ||
                r.poolId.toLowerCase().includes(needle) ||
                r.error.toLowerCase().includes(needle) ||
                r.status.toLowerCase().includes(needle));
        });
    }, [rawRows, showErrorsOnly, search]);
    const stats = React.useMemo(() => {
        let succeeded = 0;
        let failed = 0;
        let creating = 0;
        for (const p of pools) {
            if (p.provisioningState === "created")
                succeeded += 1;
            else if (p.provisioningState === "failed")
                failed += 1;
            else
                creating += 1;
        }
        return { succeeded, failed, creating };
    }, [pools]);
    const columns = React.useMemo(() => [
        {
            id: "accountName",
            header: "Account",
            cell: (r) => React.createElement("span", { className: "font-medium" }, r.accountName),
            sort: (a, b) => a.accountName.localeCompare(b.accountName),
            csv: (r) => r.accountName,
        },
        {
            id: "region",
            header: "Region",
            cell: (r) => (React.createElement("span", { className: "font-mono text-2xs" }, r.region)),
            sort: (a, b) => a.region.localeCompare(b.region),
            csv: (r) => r.region,
        },
        {
            id: "poolId",
            header: "Pool ID",
            cell: (r) => (React.createElement(CopyableText, { value: r.poolId, mono: true })),
            sort: (a, b) => a.poolId.localeCompare(b.poolId),
            csv: (r) => r.poolId,
        },
        {
            id: "status",
            header: "Status",
            cell: (r) => React.createElement(StatusBadge, { status: r.status }),
            sort: (a, b) => a.status.localeCompare(b.status),
            csv: (r) => r.status,
        },
        {
            id: "error",
            header: "Error",
            cell: (r) => r.error ? (React.createElement("span", { className: "group/copy inline-flex items-center gap-1 align-middle" },
                React.createElement("span", { className: "text-xs text-destructive line-clamp-2 max-w-[24rem]" }, r.error),
                React.createElement(CopyButton, { value: r.error, ariaLabel: "Copy error message" }))) : (React.createElement("span", { className: "text-2xs text-muted-foreground" }, "\u2014")),
            sort: (a, b) => a.error.localeCompare(b.error),
            csv: (r) => r.error,
        },
    ], []);
    return (React.createElement("div", { className: "flex flex-col gap-2" },
        React.createElement("div", { className: "flex flex-wrap items-center justify-between gap-2" },
            React.createElement("h2", { className: "m-0 text-base font-semibold text-foreground" }, "Pool Results"),
            React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
                React.createElement(Badge, { variant: "secondary", className: "font-mono tabular-nums" },
                    stats.succeeded,
                    " ok"),
                stats.failed > 0 && (React.createElement(Badge, { variant: "destructive", className: "font-mono tabular-nums" },
                    stats.failed,
                    " failed")),
                stats.creating > 0 && (React.createElement(Badge, { variant: "info", className: "font-mono tabular-nums" },
                    stats.creating,
                    " in flight")))),
        React.createElement("div", { className: "flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2", role: "toolbar", "aria-label": "Pool results filters" },
            React.createElement("div", { className: "relative w-full max-w-[20rem]" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { type: "search", value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search pool results...", "aria-label": "Filter pool results", className: "pl-7" })),
            React.createElement("label", { htmlFor: errorsOnlyId, className: "flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-sunken/40 px-2 py-1 text-xs" },
                React.createElement(Switch, { id: errorsOnlyId, checked: showErrorsOnly, onCheckedChange: setShowErrorsOnly, "aria-label": "Show only failed pools" }),
                React.createElement("span", null, "Errors only"),
                stats.failed > 0 && (React.createElement(Badge, { variant: "destructive", className: "ml-1 font-mono tabular-nums" }, stats.failed)))),
        React.createElement(DataTable, { tableId: "pool-creation-results", rows: rows, columns: columns, rowKey: (r) => r.id, csvFileName: "pool-creation-results.csv", jsonFileName: "pool-creation-results.json", initialSort: { column: "accountName", direction: "asc" }, empty: React.createElement(EmptyState, { icon: Server, title: showErrorsOnly ? "No failed pools" : "No matching pools", description: showErrorsOnly
                    ? "Every pool reported succeeded so far."
                    : "Loosen the search filter to see more results.", size: "compact" }) })));
};
export const PoolCreationPage = (props) => (React.createElement(ErrorBoundary, null,
    React.createElement(PoolCreationPageInner, Object.assign({}, props))));
//# sourceMappingURL=pool-creation-page.js.map