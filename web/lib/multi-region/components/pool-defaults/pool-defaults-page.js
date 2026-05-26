import { __awaiter } from "tslib";
/**
 * Pool Default Settings page — manages OS, start-task, and network defaults
 * applied to all pool-creation flows.
 *
 * Features:
 *  - Diff-tracks against the last saved snapshot, surfaces per-section
 *    "modified" pills, supports global Revert and per-section Discard.
 *  - Named-preset library (save current state under a label, load any of them).
 *  - JSON import/export of the full defaults shape.
 *  - Copy-to-clipboard for the rendered preview and individual resource ids.
 *  - Info tooltips next to every non-obvious field.
 *  - Inline validation surfacing duplicates, missing values, weak passwords,
 *    malformed subnet ARM ids, and non-HTTPS resource URLs.
 *  - Keyboard shortcuts: Ctrl/Cmd+S save, Ctrl/Cmd+Shift+Z revert, Ctrl/Cmd+E
 *    export, Alt+E expand-all, Alt+C collapse-all.
 *  - Quick OS-preset chips for the most common Linux/Windows images.
 */
import * as React from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleDot, Columns, Download, Eye, FileJson, FileUp, Keyboard, Plus, RotateCcw, Save, Search, ShieldAlert, Sparkles, Trash2, Undo2, XCircle, } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Kbd, KbdChord } from "@/components/ui/kbd";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useMultiRegionState, useMultiRegionStore, } from "../../store/store-context";
import { INITIAL_POOL_DEFAULTS, buildPoolConfigFromDefaults, } from "../../store/pool-defaults";
import { auditLog } from "../../services/audit-log";
import { useBeforeUnload } from "../../hooks/use-before-unload";
import { usePersistedState } from "../../hooks/use-persisted-state";
import { useDashboardOutletContext } from "../page-router";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { CopyButton } from "../shared/copy-button";
import { ErrorBoundary } from "../shared/error-boundary";
import { InfoTooltip } from "../shared/info-tooltip";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { PageHeader } from "../shared/page-header";
import { SignInRequired } from "../shared/sign-in-required";
/* ------------------------------------------------------------------ */
/*  Dirty-state helper                                                 */
/* ------------------------------------------------------------------ */
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (typeof a !== typeof b)
        return false;
    if (a && b && typeof a === "object") {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        if (ka.length !== kb.length)
            return false;
        for (const k of ka) {
            if (!deepEqual(a[k], b[k])) {
                return false;
            }
        }
        return true;
    }
    return false;
}
const NO_DIFF = {
    os: false,
    optional: false,
    startTask: false,
    network: false,
};
const SECTION_NUMBERS = {
    os: 1,
    optional: 2,
    startTask: 3,
    network: 4,
};
const SECTION_LABELS = {
    os: "OS",
    optional: "Optional",
    startTask: "Start Task",
    network: "Network",
};
function computeSectionDiff(current, snapshot) {
    if (!snapshot)
        return NO_DIFF;
    return {
        os: current.osCategory !== snapshot.osCategory ||
            !deepEqual(current.virtualMachineConfiguration, snapshot.virtualMachineConfiguration),
        optional: current.taskSlotsPerNode !== snapshot.taskSlotsPerNode ||
            current.enableInterNodeCommunication !==
                snapshot.enableInterNodeCommunication ||
            current.taskSchedulingPolicy !== snapshot.taskSchedulingPolicy ||
            !deepEqual(current.metadata, snapshot.metadata) ||
            !deepEqual(current.userAccounts, snapshot.userAccounts),
        startTask: !deepEqual(current.startTask, snapshot.startTask),
        network: current.subnetId !== snapshot.subnetId,
    };
}
const ModifiedPill = () => (React.createElement("span", { role: "status", "aria-label": "Section modified since last save", className: "ml-2 inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning" }, "modified"));
const OS_PRESET_CHIPS = [
    {
        id: "ubuntu-22",
        label: "Ubuntu 22.04 LTS",
        description: "Canonical Jammy, Gen2",
        osCategory: "linux",
        config: {
            nodeAgentSKUId: "batch.node.ubuntu 22.04",
            imageReference: {
                publisher: "canonical",
                offer: "0001-com-ubuntu-server-jammy",
                sku: "22_04-lts-gen2",
                version: "latest",
            },
        },
    },
    {
        id: "ubuntu-20",
        label: "Ubuntu 20.04 LTS",
        description: "Canonical Focal, Gen2",
        osCategory: "linux",
        config: {
            nodeAgentSKUId: "batch.node.ubuntu 20.04",
            imageReference: {
                publisher: "canonical",
                offer: "0001-com-ubuntu-server-focal",
                sku: "20_04-lts-gen2",
                version: "latest",
            },
        },
    },
    {
        id: "centos-7-hpc",
        label: "CentOS 7 HPC",
        description: "Compute-optimized, RDMA drivers preinstalled",
        osCategory: "linux",
        config: {
            nodeAgentSKUId: "batch.node.centos 7",
            imageReference: {
                publisher: "openlogic",
                offer: "centos-hpc",
                sku: "7_9-gen2",
                version: "latest",
            },
        },
    },
    {
        id: "windows-2022",
        label: "Windows Server 2022",
        description: "Datacenter, smalldisk",
        osCategory: "windows",
        config: {
            nodeAgentSKUId: "batch.node.windows amd64",
            imageReference: {
                publisher: "microsoftwindowsserver",
                offer: "windowsserver",
                sku: "2022-datacenter",
                version: "latest",
            },
        },
    },
    {
        id: "windows-2019",
        label: "Windows Server 2019",
        description: "Datacenter",
        osCategory: "windows",
        config: {
            nodeAgentSKUId: "batch.node.windows amd64",
            imageReference: {
                publisher: "microsoftwindowsserver",
                offer: "windowsserver",
                sku: "2019-datacenter",
                version: "latest",
            },
        },
    },
];
const OS_PRESETS = {
    linux: {
        publisher: "canonical",
        offer: "0001-com-ubuntu-server-jammy",
        sku: "22_04-lts-gen2",
        version: "latest",
        nodeAgentSKUId: "batch.node.ubuntu 22.04",
    },
    windows: {
        publisher: "microsoftwindowsserver",
        offer: "windowsserver",
        sku: "2022-datacenter",
        version: "latest",
        nodeAgentSKUId: "batch.node.windows amd64",
    },
};
const BUILTIN_PRESETS = [
    {
        id: "gpu-training",
        label: "GPU training (NVIDIA, single slot)",
        description: "1 task per node, inter-node comm on for distributed training, root admin user, longer start-task retry.",
        patch: () => ({
            taskSlotsPerNode: 1,
            enableInterNodeCommunication: true,
            taskSchedulingPolicy: "Pack",
            startTask: Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS.startTask), { commandLine: '/bin/bash -c "nvidia-smi && echo GPU pool ready"', maxTaskRetryCount: 5, waitForSuccess: true, userIdentity: {
                    autoUser: { scope: "pool", elevationLevel: "admin" },
                } }),
        }),
    },
    {
        id: "cpu-batch",
        label: "CPU batch (high throughput)",
        description: "Many task slots per node, Spread scheduling for balanced load, lightweight start-task.",
        patch: () => ({
            taskSlotsPerNode: 16,
            enableInterNodeCommunication: false,
            taskSchedulingPolicy: "Spread",
            startTask: Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS.startTask), { commandLine: '/bin/bash -c "echo CPU node online"', maxTaskRetryCount: 3, waitForSuccess: true, userIdentity: {
                    autoUser: { scope: "task", elevationLevel: "nonadmin" },
                } }),
        }),
    },
    {
        id: "windows-dev",
        label: "Windows interactive dev",
        description: "Windows 2022 image, admin pool user, no inter-node communication.",
        patch: () => ({
            osCategory: "windows",
            virtualMachineConfiguration: OS_PRESET_CHIPS.find((p) => p.id === "windows-2022").config,
            enableInterNodeCommunication: false,
            taskSchedulingPolicy: "Pack",
            startTask: Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS.startTask), { commandLine: 'cmd /c "echo Windows node online"', maxTaskRetryCount: 2, waitForSuccess: true, userIdentity: {
                    autoUser: { scope: "pool", elevationLevel: "admin" },
                } }),
        }),
    },
];
const SCHEDULING_POLICY_OPTIONS = [
    { value: "Pack", label: "Pack — fill one node before scheduling the next" },
    {
        value: "Spread",
        label: "Spread — distribute tasks across all nodes",
    },
];
const OS_CATEGORY_OPTIONS = [
    { value: "linux", label: "Linux" },
    { value: "windows", label: "Windows" },
];
const USER_SCOPE_OPTIONS = [
    { value: "pool", label: "Pool user — survives across tasks" },
    { value: "task", label: "Task user — recreated per task" },
];
const ELEVATION_OPTIONS = [
    { value: "admin", label: "Admin" },
    { value: "nonadmin", label: "Non-admin" },
];
/** Subnet ARM ids look like
 * /subscriptions/{guid}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{vnet}/subnets/{subnet}
 */
const SUBNET_ARM_REGEX = /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/;
function findDuplicates(items, key) {
    const seen = new Map();
    const dupes = new Set();
    items.forEach((item) => {
        var _a;
        const k = key(item).trim();
        if (!k)
            return;
        const n = ((_a = seen.get(k)) !== null && _a !== void 0 ? _a : 0) + 1;
        seen.set(k, n);
        if (n > 1)
            dupes.add(k);
    });
    return Array.from(dupes);
}
function passwordStrengthOk(pw) {
    if (pw.length < 8)
        return false;
    let classes = 0;
    if (/[a-z]/.test(pw))
        classes++;
    if (/[A-Z]/.test(pw))
        classes++;
    if (/[0-9]/.test(pw))
        classes++;
    if (/[^a-zA-Z0-9]/.test(pw))
        classes++;
    return classes >= 3;
}
function validateDefaults(d) {
    const issues = [];
    // ---- OS section ----
    const vm = d.virtualMachineConfiguration;
    if (!vm.imageReference.publisher.trim())
        issues.push({
            severity: "error",
            section: "os",
            field: "publisher",
            message: "Publisher is required",
        });
    if (!vm.imageReference.offer.trim())
        issues.push({
            severity: "error",
            section: "os",
            field: "offer",
            message: "Offer is required",
        });
    if (!vm.imageReference.sku.trim())
        issues.push({
            severity: "error",
            section: "os",
            field: "sku",
            message: "SKU is required",
        });
    if (!vm.imageReference.version.trim())
        issues.push({
            severity: "error",
            section: "os",
            field: "version",
            message: "Version is required (use 'latest' for the latest published)",
        });
    if (!vm.nodeAgentSKUId.trim())
        issues.push({
            severity: "error",
            section: "os",
            field: "nodeAgentSKUId",
            message: "Node Agent SKU ID is required",
        });
    // Loose sanity check: Windows + ubuntu nodeAgentSKUId is almost certainly wrong.
    if (d.osCategory === "windows" &&
        vm.nodeAgentSKUId.toLowerCase().includes("ubuntu")) {
        issues.push({
            severity: "warning",
            section: "os",
            field: "nodeAgentSKUId",
            message: "OS category is Windows but Node Agent SKU looks like a Linux SKU — pick a quick preset to fix",
        });
    }
    if (d.osCategory === "linux" &&
        vm.nodeAgentSKUId.toLowerCase().includes("windows")) {
        issues.push({
            severity: "warning",
            section: "os",
            field: "nodeAgentSKUId",
            message: "OS category is Linux but Node Agent SKU looks like a Windows SKU — pick a quick preset to fix",
        });
    }
    // ---- Optional ----
    const metaDupes = findDuplicates(d.metadata, (m) => m.name);
    metaDupes.forEach((name) => issues.push({
        severity: "error",
        section: "optional",
        field: "metadata",
        message: `Duplicate metadata name "${name}"`,
    }));
    d.metadata.forEach((m, i) => {
        if (!m.name.trim() && m.value.trim())
            issues.push({
                severity: "error",
                section: "optional",
                field: `metadata.${i}.name`,
                message: `Metadata row ${i + 1} has a value but no name`,
            });
    });
    const userDupes = findDuplicates(d.userAccounts, (u) => u.name);
    userDupes.forEach((name) => issues.push({
        severity: "error",
        section: "optional",
        field: "userAccounts",
        message: `Duplicate user account name "${name}"`,
    }));
    d.userAccounts.forEach((u, i) => {
        if (!u.name.trim())
            issues.push({
                severity: "error",
                section: "optional",
                field: `userAccount.${i}.name`,
                message: `User account ${i + 1}: name is required`,
            });
        if (!u.password)
            issues.push({
                severity: "error",
                section: "optional",
                field: `userAccount.${i}.password`,
                message: `User account "${u.name || `#${i + 1}`}": password is required`,
            });
        else if (!passwordStrengthOk(u.password))
            issues.push({
                severity: "warning",
                section: "optional",
                field: `userAccount.${i}.password`,
                message: `User account "${u.name || `#${i + 1}`}": password is weak (min 8 chars, 3 of: lower, upper, digit, symbol)`,
            });
    });
    // ---- Start Task ----
    const st = d.startTask;
    const envDupes = findDuplicates(st.environmentSettings, (e) => e.name);
    envDupes.forEach((name) => issues.push({
        severity: "error",
        section: "startTask",
        field: "env",
        message: `Duplicate environment variable "${name}"`,
    }));
    st.environmentSettings.forEach((e, i) => {
        if (!e.name.trim() && e.value.trim())
            issues.push({
                severity: "error",
                section: "startTask",
                field: `env.${i}.name`,
                message: `Env var row ${i + 1} has a value but no name`,
            });
        if (e.name.trim() && /\s/.test(e.name))
            issues.push({
                severity: "warning",
                section: "startTask",
                field: `env.${i}.name`,
                message: `Env var "${e.name}" contains whitespace`,
            });
    });
    if (!st.commandLine.trim() && st.waitForSuccess)
        issues.push({
            severity: "warning",
            section: "startTask",
            field: "commandLine",
            message: "Wait-for-success is ON but command line is empty — start task will be skipped",
        });
    st.resourceFiles.forEach((rf, i) => {
        var _a, _b;
        const url = ((_a = rf.httpUrl) !== null && _a !== void 0 ? _a : "").trim();
        if (url && !/^https?:\/\//i.test(url))
            issues.push({
                severity: "error",
                section: "startTask",
                field: `rf.${i}.url`,
                message: `Resource file ${i + 1}: URL must start with http:// or https://`,
            });
        if (url && url.startsWith("http://"))
            issues.push({
                severity: "warning",
                section: "startTask",
                field: `rf.${i}.url`,
                message: `Resource file ${i + 1}: prefer HTTPS over plain HTTP`,
            });
        if (url && !((_b = rf.filePath) === null || _b === void 0 ? void 0 : _b.trim()))
            issues.push({
                severity: "warning",
                section: "startTask",
                field: `rf.${i}.path`,
                message: `Resource file ${i + 1}: missing destination file path`,
            });
    });
    if (st.maxTaskRetryCount > 10)
        issues.push({
            severity: "warning",
            section: "startTask",
            field: "maxTaskRetryCount",
            message: `Max retry count of ${st.maxTaskRetryCount} is unusually high — pool nodes will retry many times before going to UNUSABLE`,
        });
    // ---- Network ----
    if (d.subnetId && !SUBNET_ARM_REGEX.test(d.subnetId))
        issues.push({
            severity: "error",
            section: "network",
            field: "subnetId",
            message: "Subnet ID is not a valid ARM resource ID — expected /subscriptions/{guid}/resourceGroups/.../subnets/{name}",
        });
    return issues;
}
function groupIssues(issues) {
    const out = {
        os: [],
        optional: [],
        startTask: [],
        network: [],
    };
    issues.forEach((i) => out[i.section].push(i));
    return out;
}
const PRESETS_STORAGE_KEY = "pool-defaults:named-presets";
/**
 * Stable actor string used by every audit entry recorded from this page.
 * Matches the `ui:<page-key>` convention used elsewhere in the dashboard.
 */
const AUDIT_ACTOR = "ui:pool-defaults";
/**
 * Compute a compact { added, removed, changed } sketch of which top-level
 * fields differ between two PoolDefaults snapshots. Used as the `details`
 * payload on save/import/preset-load audit entries so the audit-log page
 * can render a meaningful diff without storing the whole object twice.
 */
function summarizeDefaultsDiff(before, after) {
    if (!before) {
        return { firstSnapshot: true, keys: Object.keys(after).length };
    }
    const changed = [];
    Object.keys(after).forEach((k) => {
        if (!deepEqual(before[k], after[k])) {
            changed.push(String(k));
        }
    });
    return { changed, changedCount: changed.length };
}
/* ------------------------------------------------------------------ */
/*  Privilege-propagation detection                                    */
/* ------------------------------------------------------------------ */
/**
 * The Batch StartTask runs once per node on every pool that consumes these
 * defaults. When the auto-user identity is `scope=pool, elevationLevel=admin`,
 * the command runs as root (Linux) / LocalSystem (Windows) and any state it
 * writes — installed binaries, dropped credentials, registered cron jobs —
 * persists for the life of the pool. Multiplying that by "every future pool
 * created from this UI" makes the default a force multiplier for privilege
 * propagation.
 *
 * Corpus: per NetSPI's MicroBurst research, the resource-plane primitive
 * defenders most often miss is a *baked-in* elevated identity (Automation
 * Account RunAs, App Service Easy-Auth key, Logic-App API connection). The
 * Batch StartTask is the same shape — a centrally-edited "thing every node
 * will run as admin", which is exactly the surface MicroBurst's
 * `Get-AzPasswords` is built to harvest. The right mitigation here is to
 * make the operator *see* the privilege boundary they are committing to
 * before they save.
 *
 * See: C:\Users\baimgprodsesa1\Desktop\New folder\_analysis_netspi.md §II
 *      (Automation Account RunAs persistence pattern).
 */
function detectPrivilegedDefault(d) {
    const st = d.startTask;
    const elevated = st.userIdentity.autoUser.elevationLevel === "admin";
    const poolScope = st.userIdentity.autoUser.scope === "pool";
    const hasCommand = st.commandLine.trim().length > 0;
    const hasResourceFiles = st.resourceFiles.some((rf) => { var _a; return ((_a = rf.httpUrl) !== null && _a !== void 0 ? _a : "").trim().length > 0; });
    const hasInsecureHttpFile = st.resourceFiles.some((rf) => { var _a; return ((_a = rf.httpUrl) !== null && _a !== void 0 ? _a : "").toLowerCase().startsWith("http://"); });
    // Heuristic: env-var names that *look* like a credential being baked into
    // every node's StartTask shell. The value itself isn't logged anywhere by
    // this UI, but operators who paste tokens into env vars and forget about
    // them are the recurring incident in the corpus.
    const SECRET_NAME_RE = /(secret|token|key|password|passwd|pwd|sas|connstr|connectionstring|credential|api[_-]?key|access[_-]?key)/i;
    const hasUnscopedSecretEnv = st.environmentSettings.some((e) => e.name.trim().length > 0 &&
        e.value.trim().length > 0 &&
        SECRET_NAME_RE.test(e.name));
    return {
        elevated,
        poolScope,
        hasCommand,
        hasResourceFiles,
        hasInsecureHttpFile,
        hasUnscopedSecretEnv,
    };
}
/* ------------------------------------------------------------------ */
/*  Section-level field diff (used for richer audit payloads)          */
/* ------------------------------------------------------------------ */
/**
 * For a single section, list the top-level fields that differ between two
 * snapshots. Used by the per-section discard handler so the audit record
 * captures which keys were actually rolled back, not just the section name.
 */
function listSectionChangedFields(key, before, after) {
    const changed = [];
    const pushIfDiff = (label, a, b) => {
        if (!deepEqual(a, b))
            changed.push(label);
    };
    if (key === "os") {
        pushIfDiff("osCategory", before.osCategory, after.osCategory);
        pushIfDiff("virtualMachineConfiguration", before.virtualMachineConfiguration, after.virtualMachineConfiguration);
    }
    else if (key === "optional") {
        pushIfDiff("taskSlotsPerNode", before.taskSlotsPerNode, after.taskSlotsPerNode);
        pushIfDiff("enableInterNodeCommunication", before.enableInterNodeCommunication, after.enableInterNodeCommunication);
        pushIfDiff("taskSchedulingPolicy", before.taskSchedulingPolicy, after.taskSchedulingPolicy);
        pushIfDiff("metadata", before.metadata, after.metadata);
        pushIfDiff("userAccounts", before.userAccounts, after.userAccounts);
    }
    else if (key === "startTask") {
        pushIfDiff("startTask", before.startTask, after.startTask);
    }
    else if (key === "network") {
        pushIfDiff("subnetId", before.subnetId, after.subnetId);
    }
    return changed;
}
/* ------------------------------------------------------------------ */
/*  Field wrapper — label + control                                    */
/* ------------------------------------------------------------------ */
const Field = ({ label, htmlFor, className, hint, children, error, warning, trailing }) => (React.createElement("div", { className: cn("flex flex-col gap-1.5", className) },
    React.createElement(Label, { htmlFor: htmlFor, className: "flex items-center gap-1 text-xs font-medium text-muted-foreground" },
        React.createElement("span", null, label),
        hint && React.createElement(InfoTooltip, { content: hint }),
        trailing),
    children,
    error && (React.createElement("span", { role: "alert", className: "flex items-start gap-1 text-2xs font-medium text-destructive" },
        React.createElement(XCircle, { className: "mt-0.5 h-3 w-3 shrink-0", "aria-hidden": true }),
        React.createElement("span", null, error))),
    !error && warning && (React.createElement("span", { role: "alert", className: "flex items-start gap-1 text-2xs font-medium text-warning" },
        React.createElement(AlertTriangle, { className: "mt-0.5 h-3 w-3 shrink-0", "aria-hidden": true }),
        React.createElement("span", null, warning)))));
const NumberInput = ({ id, value, min, max, step = 1, onChange, "aria-label": ariaLabel, className, }) => {
    const clamp = (n) => Math.max(min, Math.min(max, n));
    return (React.createElement(Input, { id: id, type: "number", value: Number.isFinite(value) ? String(value) : "", min: min, max: max, step: step, onChange: (e) => {
            const raw = e.target.value;
            if (raw === "") {
                onChange(min);
                return;
            }
            const n = parseInt(raw, 10);
            if (Number.isNaN(n))
                return;
            onChange(clamp(n));
        }, onBlur: (e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isNaN(n)) {
                onChange(min);
            }
            else {
                onChange(clamp(n));
            }
        }, "aria-label": ariaLabel, className: cn("max-w-[14rem]", className) }));
};
/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */
const SectionCard = ({ number, title, subtitle, modified, expanded, onToggle, toolbar, issuesCount, children, }) => {
    const headingId = React.useId();
    const bodyId = React.useId();
    return (React.createElement("section", { className: "overflow-hidden rounded-lg border border-border bg-card shadow-sm", "aria-labelledby": headingId },
        React.createElement("div", { className: "flex items-center gap-1 bg-surface-raised pr-3" },
            React.createElement("button", { type: "button", onClick: onToggle, "aria-expanded": expanded, "aria-controls": bodyId, "aria-label": `${expanded ? "Collapse" : "Expand"} section ${number}: ${title}`, className: "flex flex-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background" },
                React.createElement("span", { className: "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground" }, number),
                React.createElement("div", { className: "flex-1" },
                    React.createElement("span", { id: headingId, className: "block text-base font-semibold text-foreground" },
                        title,
                        modified && React.createElement(ModifiedPill, null),
                        issuesCount && issuesCount.errors > 0 && (React.createElement("span", { role: "status", "aria-label": `${issuesCount.errors} validation errors`, className: "ml-2 inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-2xs font-medium text-destructive" },
                            React.createElement(XCircle, { className: "h-3 w-3", "aria-hidden": true }),
                            issuesCount.errors,
                            " error",
                            issuesCount.errors === 1 ? "" : "s")),
                        issuesCount &&
                            issuesCount.errors === 0 &&
                            issuesCount.warnings > 0 && (React.createElement("span", { role: "status", "aria-label": `${issuesCount.warnings} warnings`, className: "ml-2 inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning" },
                            React.createElement(AlertTriangle, { className: "h-3 w-3", "aria-hidden": true }),
                            issuesCount.warnings,
                            " warning",
                            issuesCount.warnings === 1 ? "" : "s"))),
                    subtitle && (React.createElement("span", { className: "mt-0.5 block text-xs text-muted-foreground" }, subtitle))),
                expanded ? (React.createElement(ChevronDown, { className: "h-4 w-4 text-muted-foreground transition-transform", "aria-hidden": true })) : (React.createElement(ChevronRight, { className: "h-4 w-4 text-muted-foreground transition-transform", "aria-hidden": true }))),
            toolbar && (React.createElement("div", { className: "flex items-center gap-1", 
                // Stop click events on the toolbar from also triggering
                // the parent toggle button — without this, hitting "Copy"
                // also collapses/expands the section.
                onClick: (e) => e.stopPropagation() }, toolbar))),
        expanded && (React.createElement("div", { id: bodyId, role: "region", "aria-labelledby": headingId, className: "bg-surface-base px-5 py-4" }, children))));
};
/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
const PoolDefaultsPageInner = () => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    // Path-based nav from the dashboard outlet — keeps deep-link parity with
    // every other page in the multi-region tree.
    const { navigateToPage } = useDashboardOutletContext();
    const defaults = state.poolDefaults;
    // No-account empty state — if the user has no AAD account context the page
    // has nothing to apply defaults against. Direct them to /azure-accounts.
    const hasAzureAccount = state.azureAccounts.length > 0;
    // Initial-load skeleton: poolDefaults is hydrated synchronously on store
    // construction, but defend against the brief gap before that runs.
    if (!defaults) {
        return (React.createElement("div", { className: "flex flex-col gap-4 py-4" },
            React.createElement(PageHeader, { title: "Pool Default Settings" }),
            React.createElement(SkeletonLoader, { variant: "form", rows: 8 })));
    }
    if (!hasAzureAccount) {
        return (React.createElement("div", { className: "flex flex-col gap-4 py-4", role: "region", "aria-label": "Pool default settings page" },
            React.createElement(PageHeader, { title: "Pool Default Settings", description: "OS, start task, and network defaults used by all pool creation modes." }),
            React.createElement(SignInRequired, { whatYouCantDo: "Manage pool defaults", why: "an Azure account so defaults can be persisted alongside your subscriptions", onNavigate: (k) => navigateToPage(`/${k}`) })));
    }
    return React.createElement(PoolDefaultsForm, { defaults: defaults, store: store });
};
const PoolDefaultsForm = ({ defaults, store, }) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    // Track which sections are expanded
    const [expandedSections, setExpandedSections] = React.useState(new Set([1, 2, 3, 4, 5]));
    // "Saved!" toast
    const [savedMsg, setSavedMsg] = React.useState(null);
    // Section filter — narrows the visible sections by free-text search across
    // titles/subtitles. Empty string shows everything.
    const [filter, setFilter] = React.useState("");
    // Persisted snapshot of the last saved defaults. Survives refresh so the
    // diff/revert workflow keeps working across sessions.
    const [savedSnapshot, setSavedSnapshot] = usePersistedState("pool-defaults:last-saved", null);
    // Persisted library of named presets the user has saved manually.
    const [namedPresets, setNamedPresets] = usePersistedState(PRESETS_STORAGE_KEY, []);
    // First-mount hydration: if no snapshot has ever been saved, treat the
    // hydrated store value as the implicit baseline so the page doesn't open
    // showing every section as "modified".
    React.useEffect(() => {
        if (savedSnapshot === null) {
            setSavedSnapshot(defaults);
        }
        // Intentionally run only on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const sectionDiff = React.useMemo(() => computeSectionDiff(defaults, savedSnapshot), [defaults, savedSnapshot]);
    const isDirty = React.useMemo(() => sectionDiff.os ||
        sectionDiff.optional ||
        sectionDiff.startTask ||
        sectionDiff.network, [sectionDiff]);
    // Guard the browser tab from accidental Cmd+R / X-tab close while the
    // operator has unsaved pool-default edits. Browsers ignore the message
    // string but still show their generic "Leave site?" prompt, which is
    // enough to recover the half-finished form.
    useBeforeUnload(isDirty, "Pool defaults have unsaved changes. Leave anyway?");
    const changedSectionLabels = React.useMemo(() => {
        const labels = [];
        if (sectionDiff.os)
            labels.push("OS");
        if (sectionDiff.optional)
            labels.push("Optional");
        if (sectionDiff.startTask)
            labels.push("Start Task");
        if (sectionDiff.network)
            labels.push("Network");
        return labels;
    }, [sectionDiff]);
    // Validation
    const issues = React.useMemo(() => validateDefaults(defaults), [defaults]);
    const issuesBySection = React.useMemo(() => groupIssues(issues), [issues]);
    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;
    const hasErrors = errorCount > 0;
    // Confirmation dialogs
    const [confirmSaveOpen, setConfirmSaveOpen] = React.useState(false);
    const [confirmRevertOpen, setConfirmRevertOpen] = React.useState(false);
    const [confirmResetOpen, setConfirmResetOpen] = React.useState(false);
    const [confirmDiscardSection, setConfirmDiscardSection] = React.useState(null);
    const [confirmDeletePreset, setConfirmDeletePreset] = React.useState(null);
    // Presets modal
    const [presetsDialogOpen, setPresetsDialogOpen] = React.useState(false);
    const [savePresetDialogOpen, setSavePresetDialogOpen] = React.useState(false);
    const [presetNameInput, setPresetNameInput] = React.useState("");
    const [keyboardHelpOpen, setKeyboardHelpOpen] = React.useState(false);
    // Side-by-side compare picker — names of the two presets being diffed.
    // Either side may also be set to the special sentinel "__current__" to
    // diff a saved preset against the in-form values, and "__saved__" to diff
    // against the last-saved snapshot. Comparing two profiles side by side
    // mirrors the "what's the smallest privilege boundary I can ship" review
    // step every defensive-tooling playbook recommends.
    const [compareDialogOpen, setCompareDialogOpen] = React.useState(false);
    const [compareLeft, setCompareLeft] = React.useState("__current__");
    const [compareRight, setCompareRight] = React.useState("__saved__");
    // "Try before save" preview — renders a read-only pool-creation form
    // populated from the current defaults so the operator sees exactly what
    // a downstream pool-creation page will look like before they commit.
    const [tryPreviewOpen, setTryPreviewOpen] = React.useState(false);
    // ARIA-live region dedicated to non-modal action confirmations. Distinct
    // from `savedMsg` (which is a *visible* toast) so a screen reader gets a
    // polite hint even when the toast has already faded.
    const [ariaAnnouncement, setAriaAnnouncement] = React.useState("");
    // Save banner ref — focus moved here on save success/fail for a11y
    const saveBannerRef = React.useRef(null);
    // Hidden file input for the JSON import flow
    const importInputRef = React.useRef(null);
    const [importError, setImportError] = React.useState(null);
    // Stable element ids
    const publisherId = React.useId();
    const offerId = React.useId();
    const skuId = React.useId();
    const versionId = React.useId();
    const nodeAgentId = React.useId();
    const taskSlotsId = React.useId();
    const internodeId = React.useId();
    const schedulingId = React.useId();
    const startCmdId = React.useId();
    const startMaxRetryId = React.useId();
    const startWaitId = React.useId();
    const startScopeId = React.useId();
    const startElevId = React.useId();
    const subnetId = React.useId();
    const filterInputId = React.useId();
    const presetNameInputId = React.useId();
    const toggleSection = (n) => {
        setExpandedSections((prev) => {
            const next = new Set(prev);
            if (next.has(n)) {
                next.delete(n);
            }
            else {
                next.add(n);
            }
            return next;
        });
    };
    const expandAll = React.useCallback(() => {
        setExpandedSections(new Set([1, 2, 3, 4, 5]));
    }, []);
    const collapseAll = React.useCallback(() => {
        setExpandedSections(new Set());
    }, []);
    const ensureSectionExpanded = React.useCallback((n) => {
        setExpandedSections((prev) => {
            if (prev.has(n))
                return prev;
            const next = new Set(prev);
            next.add(n);
            return next;
        });
    }, []);
    // Update helpers — the store is fully typed, no `unknown` casts needed.
    const update = React.useCallback((patch) => {
        store.updatePoolDefaults(patch);
    }, [store]);
    const setEverything = React.useCallback((next) => {
        store.setPoolDefaults(next);
    }, [store]);
    const updateStartTask = React.useCallback((patch) => {
        update({ startTask: Object.assign(Object.assign({}, defaults.startTask), patch) });
    }, [update, defaults.startTask]);
    // Collapse the four-deep spread that publisher/offer/sku/version each
    // need into one helper. Keeps the JSX terse and stops the temptation to
    // copy-paste the nested spread for every new image-reference field.
    //
    // COORDINATOR: every page that edits a VM imageReference repeats this
    // same nested-spread pattern. If a shared "image-reference editor"
    // component is ever added under components/shared/, this helper is the
    // call site to migrate.
    const updateImageRef = React.useCallback((patch) => {
        update({
            virtualMachineConfiguration: Object.assign(Object.assign({}, defaults.virtualMachineConfiguration), { imageReference: Object.assign(Object.assign({}, defaults.virtualMachineConfiguration.imageReference), patch) }),
        });
    }, [update, defaults.virtualMachineConfiguration]);
    // Same pattern for the startTask.userIdentity.autoUser triple-nested edit.
    // COORDINATOR: factor into shared user-identity editor if added later.
    const updateAutoUser = React.useCallback((patch) => {
        updateStartTask({
            userIdentity: {
                autoUser: Object.assign(Object.assign({}, defaults.startTask.userIdentity.autoUser), patch),
            },
        });
    }, [updateStartTask, defaults.startTask.userIdentity.autoUser]);
    // Toast helper — short-lived inline confirmation that doesn't require a save.
    // Also updates a dedicated polite ARIA-live region so screen-reader users
    // hear the confirmation even after the visible toast fades.
    const flashToast = React.useCallback((msg) => {
        setSavedMsg(msg);
        setAriaAnnouncement(msg);
        window.setTimeout(() => setSavedMsg(null), 2500);
    }, []);
    // Save handler — opens confirmation; the actual save runs after confirm.
    const handleSave = React.useCallback(() => {
        if (hasErrors) {
            flashToast(`Cannot save — fix ${errorCount} error${errorCount === 1 ? "" : "s"} first`);
            return;
        }
        setConfirmSaveOpen(true);
    }, [hasErrors, errorCount, flashToast]);
    const handleConfirmSave = React.useCallback(() => {
        setEverything(defaults);
        setSavedSnapshot(defaults);
        setConfirmSaveOpen(false);
        // These defaults flow into every future pool created via this UI —
        // record the snapshot diff PLUS the privilege footprint of the saved
        // start task so the audit log captures sufficient context to
        // reconstruct an incident around a privileged-StartTask change.
        // (Corpus rationale: see _analysis_netspi.md §II — "elevated identity
        // baked into every new resource" is the recurring resource-plane
        // attack primitive.)
        const priv = detectPrivilegedDefault(defaults);
        auditLog.record({
            actor: AUDIT_ACTOR,
            action: "save_pool_defaults",
            target: "pool-defaults",
            status: "success",
            details: Object.assign(Object.assign({}, summarizeDefaultsDiff(savedSnapshot, defaults)), { warningCount, startTaskElevation: defaults.startTask.userIdentity.autoUser.elevationLevel, startTaskScope: defaults.startTask.userIdentity.autoUser.scope, startTaskHasCommand: priv.hasCommand, startTaskHasResourceFiles: priv.hasResourceFiles, startTaskHasInsecureHttp: priv.hasInsecureHttpFile, startTaskHasSecretEnv: priv.hasUnscopedSecretEnv, userAccountCount: defaults.userAccounts.length, userAccountAdminCount: defaults.userAccounts.filter((u) => u.elevationLevel === "admin").length, hasVNet: !!defaults.subnetId }),
        });
        flashToast("Saved to localStorage");
        // Move focus to the success banner for screen-reader users.
        window.setTimeout(() => {
            var _a;
            (_a = saveBannerRef.current) === null || _a === void 0 ? void 0 : _a.focus();
        }, 0);
    }, [
        setEverything,
        defaults,
        setSavedSnapshot,
        savedSnapshot,
        flashToast,
        warningCount,
    ]);
    // Revert handler — restores the saved snapshot.
    const handleRevert = React.useCallback(() => {
        setConfirmRevertOpen(true);
    }, []);
    const handleConfirmRevert = React.useCallback(() => {
        if (savedSnapshot) {
            setEverything(savedSnapshot);
        }
        setConfirmRevertOpen(false);
        auditLog.record({
            actor: AUDIT_ACTOR,
            action: "revert_pool_defaults",
            target: "pool-defaults",
            status: "success",
            details: { hadSnapshot: savedSnapshot !== null },
        });
        flashToast("Reverted to last saved");
    }, [setEverything, savedSnapshot, flashToast]);
    // Per-section discard — restore just that section from the saved snapshot
    const handleConfirmDiscardSection = React.useCallback(() => {
        if (!savedSnapshot || !confirmDiscardSection) {
            setConfirmDiscardSection(null);
            return;
        }
        const key = confirmDiscardSection;
        let patch = {};
        if (key === "os") {
            patch = {
                osCategory: savedSnapshot.osCategory,
                virtualMachineConfiguration: savedSnapshot.virtualMachineConfiguration,
            };
        }
        else if (key === "optional") {
            patch = {
                taskSlotsPerNode: savedSnapshot.taskSlotsPerNode,
                enableInterNodeCommunication: savedSnapshot.enableInterNodeCommunication,
                taskSchedulingPolicy: savedSnapshot.taskSchedulingPolicy,
                metadata: savedSnapshot.metadata,
                userAccounts: savedSnapshot.userAccounts,
            };
        }
        else if (key === "startTask") {
            patch = { startTask: savedSnapshot.startTask };
        }
        else if (key === "network") {
            patch = { subnetId: savedSnapshot.subnetId };
        }
        update(patch);
        // Capture which top-level fields were actually rolled back so the
        // audit log can reconstruct the operator's intent, not just the
        // section header. Sufficient for incident-reconstruction even if the
        // user makes a second edit immediately afterwards.
        const rolledBack = listSectionChangedFields(key, defaults, savedSnapshot);
        auditLog.record({
            actor: AUDIT_ACTOR,
            action: "discard_section_changes",
            target: `pool-defaults:${key}`,
            status: "success",
            details: {
                section: key,
                rolledBackFields: rolledBack,
                rolledBackFieldCount: rolledBack.length,
            },
        });
        flashToast(`Discarded changes in ${SECTION_LABELS[key]}`);
        setConfirmDiscardSection(null);
    }, [savedSnapshot, confirmDiscardSection, update, flashToast, defaults]);
    // Reset handler — wraps in shared ConfirmationDialog (no native window.confirm).
    const handleReset = React.useCallback(() => {
        setConfirmResetOpen(true);
    }, []);
    const handleConfirmReset = React.useCallback(() => {
        store.resetPoolDefaults();
        setSavedSnapshot(INITIAL_POOL_DEFAULTS);
        setConfirmResetOpen(false);
        auditLog.record({
            actor: AUDIT_ACTOR,
            action: "reset_pool_defaults_to_factory",
            target: "pool-defaults",
            status: "success",
            details: summarizeDefaultsDiff(defaults, INITIAL_POOL_DEFAULTS),
        });
        flashToast("Reset to factory defaults");
    }, [store, setSavedSnapshot, defaults, flashToast]);
    // OS category change handler
    const handleOsCategoryChange = React.useCallback((cat) => {
        const preset = OS_PRESETS[cat];
        update({
            osCategory: cat,
            virtualMachineConfiguration: {
                nodeAgentSKUId: preset.nodeAgentSKUId,
                imageReference: {
                    publisher: preset.publisher,
                    offer: preset.offer,
                    sku: preset.sku,
                    version: preset.version,
                },
            },
        });
    }, [update]);
    const applyOsChip = React.useCallback((chip) => {
        update({
            osCategory: chip.osCategory,
            virtualMachineConfiguration: chip.config,
        });
        flashToast(`Applied OS preset: ${chip.label}`);
    }, [update, flashToast]);
    const applyBuiltinPreset = React.useCallback((preset) => {
        update(preset.patch(defaults));
        flashToast(`Applied preset: ${preset.label}`);
    }, [update, defaults, flashToast]);
    // Named-preset library actions
    const handleSavePreset = React.useCallback(() => {
        setPresetNameInput("");
        setSavePresetDialogOpen(true);
    }, []);
    const handleConfirmSavePreset = React.useCallback(() => {
        const name = presetNameInput.trim();
        if (!name) {
            flashToast("Preset name cannot be empty");
            return;
        }
        const next = [
            ...namedPresets.filter((p) => p.name !== name),
            {
                name,
                createdAt: new Date().toISOString(),
                defaults: JSON.parse(JSON.stringify(defaults)),
            },
        ].sort((a, b) => a.name.localeCompare(b.name));
        setNamedPresets(next);
        setSavePresetDialogOpen(false);
        auditLog.record({
            actor: AUDIT_ACTOR,
            action: "save_named_preset",
            target: `preset:${name}`,
            status: "success",
            details: { totalPresets: next.length },
        });
        flashToast(`Saved preset "${name}"`);
    }, [presetNameInput, namedPresets, defaults, setNamedPresets, flashToast]);
    const handleLoadPreset = React.useCallback((preset) => {
        // Merge with INITIAL_POOL_DEFAULTS so older presets that predate new
        // fields don't blow up the form.
        const merged = Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS), preset.defaults);
        setEverything(merged);
        setPresetsDialogOpen(false);
        auditLog.record({
            actor: AUDIT_ACTOR,
            action: "load_named_preset",
            target: `preset:${preset.name}`,
            status: "success",
            details: Object.assign({ presetCreatedAt: preset.createdAt }, summarizeDefaultsDiff(defaults, merged)),
        });
        flashToast(`Loaded preset "${preset.name}"`);
    }, [setEverything, defaults, flashToast]);
    const handleDeletePreset = React.useCallback((name) => {
        setNamedPresets(namedPresets.filter((p) => p.name !== name));
        setConfirmDeletePreset(null);
        auditLog.record({
            actor: AUDIT_ACTOR,
            action: "delete_named_preset",
            target: `preset:${name}`,
            status: "success",
        });
        flashToast(`Deleted preset "${name}"`);
    }, [namedPresets, setNamedPresets, flashToast]);
    // Export a single named preset as a JSON envelope. Wave-1 only supported
    // wholesale export of the *current* defaults; this lets the operator
    // hand off a known-good preset to a peer or check it into source control.
    const handleExportPreset = React.useCallback((preset) => {
        const date = new Date().toISOString().slice(0, 10);
        const safeName = preset.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const payload = {
            exportedAt: new Date().toISOString(),
            schema: "pool-defaults-preset/v1",
            preset,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json;charset=utf-8;",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pool-defaults-preset-${safeName}-${date}.json`;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        auditLog.record({
            actor: AUDIT_ACTOR,
            action: "export_named_preset",
            target: `preset:${preset.name}`,
            status: "success",
            details: { createdAt: preset.createdAt },
        });
        flashToast(`Exported preset "${preset.name}"`);
    }, [flashToast]);
    // Hidden file input for importing a single preset envelope. Distinct from
    // the wholesale defaults importer so a preset never silently overwrites
    // the live form — it lands in the named-preset library instead.
    const presetImportInputRef = React.useRef(null);
    const triggerPresetImport = React.useCallback(() => {
        var _a;
        setImportError(null);
        (_a = presetImportInputRef.current) === null || _a === void 0 ? void 0 : _a.click();
    }, []);
    const handleImportPresetFile = React.useCallback((file) => __awaiter(void 0, void 0, void 0, function* () {
        var _k;
        if (!file)
            return;
        try {
            const text = yield file.text();
            const parsed = JSON.parse(text);
            // Accept either the wrapped envelope or a bare NamedPreset object.
            const rawPreset = parsed && typeof parsed === "object" && "preset" in parsed
                ? parsed.preset
                : parsed;
            if (!rawPreset || typeof rawPreset !== "object") {
                throw new Error("Top-level object expected");
            }
            const candidate = rawPreset;
            if (!candidate.name || typeof candidate.name !== "string") {
                throw new Error("Preset is missing a 'name' field");
            }
            if (!candidate.defaults || typeof candidate.defaults !== "object") {
                throw new Error("Preset is missing a 'defaults' field");
            }
            // Merge with INITIAL_POOL_DEFAULTS so older presets don't crash.
            const mergedDefaults = Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS), candidate.defaults);
            const newPreset = {
                name: candidate.name,
                createdAt: (_k = candidate.createdAt) !== null && _k !== void 0 ? _k : new Date().toISOString(),
                defaults: mergedDefaults,
            };
            const next = [
                ...namedPresets.filter((p) => p.name !== newPreset.name),
                newPreset,
            ].sort((a, b) => a.name.localeCompare(b.name));
            setNamedPresets(next);
            auditLog.record({
                actor: AUDIT_ACTOR,
                action: "import_named_preset",
                target: `preset:${newPreset.name}`,
                status: "success",
                details: { fileBytes: file.size, totalPresets: next.length },
            });
            flashToast(`Imported preset "${newPreset.name}"`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown parse error";
            setImportError(`Failed to import preset: ${msg}`);
            auditLog.record({
                actor: AUDIT_ACTOR,
                action: "import_named_preset",
                target: `file:${file.name}`,
                status: "failure",
                error: msg,
            });
        }
        finally {
            if (presetImportInputRef.current)
                presetImportInputRef.current.value = "";
        }
    }), [namedPresets, setNamedPresets, flashToast]);
    // Compare picker — resolves the sentinel values "__current__" /
    // "__saved__" against the in-memory snapshot so the diff renderer can
    // treat every option uniformly.
    const resolveCompareSnapshot = React.useCallback((id) => {
        if (id === "__current__")
            return { label: "Current form", data: defaults };
        if (id === "__saved__")
            return { label: "Last saved", data: savedSnapshot };
        const p = namedPresets.find((n) => n.name === id);
        if (!p)
            return { label: id, data: null };
        return { label: `Preset: ${p.name}`, data: p.defaults };
    }, [defaults, savedSnapshot, namedPresets]);
    // JSON import/export
    const handleExportJson = React.useCallback(() => {
        const date = new Date().toISOString().slice(0, 10);
        const payload = {
            exportedAt: new Date().toISOString(),
            schema: "pool-defaults/v1",
            defaults,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json;charset=utf-8;",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pool-defaults-${date}.json`;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        flashToast("Exported pool-defaults JSON");
    }, [defaults, flashToast]);
    const triggerImport = React.useCallback(() => {
        var _a;
        setImportError(null);
        (_a = importInputRef.current) === null || _a === void 0 ? void 0 : _a.click();
    }, []);
    const handleImportFile = React.useCallback((file) => __awaiter(void 0, void 0, void 0, function* () {
        var _l, _m, _o, _p, _q, _r, _s;
        if (!file)
            return;
        try {
            const text = yield file.text();
            const parsed = JSON.parse(text);
            // Accept either the wrapped envelope or a bare PoolDefaults object.
            const rawDefaults = parsed && typeof parsed === "object" && "defaults" in parsed
                ? parsed.defaults
                : parsed;
            if (!rawDefaults || typeof rawDefaults !== "object")
                throw new Error("Top-level object expected");
            // Merge with the factory shape so unknown fields are tolerated and
            // missing fields fall back to factory.
            const merged = Object.assign(Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS), rawDefaults), { virtualMachineConfiguration: Object.assign(Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS.virtualMachineConfiguration), ((_l = rawDefaults
                    .virtualMachineConfiguration) !== null && _l !== void 0 ? _l : {})), { imageReference: Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS.virtualMachineConfiguration
                        .imageReference), ((_o = (_m = rawDefaults
                        .virtualMachineConfiguration) === null || _m === void 0 ? void 0 : _m.imageReference) !== null && _o !== void 0 ? _o : {})) }), startTask: Object.assign(Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS.startTask), ((_p = rawDefaults.startTask) !== null && _p !== void 0 ? _p : {})), { userIdentity: {
                        autoUser: Object.assign(Object.assign({}, INITIAL_POOL_DEFAULTS.startTask.userIdentity.autoUser), ((_s = (_r = (_q = rawDefaults.startTask) === null || _q === void 0 ? void 0 : _q.userIdentity) === null || _r === void 0 ? void 0 : _r.autoUser) !== null && _s !== void 0 ? _s : {})),
                    } }) });
            setEverything(merged);
            auditLog.record({
                actor: AUDIT_ACTOR,
                action: "import_pool_defaults",
                target: `file:${file.name}`,
                status: "success",
                details: Object.assign({ fileBytes: file.size }, summarizeDefaultsDiff(defaults, merged)),
            });
            flashToast(`Imported ${file.name}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown parse error";
            setImportError(`Failed to import: ${msg}`);
            auditLog.record({
                actor: AUDIT_ACTOR,
                action: "import_pool_defaults",
                target: `file:${file.name}`,
                status: "failure",
                error: msg,
            });
        }
        finally {
            // Clear so re-selecting the same file fires a fresh change event.
            if (importInputRef.current)
                importInputRef.current.value = "";
        }
    }), [setEverything, defaults, flashToast]);
    // Dynamic list helpers
    const addMetadata = React.useCallback(() => {
        update({ metadata: [...defaults.metadata, { name: "", value: "" }] });
    }, [update, defaults.metadata]);
    const removeMetadata = React.useCallback((idx) => {
        update({ metadata: defaults.metadata.filter((_, i) => i !== idx) });
    }, [update, defaults.metadata]);
    const updateMetadata = React.useCallback((idx, field, val) => {
        update({
            metadata: defaults.metadata.map((m, i) => i === idx ? Object.assign(Object.assign({}, m), { [field]: val }) : m),
        });
    }, [update, defaults.metadata]);
    const addUserAccount = React.useCallback(() => {
        update({
            userAccounts: [
                ...defaults.userAccounts,
                { name: "", password: "", elevationLevel: "admin" },
            ],
        });
    }, [update, defaults.userAccounts]);
    const removeUserAccount = React.useCallback((idx) => {
        update({
            userAccounts: defaults.userAccounts.filter((_, i) => i !== idx),
        });
    }, [update, defaults.userAccounts]);
    const updateUserAccount = React.useCallback((idx, patch) => {
        update({
            userAccounts: defaults.userAccounts.map((u, i) => i === idx ? Object.assign(Object.assign({}, u), patch) : u),
        });
    }, [update, defaults.userAccounts]);
    /**
     * Generate a cryptographically-random password that satisfies our
     * strength rule (12 chars; upper, lower, digit, symbol).
     */
    const generatePassword = React.useCallback(() => {
        const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
        const lower = "abcdefghjkmnpqrstuvwxyz";
        const digit = "23456789";
        const symbol = "!@#$%^&*-_+=";
        const all = upper + lower + digit + symbol;
        const len = 16;
        const cryptoSrc = typeof window !== "undefined" && window.crypto ? window.crypto : null;
        const rand = (n) => {
            if (cryptoSrc) {
                const arr = new Uint32Array(1);
                cryptoSrc.getRandomValues(arr);
                return arr[0] % n;
            }
            return Math.floor(Math.random() * n);
        };
        const out = [
            upper[rand(upper.length)],
            lower[rand(lower.length)],
            digit[rand(digit.length)],
            symbol[rand(symbol.length)],
        ];
        for (let i = out.length; i < len; i++)
            out.push(all[rand(all.length)]);
        // Fisher-Yates shuffle so the required chars aren't always at the front.
        for (let i = out.length - 1; i > 0; i--) {
            const j = rand(i + 1);
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out.join("");
    }, []);
    const fillRandomPassword = React.useCallback((idx) => {
        updateUserAccount(idx, { password: generatePassword() });
        flashToast("Strong password generated");
    }, [updateUserAccount, generatePassword, flashToast]);
    const addEnvVar = React.useCallback(() => {
        updateStartTask({
            environmentSettings: [
                ...defaults.startTask.environmentSettings,
                { name: "", value: "" },
            ],
        });
    }, [updateStartTask, defaults.startTask.environmentSettings]);
    const removeEnvVar = React.useCallback((idx) => {
        updateStartTask({
            environmentSettings: defaults.startTask.environmentSettings.filter((_, i) => i !== idx),
        });
    }, [updateStartTask, defaults.startTask.environmentSettings]);
    const updateEnvVar = React.useCallback((idx, field, val) => {
        updateStartTask({
            environmentSettings: defaults.startTask.environmentSettings.map((ev, i) => (i === idx ? Object.assign(Object.assign({}, ev), { [field]: val }) : ev)),
        });
    }, [updateStartTask, defaults.startTask.environmentSettings]);
    const addResourceFile = React.useCallback(() => {
        updateStartTask({
            resourceFiles: [
                ...defaults.startTask.resourceFiles,
                { httpUrl: "", filePath: "" },
            ],
        });
    }, [updateStartTask, defaults.startTask.resourceFiles]);
    const removeResourceFile = React.useCallback((idx) => {
        updateStartTask({
            resourceFiles: defaults.startTask.resourceFiles.filter((_, i) => i !== idx),
        });
    }, [updateStartTask, defaults.startTask.resourceFiles]);
    const updateResourceFile = React.useCallback((idx, patch) => {
        updateStartTask({
            resourceFiles: defaults.startTask.resourceFiles.map((rf, i) => i === idx ? Object.assign(Object.assign({}, rf), patch) : rf),
        });
    }, [updateStartTask, defaults.startTask.resourceFiles]);
    // When a section flips from clean → modified, expand it so the user sees
    // exactly what changed.
    const lastSectionDiffRef = React.useRef(NO_DIFF);
    React.useEffect(() => {
        Object.keys(SECTION_NUMBERS).forEach((k) => {
            if (sectionDiff[k] && !lastSectionDiffRef.current[k]) {
                ensureSectionExpanded(SECTION_NUMBERS[k]);
            }
        });
        lastSectionDiffRef.current = sectionDiff;
    }, [sectionDiff, ensureSectionExpanded]);
    // Preview JSON
    const previewJson = React.useMemo(() => JSON.stringify(buildPoolConfigFromDefaults(defaults), null, 2), [defaults]);
    // Privileged-default detector — surfaces an inline banner BEFORE the
    // operator hits Save when the default StartTask would run as root /
    // LocalSystem on every future pool. Mirrors the resource-plane
    // "centrally-edited elevated identity" primitive analyzed in
    // _analysis_netspi.md §II (RunAs / Logic-App connection hijack).
    const privFootprint = React.useMemo(() => detectPrivilegedDefault(defaults), [defaults]);
    const showPrivBanner = privFootprint.elevated &&
        (privFootprint.hasCommand ||
            privFootprint.hasResourceFiles ||
            privFootprint.hasUnscopedSecretEnv);
    // Keyboard shortcuts — only active when no input/textarea/select is focused
    // except for the special Cmd+S / Cmd+E which we always intercept.
    React.useEffect(() => {
        const handler = (e) => {
            const mod = e.ctrlKey || e.metaKey;
            const target = e.target;
            const inEditable = target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement ||
                (target === null || target === void 0 ? void 0 : target.isContentEditable) === true;
            // Cmd/Ctrl+S — Save (always intercepts; the browser's Save Page
            // dialog isn't what the user wants here).
            if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
                e.preventDefault();
                if (isDirty)
                    handleSave();
                return;
            }
            // Cmd/Ctrl+E — Export JSON.
            if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
                e.preventDefault();
                handleExportJson();
                return;
            }
            // Cmd/Ctrl+Shift+Z — Revert.
            if (mod && e.shiftKey && e.key.toLowerCase() === "z") {
                e.preventDefault();
                if (isDirty)
                    handleRevert();
                return;
            }
            // Cmd/Ctrl+R — Reset to factory (with confirm). Browsers' default
            // Ctrl+R is "reload page" which would silently lose all unsaved edits
            // and be ambiguous with our "reset". We intercept and open the safe
            // confirmation dialog instead. NEVER swallow when typing in a field
            // — the user might genuinely want to reload.
            if (mod &&
                !e.shiftKey &&
                !e.altKey &&
                e.key.toLowerCase() === "r" &&
                !inEditable) {
                e.preventDefault();
                handleReset();
                return;
            }
            // Alt+E / Alt+C — Expand / collapse all sections (avoid when typing).
            if (e.altKey && !mod && !inEditable) {
                if (e.key.toLowerCase() === "e") {
                    e.preventDefault();
                    expandAll();
                }
                else if (e.key.toLowerCase() === "c") {
                    e.preventDefault();
                    collapseAll();
                }
                else if (e.key === "?" || (e.shiftKey && e.key === "/")) {
                    e.preventDefault();
                    setKeyboardHelpOpen(true);
                }
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        isDirty,
        handleSave,
        handleRevert,
        handleReset,
        handleExportJson,
        expandAll,
        collapseAll,
    ]);
    // Section filter helpers — declared up here so we can use them when
    // rendering each card.
    const filterMatch = React.useCallback((haystack) => {
        const f = filter.trim().toLowerCase();
        if (!f)
            return true;
        return haystack.toLowerCase().includes(f);
    }, [filter]);
    const buildSectionToolbar = (key, sectionLabel, sectionJson) => (React.createElement(React.Fragment, null,
        React.createElement(CopyButton, { value: JSON.stringify(sectionJson, null, 2), alwaysVisible: true, ariaLabel: `Copy ${sectionLabel} section JSON to clipboard`, iconSize: 14, className: "h-7 w-7" }),
        sectionDiff[key] && savedSnapshot && (React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => setConfirmDiscardSection(key), title: `Discard unsaved ${sectionLabel} changes`, "aria-label": `Discard unsaved ${sectionLabel} changes` },
            React.createElement(Undo2, { className: "h-3.5 w-3.5", "aria-hidden": true })))));
    // Section-card visibility based on the filter.
    const sectionVisible = {
        os: filterMatch("os operating system image publisher offer sku version node agent linux windows ubuntu centos windowsserver"),
        optional: filterMatch("optional task slots inter-node intern-node communication scheduling pack spread metadata user accounts elevation"),
        startTask: filterMatch("start task command line retry wait for success user identity scope elevation resource files environment variables env"),
        network: filterMatch("network subnet vnet arm"),
        preview: filterMatch("preview json output config"),
    };
    return (React.createElement("div", { className: "flex flex-col gap-4 py-4", role: "region", "aria-label": "Pool default settings page" },
        React.createElement(PageHeader, { title: "Pool Default Settings", description: "OS, start task, and network defaults used by all pool creation modes. Pool names, VM sizes, and node counts are calculated automatically." },
            React.createElement("span", { role: "status", "aria-live": "polite", "aria-label": isDirty
                    ? `Unsaved changes in ${changedSectionLabels.join(", ")}`
                    : "All changes saved", className: cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider transition-colors duration-200 ease-out motion-reduce:transition-none", isDirty
                    ? "bg-warning/15 text-warning"
                    : "bg-success/15 text-success") },
                isDirty ? (React.createElement(CircleDot, { className: "h-3 w-3", "aria-hidden": true })) : (React.createElement(Check, { className: "h-3 w-3", "aria-hidden": true })),
                isDirty
                    ? `Modified · ${changedSectionLabels.length}`
                    : "Saved"),
            hasErrors && (React.createElement("span", { role: "status", "aria-live": "polite", className: "inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-destructive" },
                React.createElement(XCircle, { className: "h-3 w-3", "aria-hidden": true }),
                errorCount,
                " error",
                errorCount === 1 ? "" : "s")),
            React.createElement(DropdownMenu, null,
                React.createElement(DropdownMenuTrigger, { asChild: true },
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", "aria-label": "Open presets menu", title: "Apply a built-in preset or load a saved configuration" },
                        React.createElement(Sparkles, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Presets")),
                React.createElement(DropdownMenuContent, { align: "end", className: "w-72" },
                    React.createElement(DropdownMenuLabel, { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" }, "Built-in scenarios"),
                    BUILTIN_PRESETS.map((p) => (React.createElement(DropdownMenuItem, { key: p.id, onSelect: () => applyBuiltinPreset(p), className: "flex flex-col items-start gap-0.5" },
                        React.createElement("span", { className: "text-sm font-medium" }, p.label),
                        React.createElement("span", { className: "text-2xs text-muted-foreground" }, p.description)))),
                    React.createElement(DropdownMenuSeparator, null),
                    React.createElement(DropdownMenuLabel, { className: "text-2xs font-semibold uppercase tracking-wider text-muted-foreground" },
                        "Saved presets (",
                        namedPresets.length,
                        ")"),
                    namedPresets.length === 0 ? (React.createElement("div", { className: "px-2 py-1.5 text-2xs text-muted-foreground" }, "No saved presets yet \u2014 use \"Save current as preset\" below.")) : (namedPresets.slice(0, 8).map((p) => (React.createElement(DropdownMenuItem, { key: p.name, onSelect: () => handleLoadPreset(p) },
                        React.createElement(FileJson, { "aria-hidden": true }),
                        React.createElement("span", { className: "flex-1 truncate" }, p.name))))),
                    React.createElement(DropdownMenuSeparator, null),
                    React.createElement(DropdownMenuItem, { onSelect: handleSavePreset },
                        React.createElement(Save, { "aria-hidden": true }),
                        "Save current as preset\u2026"),
                    React.createElement(DropdownMenuItem, { onSelect: () => setPresetsDialogOpen(true), disabled: namedPresets.length === 0 },
                        React.createElement(FileJson, { "aria-hidden": true }),
                        "Manage presets (",
                        namedPresets.length,
                        ")"))),
            React.createElement("input", { ref: importInputRef, type: "file", accept: "application/json,.json", className: "hidden", "aria-hidden": true, tabIndex: -1, onChange: (e) => { var _a; return handleImportFile((_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0]); } }),
            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: triggerImport, "aria-label": "Import pool defaults from a JSON file", title: "Load a previously exported pool-defaults JSON" },
                React.createElement(FileUp, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Import"),
            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleExportJson, "aria-label": "Export pool defaults as JSON", title: "Download the current defaults as JSON (Ctrl+E)" },
                React.createElement(Download, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Export"),
            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleRevert, disabled: !isDirty || !savedSnapshot, title: !isDirty
                    ? "No unsaved changes to revert"
                    : !savedSnapshot
                        ? "No saved snapshot available yet"
                        : `Revert unsaved changes in ${changedSectionLabels.join(", ")} (Ctrl+Shift+Z)`, "aria-label": "Revert all unsaved changes" },
                React.createElement(Undo2, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Revert"),
            React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: handleReset, "aria-label": "Reset pool defaults to factory values", title: "Restore every section to factory defaults", className: "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" },
                React.createElement(RotateCcw, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Reset"),
            React.createElement(Button, { type: "button", variant: "default", size: "sm", onClick: handleSave, disabled: !isDirty || hasErrors, title: !isDirty
                    ? "No changes to save"
                    : hasErrors
                        ? `Fix ${errorCount} validation error${errorCount === 1 ? "" : "s"} before saving`
                        : `Save changes in ${changedSectionLabels.join(", ")} (Ctrl+S)`, "aria-label": "Save pool defaults" },
                React.createElement(Save, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Save defaults")),
        React.createElement("div", { className: "flex flex-wrap items-center gap-2" },
            React.createElement("div", { className: "relative flex-1 min-w-[14rem] max-w-[26rem]" },
                React.createElement(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground", "aria-hidden": true }),
                React.createElement(Input, { id: filterInputId, value: filter, onChange: (e) => setFilter(e.target.value), placeholder: "Filter sections (e.g. metadata, subnet, env)\u2026", "aria-label": "Filter pool default sections by keyword", className: "pl-8" }),
                filter && (React.createElement("button", { type: "button", onClick: () => setFilter(""), "aria-label": "Clear filter", className: "absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" },
                    React.createElement(XCircle, { className: "h-3.5 w-3.5" })))),
            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: expandAll, "aria-label": "Expand all sections", title: "Expand every section (Alt+E)" },
                React.createElement(ChevronsUpDown, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Expand all"),
            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: collapseAll, "aria-label": "Collapse all sections", title: "Collapse every section (Alt+C)" },
                React.createElement(ChevronsDownUp, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Collapse all"),
            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setCompareDialogOpen(true), "aria-label": "Compare two pool-default profiles side by side", title: "Side-by-side diff of any two presets, the current form, or the last saved snapshot" },
                React.createElement(Columns, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Compare"),
            React.createElement(Button, { type: "button", variant: "ghost", size: "sm", onClick: () => setTryPreviewOpen(true), "aria-label": "Try the defaults in a pool-creation form preview before saving", title: "Render a read-only pool-creation form pre-filled with these defaults" },
                React.createElement(Eye, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                "Try before save"),
            React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => setKeyboardHelpOpen(true), "aria-label": "Show keyboard shortcuts", title: "Keyboard shortcuts (Alt+?)" },
                React.createElement(Keyboard, { className: "h-3.5 w-3.5", "aria-hidden": true }))),
        isDirty && (React.createElement(Alert, { variant: "warning", role: "status", "aria-live": "polite" },
            React.createElement(CircleDot, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertTitle, null, "Unsaved changes"),
            React.createElement(AlertDescription, null,
                "You have unsaved edits in ",
                React.createElement("b", null, changedSectionLabels.join(", ")),
                ". Click ",
                React.createElement("b", null, "Save defaults"),
                " to apply them, or ",
                React.createElement("b", null, "Revert"),
                " to discard."))),
        (errorCount > 0 || warningCount > 0) && (React.createElement(Alert, { variant: errorCount > 0 ? "destructive" : "warning", role: errorCount > 0 ? "alert" : "status", "aria-live": "polite" },
            errorCount > 0 ? (React.createElement(XCircle, { className: "h-4 w-4", "aria-hidden": true })) : (React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true })),
            React.createElement(AlertTitle, null,
                errorCount > 0 && (React.createElement(React.Fragment, null,
                    errorCount,
                    " error",
                    errorCount === 1 ? "" : "s")),
                errorCount > 0 && warningCount > 0 && ", ",
                warningCount > 0 && (React.createElement(React.Fragment, null,
                    warningCount,
                    " warning",
                    warningCount === 1 ? "" : "s"))),
            React.createElement(AlertDescription, null,
                React.createElement("ul", { className: "m-0 mt-1 list-disc space-y-0.5 pl-4 text-xs" },
                    issues.slice(0, 8).map((i, idx) => (React.createElement("li", { key: idx },
                        React.createElement("span", { className: "font-medium" },
                            SECTION_LABELS[i.section],
                            ":"),
                        " ",
                        i.message))),
                    issues.length > 8 && (React.createElement("li", { className: "text-muted-foreground" },
                        "\u2026and ",
                        issues.length - 8,
                        " more")))))),
        showPrivBanner && (React.createElement(Alert, { variant: "warning", role: "status", "aria-live": "polite" },
            React.createElement(ShieldAlert, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertTitle, null, "Elevated start task will propagate to all future pools"),
            React.createElement(AlertDescription, null,
                React.createElement("p", { className: "m-0" },
                    "The default start task runs as",
                    " ",
                    React.createElement("b", null,
                        privFootprint.poolScope ? "pool-scope" : "task-scope",
                        " admin"),
                    " ",
                    "(",
                    defaults.osCategory === "windows"
                        ? "Administrator / LocalSystem on Windows"
                        : "root on Linux",
                    "). Every pool created through this tool \u2014 pool-creation, unused-quota recovery, and the orchestrator's auto-pool flow \u2014 will inherit this identity and execute the configured command on every node."),
                React.createElement("ul", { className: "m-0 mt-1 list-disc space-y-0.5 pl-4 text-2xs" },
                    privFootprint.hasResourceFiles && (React.createElement("li", null, "Resource files are downloaded as admin before the command runs \u2014 anyone who controls those URLs controls the node.")),
                    privFootprint.hasInsecureHttpFile && (React.createElement("li", null,
                        "At least one resource file uses plain ",
                        React.createElement("b", null, "http://"),
                        ". An on-path attacker can swap the payload \u2014 use https:// or a SAS URL.")),
                    privFootprint.hasUnscopedSecretEnv && (React.createElement("li", null, "An environment variable name looks like a credential (token / secret / key / password). It will be exposed to every task that reads the start-task environment \u2014 prefer Key Vault references or job-scoped secrets.")),
                    privFootprint.poolScope && (React.createElement("li", null, "Pool-scope means state written by the start task survives across tasks \u2014 installed binaries, cron jobs, and dropped files persist for the pool's lifetime."))),
                React.createElement("p", { className: "m-0 mt-1 text-2xs text-muted-foreground" }, "Mitigations: switch to task-scope user, drop to non-admin, or move secrets to a per-job context. This is a warning, not a blocker \u2014 save anyway if it's intentional.")))),
        importError && (React.createElement(Alert, { variant: "destructive", role: "alert" },
            React.createElement(XCircle, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertTitle, null, "Import failed"),
            React.createElement(AlertDescription, null,
                React.createElement("div", { className: "flex items-center justify-between gap-2" },
                    React.createElement("span", null, importError),
                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => setImportError(null), "aria-label": "Dismiss import error" },
                        React.createElement(XCircle, { className: "h-3.5 w-3.5" })))))),
        savedMsg && (React.createElement("div", { ref: saveBannerRef, tabIndex: -1, "aria-live": "assertive" },
            React.createElement(Alert, { variant: "success", "aria-label": savedMsg },
                React.createElement(Check, { className: "h-4 w-4", "aria-hidden": true }),
                React.createElement(AlertDescription, null, savedMsg)))),
        React.createElement("div", { role: "status", "aria-live": "polite", "aria-atomic": "true", className: "sr-only absolute h-px w-px overflow-hidden", style: { clip: "rect(0, 0, 0, 0)" } }, ariaAnnouncement),
        sectionVisible.os && (React.createElement(SectionCard, { number: 1, title: "Operating system", subtitle: "Image reference and node agent SKU", modified: sectionDiff.os, expanded: expandedSections.has(1), onToggle: () => toggleSection(1), issuesCount: {
                errors: issuesBySection.os.filter((i) => i.severity === "error")
                    .length,
                warnings: issuesBySection.os.filter((i) => i.severity === "warning")
                    .length,
            }, toolbar: buildSectionToolbar("os", "OS", {
                osCategory: defaults.osCategory,
                virtualMachineConfiguration: defaults.virtualMachineConfiguration,
            }) },
            React.createElement("div", { className: "flex flex-col gap-3" },
                React.createElement("div", { className: "flex flex-col gap-2" },
                    React.createElement(Label, { className: "text-xs font-medium text-muted-foreground" },
                        "Quick presets",
                        React.createElement(InfoTooltip, { content: "Apply a curated image + node agent SKU in one click. Edits below stay editable afterwards." })),
                    React.createElement("div", { className: "flex flex-wrap gap-2" }, OS_PRESET_CHIPS.map((chip) => {
                        const active = defaults.osCategory === chip.osCategory &&
                            defaults.virtualMachineConfiguration.imageReference.sku ===
                                chip.config.imageReference.sku &&
                            defaults.virtualMachineConfiguration.imageReference
                                .publisher === chip.config.imageReference.publisher;
                        return (React.createElement("button", { type: "button", key: chip.id, onClick: () => applyOsChip(chip), title: chip.description, "aria-pressed": active, className: cn("group flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border bg-surface-raised hover:border-primary/40 hover:bg-surface-overlay text-muted-foreground") },
                            React.createElement("span", { className: "flex items-center gap-1.5 font-semibold" },
                                active && (React.createElement(Check, { className: "h-3 w-3 text-primary", "aria-hidden": true })),
                                chip.label),
                            React.createElement("span", { className: "text-2xs" }, chip.description)));
                    }))),
                React.createElement(Field, { label: "Category", htmlFor: "pd-os-category", className: "max-w-[31rem]", hint: "Switching category resets the image to the default for that OS." },
                    React.createElement(Select, { value: defaults.osCategory, onValueChange: (v) => handleOsCategoryChange(v) },
                        React.createElement(SelectTrigger, { id: "pd-os-category", "aria-label": "Operating system category" },
                            React.createElement(SelectValue, { placeholder: "Select OS category" })),
                        React.createElement(SelectContent, null, OS_CATEGORY_OPTIONS.map((o) => (React.createElement(SelectItem, { key: o.value, value: o.value }, o.label)))))),
                React.createElement(Field, { label: "Publisher", htmlFor: publisherId, className: "max-w-[31rem]", hint: "VM marketplace publisher (e.g. 'canonical', 'microsoftwindowsserver'). Find via `az vm image list --publisher`.", error: (_a = issuesBySection.os.find((i) => i.field === "publisher" && i.severity === "error")) === null || _a === void 0 ? void 0 : _a.message },
                    React.createElement("div", { className: "group/copy flex items-center gap-1" },
                        React.createElement(Input, { id: publisherId, value: defaults.virtualMachineConfiguration.imageReference
                                .publisher, onChange: (e) => updateImageRef({ publisher: e.target.value }), "aria-label": "Image publisher", autoComplete: "off", spellCheck: false }),
                        React.createElement(CopyButton, { value: defaults.virtualMachineConfiguration.imageReference
                                .publisher, iconSize: 14 }))),
                React.createElement(Field, { label: "Offer", htmlFor: offerId, className: "max-w-[31rem]", hint: "Marketplace offer name from the chosen publisher.", error: (_b = issuesBySection.os.find((i) => i.field === "offer" && i.severity === "error")) === null || _b === void 0 ? void 0 : _b.message },
                    React.createElement("div", { className: "group/copy flex items-center gap-1" },
                        React.createElement(Input, { id: offerId, value: defaults.virtualMachineConfiguration.imageReference.offer, onChange: (e) => updateImageRef({ offer: e.target.value }), "aria-label": "Image offer", autoComplete: "off", spellCheck: false }),
                        React.createElement(CopyButton, { value: defaults.virtualMachineConfiguration.imageReference.offer, iconSize: 14 }))),
                React.createElement(Field, { label: "SKU", htmlFor: skuId, className: "max-w-[31rem]", hint: "Image SKU. Use a Gen2 SKU when possible \u2014 required for most modern VM sizes.", error: (_c = issuesBySection.os.find((i) => i.field === "sku" && i.severity === "error")) === null || _c === void 0 ? void 0 : _c.message },
                    React.createElement("div", { className: "group/copy flex items-center gap-1" },
                        React.createElement(Input, { id: skuId, value: defaults.virtualMachineConfiguration.imageReference.sku, onChange: (e) => updateImageRef({ sku: e.target.value }), "aria-label": "Image SKU", autoComplete: "off", spellCheck: false }),
                        React.createElement(CopyButton, { value: defaults.virtualMachineConfiguration.imageReference.sku, iconSize: 14 }))),
                React.createElement(Field, { label: "Version", htmlFor: versionId, className: "max-w-[31rem]", hint: "Specific image version, or 'latest' to track the newest published.", error: (_d = issuesBySection.os.find((i) => i.field === "version" && i.severity === "error")) === null || _d === void 0 ? void 0 : _d.message },
                    React.createElement(Input, { id: versionId, value: defaults.virtualMachineConfiguration.imageReference.version, onChange: (e) => updateImageRef({ version: e.target.value }), "aria-label": "Image version", autoComplete: "off", spellCheck: false })),
                React.createElement(Field, { label: "Node Agent SKU ID", htmlFor: nodeAgentId, className: "max-w-[31rem]", hint: "Identifies the Batch node-agent build that matches your OS. Mismatched SKUs cause nodes to never reach IDLE.", error: (_e = issuesBySection.os.find((i) => i.field === "nodeAgentSKUId" && i.severity === "error")) === null || _e === void 0 ? void 0 : _e.message, warning: (_f = issuesBySection.os.find((i) => i.field === "nodeAgentSKUId" && i.severity === "warning")) === null || _f === void 0 ? void 0 : _f.message },
                    React.createElement("div", { className: "group/copy flex items-center gap-1" },
                        React.createElement(Input, { id: nodeAgentId, value: defaults.virtualMachineConfiguration.nodeAgentSKUId, onChange: (e) => update({
                                virtualMachineConfiguration: Object.assign(Object.assign({}, defaults.virtualMachineConfiguration), { nodeAgentSKUId: e.target.value }),
                            }), "aria-label": "Node agent SKU ID", className: "font-mono text-xs" }),
                        React.createElement(CopyButton, { value: defaults.virtualMachineConfiguration.nodeAgentSKUId, iconSize: 14 })))))),
        sectionVisible.optional && (React.createElement(SectionCard, { number: 2, title: "Optional settings", subtitle: "Task slots, scheduling, metadata, and user accounts", modified: sectionDiff.optional, expanded: expandedSections.has(2), onToggle: () => toggleSection(2), issuesCount: {
                errors: issuesBySection.optional.filter((i) => i.severity === "error").length,
                warnings: issuesBySection.optional.filter((i) => i.severity === "warning").length,
            }, toolbar: buildSectionToolbar("optional", "Optional", {
                taskSlotsPerNode: defaults.taskSlotsPerNode,
                enableInterNodeCommunication: defaults.enableInterNodeCommunication,
                taskSchedulingPolicy: defaults.taskSchedulingPolicy,
                metadata: defaults.metadata,
                userAccounts: defaults.userAccounts,
            }) },
            React.createElement("div", { className: "flex flex-col gap-4" },
                React.createElement(Field, { label: "Task slots per node", htmlFor: taskSlotsId, hint: "How many concurrent tasks each node can run. Set to the number of vCPUs on the chosen VM size for CPU-bound workloads." },
                    React.createElement(NumberInput, { id: taskSlotsId, value: defaults.taskSlotsPerNode, min: 1, max: 256, step: 1, onChange: (n) => update({ taskSlotsPerNode: n }), "aria-label": "Task slots per node" })),
                React.createElement("div", { className: "flex items-center gap-3" },
                    React.createElement(Switch, { id: internodeId, checked: defaults.enableInterNodeCommunication, onCheckedChange: (checked) => update({
                            enableInterNodeCommunication: !!checked,
                        }), "aria-label": "Enable inter-node communication", "aria-pressed": defaults.enableInterNodeCommunication }),
                    React.createElement(Label, { htmlFor: internodeId, className: "text-sm text-foreground" },
                        "Inter-node communication",
                        React.createElement("span", { className: "ml-2 text-xs text-muted-foreground" }, defaults.enableInterNodeCommunication ? "ON" : "OFF"),
                        React.createElement(InfoTooltip, { className: "ml-1", content: "Required for MPI / distributed jobs. Limits the pool to a single placement group and a smaller maximum node count." }))),
                React.createElement(Field, { label: "Task scheduling policy", htmlFor: schedulingId, className: "max-w-[31rem]", hint: "Pack fills one node before scheduling onto the next (saves money). Spread distributes tasks (better latency / fault isolation)." },
                    React.createElement(Select, { value: defaults.taskSchedulingPolicy, onValueChange: (v) => update({
                            taskSchedulingPolicy: v,
                        }) },
                        React.createElement(SelectTrigger, { id: schedulingId, "aria-label": "Task scheduling policy" },
                            React.createElement(SelectValue, { placeholder: "Select scheduling policy" })),
                        React.createElement(SelectContent, null, SCHEDULING_POLICY_OPTIONS.map((o) => (React.createElement(SelectItem, { key: o.value, value: o.value }, o.label)))))),
                React.createElement("div", null,
                    React.createElement("h2", { className: "mb-2 flex items-center gap-1 text-sm font-semibold text-foreground" },
                        "Metadata",
                        React.createElement(InfoTooltip, { content: "Free-form key/value pairs attached to the pool. Available via Batch APIs and surfaced in monitoring." }),
                        React.createElement("span", { className: "ml-2 text-2xs text-muted-foreground" },
                            defaults.metadata.length,
                            " item",
                            defaults.metadata.length === 1 ? "" : "s")),
                    React.createElement("div", { role: "list", "aria-label": "Metadata items", className: "flex flex-col gap-2" },
                        defaults.metadata.map((m, idx) => {
                            const dupeErr = issuesBySection.optional.find((i) => i.field === "metadata" &&
                                i.message.includes(`"${m.name}"`));
                            return (React.createElement("div", { key: idx, role: "listitem", className: "flex flex-wrap items-end gap-2" },
                                React.createElement(Input, { placeholder: "Name", value: m.name, onChange: (e) => updateMetadata(idx, "name", e.target.value), "aria-label": `Metadata name ${idx + 1}`, className: cn("w-[12.5rem]", dupeErr && "border-destructive") }),
                                React.createElement(Input, { placeholder: "Value", value: m.value, onChange: (e) => updateMetadata(idx, "value", e.target.value), "aria-label": `Metadata value ${idx + 1}`, className: "w-[18.75rem]" }),
                                React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => removeMetadata(idx), title: "Remove metadata", "aria-label": `Remove metadata item ${idx + 1}`, className: "text-destructive hover:bg-destructive/10 hover:text-destructive" },
                                    React.createElement(Trash2, { className: "h-3.5 w-3.5" }))));
                        }),
                        defaults.metadata.length === 0 && (React.createElement("p", { className: "m-0 text-2xs italic text-muted-foreground" }, "No metadata items."))),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: addMetadata, "aria-label": "Add metadata item", className: "mt-2" },
                        React.createElement(Plus, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Add metadata")),
                React.createElement("div", null,
                    React.createElement("h2", { className: "mb-2 flex items-center gap-1 text-sm font-semibold text-foreground" },
                        "User accounts",
                        React.createElement(InfoTooltip, { content: "Linux/Windows accounts created on every node. Use these when start-task / tasks need a non-auto identity." }),
                        React.createElement("span", { className: "ml-2 text-2xs text-muted-foreground" },
                            defaults.userAccounts.length,
                            " account",
                            defaults.userAccounts.length === 1 ? "" : "s")),
                    React.createElement("div", { role: "list", "aria-label": "User accounts", className: "flex flex-col gap-2" },
                        defaults.userAccounts.map((u, idx) => {
                            const nameErr = issuesBySection.optional.find((i) => i.field === `userAccount.${idx}.name` ||
                                (i.field === "userAccounts" &&
                                    i.message.includes(`"${u.name}"`)));
                            const pwErr = issuesBySection.optional.find((i) => i.field === `userAccount.${idx}.password` &&
                                i.severity === "error");
                            const pwWarn = issuesBySection.optional.find((i) => i.field === `userAccount.${idx}.password` &&
                                i.severity === "warning");
                            return (React.createElement("div", { key: idx, role: "listitem", className: "flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3" },
                                React.createElement("div", { className: "flex flex-wrap items-end gap-2" },
                                    React.createElement("div", { className: "flex flex-col gap-1" },
                                        React.createElement(Input, { placeholder: "Name", value: u.name, onChange: (e) => updateUserAccount(idx, {
                                                name: e.target.value,
                                            }), "aria-label": `User account name ${idx + 1}`, className: cn("w-[11.25rem]", nameErr && "border-destructive") }),
                                        nameErr && (React.createElement("span", { className: "text-2xs text-destructive" }, nameErr.message))),
                                    React.createElement("div", { className: "flex flex-col gap-1" },
                                        React.createElement("div", { className: "flex items-center gap-1" },
                                            React.createElement(Input, { placeholder: "Password", type: "password", value: u.password, onChange: (e) => updateUserAccount(idx, {
                                                    password: e.target.value,
                                                }), "aria-label": `User account password ${idx + 1}`, className: cn("w-[12.5rem]", pwErr && "border-destructive", !pwErr && pwWarn && "border-warning"), autoComplete: "new-password" }),
                                            React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => fillRandomPassword(idx), title: "Generate a strong random password", "aria-label": `Generate password for user account ${idx + 1}` },
                                                React.createElement(Sparkles, { className: "h-3.5 w-3.5" }))),
                                        pwErr && (React.createElement("span", { className: "text-2xs text-destructive" }, pwErr.message)),
                                        !pwErr && pwWarn && (React.createElement("span", { className: "text-2xs text-warning" }, pwWarn.message))),
                                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => removeUserAccount(idx), title: "Remove user account", "aria-label": `Remove user account ${idx + 1}`, className: "text-destructive hover:bg-destructive/10 hover:text-destructive" },
                                        React.createElement(Trash2, { className: "h-3.5 w-3.5" }))),
                                React.createElement(Field, { label: "Elevation", htmlFor: `pd-user-elev-${idx}`, className: "max-w-[12.5rem]" },
                                    React.createElement(Select, { value: u.elevationLevel, onValueChange: (v) => updateUserAccount(idx, {
                                            elevationLevel: v,
                                        }) },
                                        React.createElement(SelectTrigger, { id: `pd-user-elev-${idx}`, "aria-label": `User account elevation ${idx + 1}` },
                                            React.createElement(SelectValue, { placeholder: "Select elevation" })),
                                        React.createElement(SelectContent, null, ELEVATION_OPTIONS.map((o) => (React.createElement(SelectItem, { key: o.value, value: o.value }, o.label))))))));
                        }),
                        defaults.userAccounts.length === 0 && (React.createElement("p", { className: "m-0 text-2xs italic text-muted-foreground" }, "No user accounts. Tasks will run as the Batch auto-user."))),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: addUserAccount, "aria-label": "Add user account", className: "mt-2" },
                        React.createElement(Plus, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Add user account"))))),
        sectionVisible.startTask && (React.createElement(SectionCard, { number: 3, title: "Start task", subtitle: "Runs once per node on first boot \u2014 block the node from accepting tasks until success", modified: sectionDiff.startTask, expanded: expandedSections.has(3), onToggle: () => toggleSection(3), issuesCount: {
                errors: issuesBySection.startTask.filter((i) => i.severity === "error").length,
                warnings: issuesBySection.startTask.filter((i) => i.severity === "warning").length,
            }, toolbar: buildSectionToolbar("startTask", "Start Task", defaults.startTask) },
            React.createElement("div", { className: "flex flex-col gap-3" },
                React.createElement(Field, { label: "Command line", htmlFor: startCmdId, className: "max-w-[44rem]", hint: "Single shell command run as PID 1 of the node-prep step. " +
                        'For Linux use \'/bin/bash -c "…"\', for Windows use \'cmd /c …\'.', trailing: React.createElement("span", { className: "ml-auto inline-flex items-center gap-1" },
                        React.createElement(CopyButton, { value: defaults.startTask.commandLine, alwaysVisible: true, iconSize: 12 })), warning: (_g = issuesBySection.startTask.find((i) => i.field === "commandLine" && i.severity === "warning")) === null || _g === void 0 ? void 0 : _g.message },
                    React.createElement("textarea", { id: startCmdId, rows: 3, value: defaults.startTask.commandLine, onChange: (e) => updateStartTask({
                            commandLine: e.target.value,
                        }), "aria-label": "Start task command line", className: "flex min-h-[5rem] w-full resize-y rounded-md border border-input bg-surface-sunken px-3 py-2 font-mono text-xs text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background", spellCheck: false, placeholder: defaults.osCategory === "linux"
                            ? '/bin/bash -c "apt-get install -y htop"'
                            : 'cmd /c "echo Hello"' })),
                React.createElement("div", { className: "flex flex-wrap items-end gap-6" },
                    React.createElement(Field, { label: "Max retry count", htmlFor: startMaxRetryId, hint: "How many times Batch retries the start task before marking the node UNUSABLE. Set 0 to disable retries.", warning: (_h = issuesBySection.startTask.find((i) => i.field === "maxTaskRetryCount" &&
                            i.severity === "warning")) === null || _h === void 0 ? void 0 : _h.message },
                        React.createElement(NumberInput, { id: startMaxRetryId, value: defaults.startTask.maxTaskRetryCount, min: 0, max: 100, step: 1, onChange: (n) => updateStartTask({
                                maxTaskRetryCount: n,
                            }), "aria-label": "Start task max retry count" })),
                    React.createElement("div", { className: "flex items-center gap-3" },
                        React.createElement(Switch, { id: startWaitId, checked: defaults.startTask.waitForSuccess, onCheckedChange: (checked) => updateStartTask({
                                waitForSuccess: !!checked,
                            }), "aria-label": "Wait for start task success", "aria-pressed": defaults.startTask.waitForSuccess }),
                        React.createElement(Label, { htmlFor: startWaitId, className: "text-sm text-foreground" },
                            "Wait for success",
                            React.createElement("span", { className: "ml-2 text-xs text-muted-foreground" }, defaults.startTask.waitForSuccess ? "Yes" : "No"),
                            React.createElement(InfoTooltip, { className: "ml-1", content: "When ON, nodes stay in STARTING until the start-task exits 0. Recommended for any setup that compute relies on." })))),
                React.createElement("div", { className: "flex flex-wrap items-end gap-6" },
                    React.createElement(Field, { label: "User identity scope", htmlFor: startScopeId, className: "max-w-[14rem] flex-1", hint: "Pool: state persists across tasks. Task: isolated per-task user, no carry-over." },
                        React.createElement(Select, { value: defaults.startTask.userIdentity.autoUser.scope, onValueChange: (v) => updateAutoUser({ scope: v }) },
                            React.createElement(SelectTrigger, { id: startScopeId, "aria-label": "User identity scope" },
                                React.createElement(SelectValue, { placeholder: "Select user scope" })),
                            React.createElement(SelectContent, null, USER_SCOPE_OPTIONS.map((o) => (React.createElement(SelectItem, { key: o.value, value: o.value }, o.label)))))),
                    React.createElement(Field, { label: "Elevation level", htmlFor: startElevId, className: "max-w-[14rem] flex-1", hint: "Admin runs as root (Linux) / Administrator (Windows). Most install commands need admin." },
                        React.createElement(Select, { value: defaults.startTask.userIdentity.autoUser.elevationLevel, onValueChange: (v) => updateAutoUser({
                                elevationLevel: v,
                            }) },
                            React.createElement(SelectTrigger, { id: startElevId, "aria-label": "Elevation level" },
                                React.createElement(SelectValue, { placeholder: "Select elevation" })),
                            React.createElement(SelectContent, null, ELEVATION_OPTIONS.map((o) => (React.createElement(SelectItem, { key: o.value, value: o.value }, o.label))))))),
                React.createElement("div", null,
                    React.createElement("h2", { className: "mb-2 flex items-center gap-1 text-sm font-semibold text-foreground" },
                        "Resource files",
                        React.createElement(InfoTooltip, { content: "Files downloaded from HTTP(S) into the start-task working directory before the command runs. Use SAS URLs for private blobs." }),
                        React.createElement("span", { className: "ml-2 text-2xs text-muted-foreground" },
                            defaults.startTask.resourceFiles.length,
                            " file",
                            defaults.startTask.resourceFiles.length === 1 ? "" : "s")),
                    React.createElement("div", { role: "list", "aria-label": "Resource files", className: "flex flex-col gap-2" },
                        defaults.startTask.resourceFiles.map((rf, idx) => {
                            var _a, _b;
                            const urlErr = issuesBySection.startTask.find((i) => i.field === `rf.${idx}.url` && i.severity === "error");
                            const urlWarn = issuesBySection.startTask.find((i) => i.field === `rf.${idx}.url` && i.severity === "warning");
                            const pathWarn = issuesBySection.startTask.find((i) => i.field === `rf.${idx}.path` &&
                                i.severity === "warning");
                            return (React.createElement("div", { key: idx, role: "listitem", className: "flex flex-col gap-1" },
                                React.createElement("div", { className: "flex flex-wrap items-end gap-2" },
                                    React.createElement(Input, { placeholder: "https://\u2026 or SAS URL", value: (_a = rf.httpUrl) !== null && _a !== void 0 ? _a : "", onChange: (e) => updateResourceFile(idx, {
                                            httpUrl: e.target.value,
                                        }), "aria-label": `Resource file URL ${idx + 1}`, className: cn("w-[24rem] font-mono text-xs", urlErr && "border-destructive", !urlErr && urlWarn && "border-warning") }),
                                    React.createElement(Input, { placeholder: "dest/path (relative to working dir)", value: (_b = rf.filePath) !== null && _b !== void 0 ? _b : "", onChange: (e) => updateResourceFile(idx, {
                                            filePath: e.target.value,
                                        }), "aria-label": `Resource file path ${idx + 1}`, className: cn("w-[14rem] font-mono text-xs", pathWarn && "border-warning") }),
                                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => removeResourceFile(idx), title: "Remove resource file", "aria-label": `Remove resource file ${idx + 1}`, className: "text-destructive hover:bg-destructive/10 hover:text-destructive" },
                                        React.createElement(Trash2, { className: "h-3.5 w-3.5" }))),
                                (urlErr || urlWarn || pathWarn) && (React.createElement("div", { className: "ml-1 text-2xs" },
                                    urlErr && (React.createElement("span", { className: "text-destructive" }, urlErr.message)),
                                    !urlErr && urlWarn && (React.createElement("span", { className: "text-warning" }, urlWarn.message)),
                                    pathWarn && (React.createElement("span", { className: "text-warning" },
                                        urlErr || urlWarn ? "  ·  " : "",
                                        pathWarn.message))))));
                        }),
                        defaults.startTask.resourceFiles.length === 0 && (React.createElement("p", { className: "m-0 text-2xs italic text-muted-foreground" }, "No resource files."))),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: addResourceFile, "aria-label": "Add resource file", className: "mt-2" },
                        React.createElement(Plus, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Add from URL")),
                React.createElement("div", null,
                    React.createElement("h2", { className: "mb-2 flex items-center gap-1 text-sm font-semibold text-foreground" },
                        "Environment variables",
                        React.createElement(InfoTooltip, { content: "Exported into the start-task shell. Note that tasks do NOT inherit these \u2014 use job-level env for that." }),
                        React.createElement("span", { className: "ml-2 text-2xs text-muted-foreground" },
                            defaults.startTask.environmentSettings.length,
                            " variable",
                            defaults.startTask.environmentSettings.length === 1
                                ? ""
                                : "s")),
                    React.createElement("div", { role: "list", "aria-label": "Environment variables", className: "flex flex-col gap-2" },
                        defaults.startTask.environmentSettings.map((ev, idx) => {
                            const dupeErr = issuesBySection.startTask.find((i) => i.field === "env" &&
                                i.message.includes(`"${ev.name}"`));
                            const whitespaceWarn = issuesBySection.startTask.find((i) => i.field === `env.${idx}.name` &&
                                i.severity === "warning");
                            return (React.createElement("div", { key: idx, role: "listitem", className: "flex flex-col gap-1" },
                                React.createElement("div", { className: "flex flex-wrap items-end gap-2" },
                                    React.createElement(Input, { placeholder: "VAR_NAME", value: ev.name, onChange: (e) => updateEnvVar(idx, "name", e.target.value), "aria-label": `Environment variable name ${idx + 1}`, className: cn("w-[12.5rem] font-mono text-xs", dupeErr && "border-destructive", !dupeErr && whitespaceWarn && "border-warning") }),
                                    React.createElement(Input, { placeholder: "value", value: ev.value, onChange: (e) => updateEnvVar(idx, "value", e.target.value), "aria-label": `Environment variable value ${idx + 1}`, className: "w-[18.75rem] font-mono text-xs" }),
                                    React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => removeEnvVar(idx), title: "Remove", "aria-label": `Remove environment variable ${idx + 1}`, className: "text-destructive hover:bg-destructive/10 hover:text-destructive" },
                                        React.createElement(Trash2, { className: "h-3.5 w-3.5" }))),
                                (dupeErr || whitespaceWarn) && (React.createElement("div", { className: "ml-1 text-2xs" },
                                    dupeErr && (React.createElement("span", { className: "text-destructive" }, dupeErr.message)),
                                    !dupeErr && whitespaceWarn && (React.createElement("span", { className: "text-warning" }, whitespaceWarn.message))))));
                        }),
                        defaults.startTask.environmentSettings.length === 0 && (React.createElement("p", { className: "m-0 text-2xs italic text-muted-foreground" }, "No environment variables."))),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: addEnvVar, "aria-label": "Add environment variable", className: "mt-2" },
                        React.createElement(Plus, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Add environment variable"))))),
        sectionVisible.network && (React.createElement(SectionCard, { number: 4, title: "Network configuration", subtitle: "Optional VNet integration", modified: sectionDiff.network, expanded: expandedSections.has(4), onToggle: () => toggleSection(4), issuesCount: {
                errors: issuesBySection.network.filter((i) => i.severity === "error").length,
                warnings: issuesBySection.network.filter((i) => i.severity === "warning").length,
            }, toolbar: buildSectionToolbar("network", "Network", {
                subnetId: defaults.subnetId,
            }) },
            React.createElement("div", { className: "flex flex-col gap-2" },
                React.createElement(Field, { label: "Subnet ID", htmlFor: subnetId, hint: "Full ARM resource ID of the VNet subnet the pool nodes will join. The Batch service principal needs Network Contributor on the VNet.", error: (_j = issuesBySection.network.find((i) => i.field === "subnetId" && i.severity === "error")) === null || _j === void 0 ? void 0 : _j.message },
                    React.createElement("div", { className: "group/copy flex items-center gap-1" },
                        React.createElement(Input, { id: subnetId, value: defaults.subnetId, onChange: (e) => update({ subnetId: e.target.value }), placeholder: "/subscriptions/{guid}/resourceGroups/.../subnets/{name}", "aria-label": "Subnet resource ID", className: cn("font-mono text-xs", defaults.subnetId &&
                                !SUBNET_ARM_REGEX.test(defaults.subnetId) &&
                                "border-destructive") }),
                        defaults.subnetId && (React.createElement(CopyButton, { value: defaults.subnetId, iconSize: 14, alwaysVisible: true })))),
                React.createElement("p", { className: "m-0 text-xs text-muted-foreground" },
                    "Leave empty for no VNet. Format:",
                    " ",
                    React.createElement("span", { className: "font-mono text-2xs" }, "/subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<subnet>"))))),
        sectionVisible.preview && (React.createElement(SectionCard, { number: 5, title: "Preview", subtitle: "JSON body sent to the Batch service", expanded: expandedSections.has(5), onToggle: () => toggleSection(5), toolbar: React.createElement(React.Fragment, null,
                React.createElement(CopyButton, { value: previewJson, alwaysVisible: true, ariaLabel: "Copy preview JSON to clipboard", iconSize: 14, className: "h-7 w-7" }),
                React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: handleExportJson, title: "Download as JSON file", "aria-label": "Download preview as JSON" },
                    React.createElement(Download, { className: "h-3.5 w-3.5", "aria-hidden": true }))) },
            React.createElement("div", { className: "flex flex-col gap-3" },
                React.createElement("pre", { className: "m-0 max-h-[25rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-sunken p-4 font-mono text-xs text-info", "aria-label": "Pool configuration JSON preview" }, previewJson),
                React.createElement("p", { className: "m-0 text-2xs text-muted-foreground" }, "Empty fields (no start-task command, no metadata, no subnet) are omitted from the output. Pool ID and target node counts are filled in by the calling page.")))),
        !Object.values(sectionVisible).some(Boolean) && (React.createElement(Alert, { variant: "default" },
            React.createElement(Search, { className: "h-4 w-4", "aria-hidden": true }),
            React.createElement(AlertTitle, null, "No sections match your filter"),
            React.createElement(AlertDescription, null,
                React.createElement("div", { className: "flex items-center justify-between gap-2" },
                    React.createElement("span", null,
                        "Nothing matched ",
                        React.createElement("b", null,
                            "\"",
                            filter,
                            "\""),
                        ". Clear the filter to see everything again."),
                    React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => setFilter("") }, "Clear filter"))))),
        React.createElement(ConfirmationDialog, { hidden: !confirmSaveOpen, title: "Save pool defaults?", message: React.createElement("div", { className: "space-y-2 text-sm leading-relaxed" },
                React.createElement("p", { className: "m-0" },
                    "These defaults will be applied to ",
                    React.createElement("b", null, "all future pool creations"),
                    " ",
                    "made through this tool \u2014 including pool-creation, unused-quota recovery, and the orchestrator's auto-pool workflow."),
                React.createElement("p", { className: "m-0 text-muted-foreground" }, "Existing pools are not affected."),
                warningCount > 0 && (React.createElement("p", { className: "m-0 mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-2xs text-warning" },
                    "Note: ",
                    warningCount,
                    " validation warning",
                    warningCount === 1 ? "" : "s",
                    " will be saved anyway. Errors are blocked."))), confirmText: "Save defaults", cancelText: "Cancel", onConfirm: handleConfirmSave, onCancel: () => setConfirmSaveOpen(false) }),
        React.createElement(ConfirmationDialog, { hidden: !confirmRevertOpen, title: "Revert all changes?", message: React.createElement("div", { className: "space-y-2 text-sm leading-relaxed" },
                React.createElement("p", { className: "m-0" },
                    "All unsaved edits in ",
                    React.createElement("b", null, changedSectionLabels.join(", ")),
                    " will be discarded and the last saved values will be restored."),
                React.createElement("p", { className: "m-0 text-muted-foreground" }, "Already-saved defaults are not affected.")), confirmText: "Revert changes", cancelText: "Keep editing", onConfirm: handleConfirmRevert, onCancel: () => setConfirmRevertOpen(false) }),
        React.createElement(ConfirmationDialog, { hidden: !confirmDiscardSection, title: `Discard changes in ${confirmDiscardSection ? SECTION_LABELS[confirmDiscardSection] : ""}?`, message: React.createElement("p", { className: "m-0 text-sm leading-relaxed" },
                "Only the ",
                React.createElement("b", null, confirmDiscardSection ? SECTION_LABELS[confirmDiscardSection] : ""),
                " ",
                "section will be restored to the last saved values. Other sections keep their unsaved edits."), confirmText: "Discard section changes", cancelText: "Keep editing", onConfirm: handleConfirmDiscardSection, onCancel: () => setConfirmDiscardSection(null) }),
        React.createElement(ConfirmationDialog, { hidden: !confirmResetOpen, title: "Reset pool defaults?", message: "All pool defaults will be reverted to factory values. This cannot be undone.", confirmText: "Reset to factory", cancelText: "Cancel", danger: true, onConfirm: handleConfirmReset, onCancel: () => setConfirmResetOpen(false) }),
        React.createElement(ConfirmationDialog, { hidden: !confirmDeletePreset, title: `Delete preset "${confirmDeletePreset !== null && confirmDeletePreset !== void 0 ? confirmDeletePreset : ""}"?`, message: "The saved preset will be permanently removed from this browser. This cannot be undone.", confirmText: "Delete preset", cancelText: "Cancel", danger: true, onConfirm: () => {
                if (confirmDeletePreset)
                    handleDeletePreset(confirmDeletePreset);
            }, onCancel: () => setConfirmDeletePreset(null) }),
        React.createElement(Dialog, { open: savePresetDialogOpen, onOpenChange: (open) => !open && setSavePresetDialogOpen(false) },
            React.createElement(DialogContent, null,
                React.createElement(DialogHeader, null,
                    React.createElement(DialogTitle, null, "Save current as preset"),
                    React.createElement(DialogDescription, null, "Give this configuration a name so you can load it again later. Saved presets live in your browser's localStorage.")),
                React.createElement("div", { className: "space-y-2" },
                    React.createElement(Label, { htmlFor: presetNameInputId }, "Preset name"),
                    React.createElement(Input, { id: presetNameInputId, autoFocus: true, value: presetNameInput, onChange: (e) => setPresetNameInput(e.target.value), placeholder: "e.g. ND40rs GPU training", onKeyDown: (e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                handleConfirmSavePreset();
                            }
                        } }),
                    namedPresets.some((p) => p.name === presetNameInput.trim() && presetNameInput.trim()) && (React.createElement("p", { className: "m-0 text-2xs text-warning" },
                        "A preset named \"",
                        presetNameInput.trim(),
                        "\" already exists \u2014 it will be overwritten."))),
                React.createElement(DialogFooter, null,
                    React.createElement(Button, { type: "button", variant: "outline", onClick: () => setSavePresetDialogOpen(false) }, "Cancel"),
                    React.createElement(Button, { type: "button", onClick: handleConfirmSavePreset, disabled: !presetNameInput.trim() },
                        React.createElement(Save, { className: "h-3.5 w-3.5" }),
                        "Save preset")))),
        React.createElement(Dialog, { open: presetsDialogOpen, onOpenChange: (open) => !open && setPresetsDialogOpen(false) },
            React.createElement(DialogContent, null,
                React.createElement(DialogHeader, null,
                    React.createElement(DialogTitle, null, "Saved presets"),
                    React.createElement(DialogDescription, null, namedPresets.length === 0
                        ? "No saved presets yet."
                        : `${namedPresets.length} preset${namedPresets.length === 1 ? "" : "s"} saved in this browser.`)),
                React.createElement("div", { className: "max-h-[28rem] overflow-y-auto" },
                    React.createElement("ul", { role: "list", "aria-label": "Saved presets", className: "m-0 flex flex-col gap-1 p-0" }, namedPresets.map((p) => (React.createElement("li", { key: p.name, className: "flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2" },
                        React.createElement("div", { className: "min-w-0 flex-1" },
                            React.createElement("div", { className: "truncate text-sm font-medium text-foreground" }, p.name),
                            React.createElement("div", { className: "text-2xs text-muted-foreground" },
                                "Saved ",
                                new Date(p.createdAt).toLocaleString())),
                        React.createElement(Button, { type: "button", variant: "outline", size: "sm", onClick: () => handleLoadPreset(p), "aria-label": `Load preset ${p.name}` }, "Load"),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => handleExportPreset(p), "aria-label": `Export preset ${p.name} as JSON`, title: "Export this preset as JSON" },
                            React.createElement(Download, { className: "h-3.5 w-3.5" })),
                        React.createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", onClick: () => setConfirmDeletePreset(p.name), "aria-label": `Delete preset ${p.name}`, className: "text-destructive hover:bg-destructive/10 hover:text-destructive" },
                            React.createElement(Trash2, { className: "h-3.5 w-3.5" }))))))),
                React.createElement(DialogFooter, null,
                    React.createElement("input", { ref: presetImportInputRef, type: "file", accept: "application/json,.json", className: "hidden", "aria-hidden": true, tabIndex: -1, onChange: (e) => { var _a; return handleImportPresetFile((_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0]); } }),
                    React.createElement(Button, { type: "button", variant: "outline", onClick: triggerPresetImport, "aria-label": "Import a preset from JSON", title: "Load a previously exported preset JSON into the library" },
                        React.createElement(FileUp, { className: "h-3.5 w-3.5", "aria-hidden": true }),
                        "Import preset"),
                    React.createElement(Button, { type: "button", variant: "outline", onClick: () => setPresetsDialogOpen(false) }, "Close")))),
        React.createElement(Dialog, { open: compareDialogOpen, onOpenChange: (open) => !open && setCompareDialogOpen(false) },
            React.createElement(DialogContent, { className: "max-w-5xl" },
                React.createElement(DialogHeader, null,
                    React.createElement(DialogTitle, null, "Compare profiles"),
                    React.createElement(DialogDescription, null, "Pick two profiles to diff side by side. Both sides are read-only \u2014 close the dialog and use Load to apply a preset.")),
                (() => {
                    const left = resolveCompareSnapshot(compareLeft);
                    const right = resolveCompareSnapshot(compareRight);
                    const renderJson = (d) => d ? JSON.stringify(d, null, 2) : "(no data)";
                    const leftJson = renderJson(left.data);
                    const rightJson = renderJson(right.data);
                    // Field-level summary — top-level keys that differ between the
                    // two snapshots. Anchors a quick "what's actually different"
                    // glance before the user dives into the JSON.
                    const diffKeys = [];
                    if (left.data && right.data) {
                        Object.keys(left.data).forEach((k) => {
                            if (!deepEqual(left.data[k], right.data[k]))
                                diffKeys.push(String(k));
                        });
                    }
                    const options = [
                        { value: "__current__", label: "Current form" },
                        { value: "__saved__", label: "Last saved snapshot" },
                        ...namedPresets.map((p) => ({
                            value: p.name,
                            label: `Preset: ${p.name}`,
                        })),
                    ];
                    return (React.createElement("div", { className: "flex flex-col gap-3" },
                        React.createElement("div", { className: "grid grid-cols-2 gap-3" },
                            React.createElement("div", { className: "flex flex-col gap-1" },
                                React.createElement(Label, { className: "text-xs font-medium text-muted-foreground" }, "Left"),
                                React.createElement(Select, { value: compareLeft, onValueChange: setCompareLeft },
                                    React.createElement(SelectTrigger, { "aria-label": "Left side of compare" },
                                        React.createElement(SelectValue, null)),
                                    React.createElement(SelectContent, null, options.map((o) => (React.createElement(SelectItem, { key: o.value, value: o.value }, o.label)))))),
                            React.createElement("div", { className: "flex flex-col gap-1" },
                                React.createElement(Label, { className: "text-xs font-medium text-muted-foreground" }, "Right"),
                                React.createElement(Select, { value: compareRight, onValueChange: setCompareRight },
                                    React.createElement(SelectTrigger, { "aria-label": "Right side of compare" },
                                        React.createElement(SelectValue, null)),
                                    React.createElement(SelectContent, null, options.map((o) => (React.createElement(SelectItem, { key: o.value, value: o.value }, o.label))))))),
                        left.data && right.data ? (diffKeys.length === 0 ? (React.createElement(Alert, { variant: "success" },
                            React.createElement(Check, { className: "h-4 w-4", "aria-hidden": true }),
                            React.createElement(AlertTitle, null, "Identical"),
                            React.createElement(AlertDescription, null,
                                React.createElement("b", null, left.label),
                                " and ",
                                React.createElement("b", null, right.label),
                                " have the same top-level fields."))) : (React.createElement(Alert, { variant: "warning" },
                            React.createElement(CircleDot, { className: "h-4 w-4", "aria-hidden": true }),
                            React.createElement(AlertTitle, null,
                                diffKeys.length,
                                " field",
                                diffKeys.length === 1 ? "" : "s",
                                " differ"),
                            React.createElement(AlertDescription, null,
                                React.createElement("code", { className: "font-mono text-2xs" }, diffKeys.join(", ")))))) : (React.createElement(Alert, { variant: "default" },
                            React.createElement(AlertTriangle, { className: "h-4 w-4", "aria-hidden": true }),
                            React.createElement(AlertDescription, null, "One side has no data \u2014 pick two valid profiles to diff."))),
                        React.createElement("div", { className: "grid grid-cols-2 gap-3" },
                            React.createElement("div", { className: "flex flex-col gap-1" },
                                React.createElement(Label, { className: "text-xs font-medium text-muted-foreground" }, left.label),
                                React.createElement("pre", { className: "m-0 max-h-[20rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-sunken p-3 font-mono text-2xs text-foreground", "aria-label": `${left.label} JSON` }, leftJson)),
                            React.createElement("div", { className: "flex flex-col gap-1" },
                                React.createElement(Label, { className: "text-xs font-medium text-muted-foreground" }, right.label),
                                React.createElement("pre", { className: "m-0 max-h-[20rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-sunken p-3 font-mono text-2xs text-foreground", "aria-label": `${right.label} JSON` }, rightJson)))));
                })(),
                React.createElement(DialogFooter, null,
                    React.createElement(Button, { type: "button", variant: "outline", onClick: () => setCompareDialogOpen(false) }, "Close")))),
        React.createElement(Dialog, { open: tryPreviewOpen, onOpenChange: (open) => !open && setTryPreviewOpen(false) },
            React.createElement(DialogContent, { className: "max-w-3xl" },
                React.createElement(DialogHeader, null,
                    React.createElement(DialogTitle, null, "Pool-creation form preview"),
                    React.createElement(DialogDescription, null, "A read-only mock of the pool-creation form pre-filled with the current defaults. Use this to validate the operator experience before committing.")),
                React.createElement("div", { className: "flex max-h-[28rem] flex-col gap-3 overflow-y-auto rounded-md border border-border bg-surface-sunken p-4" },
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Pool ID (set on the pool-creation page)"),
                        React.createElement(Input, { value: "batch-pool-{auto-generated}", readOnly: true, "aria-readonly": true, className: "font-mono text-xs", "aria-label": "Pool ID preview" })),
                    React.createElement("div", { className: "grid grid-cols-2 gap-3" },
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "OS category"),
                            React.createElement(Input, { value: defaults.osCategory, readOnly: true, "aria-readonly": true, "aria-label": "OS category preview" })),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Node agent SKU"),
                            React.createElement(Input, { value: defaults.virtualMachineConfiguration.nodeAgentSKUId, readOnly: true, "aria-readonly": true, className: "font-mono text-xs", "aria-label": "Node agent SKU preview" }))),
                    React.createElement("div", { className: "grid grid-cols-2 gap-3" },
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Publisher / Offer"),
                            React.createElement(Input, { value: `${defaults.virtualMachineConfiguration.imageReference.publisher} / ${defaults.virtualMachineConfiguration.imageReference.offer}`, readOnly: true, "aria-readonly": true, className: "font-mono text-xs", "aria-label": "Publisher and offer preview" })),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "SKU / Version"),
                            React.createElement(Input, { value: `${defaults.virtualMachineConfiguration.imageReference.sku} / ${defaults.virtualMachineConfiguration.imageReference.version}`, readOnly: true, "aria-readonly": true, className: "font-mono text-xs", "aria-label": "SKU and version preview" }))),
                    React.createElement("div", { className: "grid grid-cols-3 gap-3" },
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Task slots / node"),
                            React.createElement(Input, { value: String(defaults.taskSlotsPerNode), readOnly: true, "aria-readonly": true, "aria-label": "Task slots per node preview" })),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Inter-node comms"),
                            React.createElement(Input, { value: defaults.enableInterNodeCommunication ? "ON" : "OFF", readOnly: true, "aria-readonly": true, "aria-label": "Inter-node communication preview" })),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Scheduling"),
                            React.createElement(Input, { value: defaults.taskSchedulingPolicy, readOnly: true, "aria-readonly": true, "aria-label": "Scheduling policy preview" }))),
                    React.createElement("div", { className: "flex flex-col gap-1" },
                        React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Start task command"),
                        React.createElement("textarea", { value: defaults.startTask.commandLine || "(empty)", readOnly: true, "aria-readonly": true, rows: 2, className: "flex min-h-[3rem] w-full resize-none rounded-md border border-input bg-surface-raised px-3 py-2 font-mono text-xs text-foreground", "aria-label": "Start task command preview" })),
                    React.createElement("div", { className: "grid grid-cols-2 gap-3" },
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Start task identity"),
                            React.createElement(Input, { value: `${defaults.startTask.userIdentity.autoUser.scope} / ${defaults.startTask.userIdentity.autoUser.elevationLevel}`, readOnly: true, "aria-readonly": true, className: cn(privFootprint.elevated &&
                                    "border-warning text-warning"), "aria-label": "Start task identity preview" })),
                        React.createElement("div", { className: "flex flex-col gap-1" },
                            React.createElement("span", { className: "text-2xs uppercase tracking-wider text-muted-foreground" }, "Subnet"),
                            React.createElement(Input, { value: defaults.subnetId || "(no VNet)", readOnly: true, "aria-readonly": true, className: "font-mono text-xs", "aria-label": "Subnet preview" }))),
                    React.createElement("p", { className: "m-0 text-2xs italic text-muted-foreground" }, "This is a static preview. Actual fields on the pool-creation page are owned by that page's renderer.")),
                React.createElement(DialogFooter, null,
                    React.createElement(Button, { type: "button", variant: "outline", onClick: () => setTryPreviewOpen(false) }, "Close")))),
        React.createElement(Dialog, { open: keyboardHelpOpen, onOpenChange: (open) => !open && setKeyboardHelpOpen(false) },
            React.createElement(DialogContent, null,
                React.createElement(DialogHeader, null,
                    React.createElement(DialogTitle, null, "Keyboard shortcuts"),
                    React.createElement(DialogDescription, null, "Pool defaults page specific shortcuts.")),
                React.createElement("ul", { role: "list", className: "m-0 grid gap-1.5 p-0 text-sm" },
                    React.createElement("li", { className: "flex items-center justify-between gap-3" },
                        React.createElement("span", null, "Save defaults"),
                        React.createElement(KbdChord, { keys: "Ctrl+S" })),
                    React.createElement("li", { className: "flex items-center justify-between gap-3" },
                        React.createElement("span", null, "Revert unsaved changes"),
                        React.createElement(KbdChord, { keys: "Ctrl+Shift+Z" })),
                    React.createElement("li", { className: "flex items-center justify-between gap-3" },
                        React.createElement("span", null, "Reset to factory (with confirm)"),
                        React.createElement(KbdChord, { keys: "Ctrl+R" })),
                    React.createElement("li", { className: "flex items-center justify-between gap-3" },
                        React.createElement("span", null, "Export defaults as JSON"),
                        React.createElement(KbdChord, { keys: "Ctrl+E" })),
                    React.createElement("li", { className: "flex items-center justify-between gap-3" },
                        React.createElement("span", null, "Expand all sections"),
                        React.createElement(KbdChord, { keys: "Alt+E" })),
                    React.createElement("li", { className: "flex items-center justify-between gap-3" },
                        React.createElement("span", null, "Collapse all sections"),
                        React.createElement(KbdChord, { keys: "Alt+C" })),
                    React.createElement("li", { className: "flex items-center justify-between gap-3" },
                        React.createElement("span", null, "Show this dialog"),
                        React.createElement("span", { className: "inline-flex items-center gap-1" },
                            React.createElement(Kbd, null, "Alt"),
                            "+",
                            React.createElement(Kbd, null, "?")))),
                React.createElement("p", { className: "m-0 mt-1 text-2xs text-muted-foreground" }, "On macOS, Cmd replaces Ctrl. Shortcuts that don't include a modifier are ignored while typing in a text field."),
                React.createElement(DialogFooter, null,
                    React.createElement(Button, { type: "button", variant: "outline", onClick: () => setKeyboardHelpOpen(false) }, "Close"))))));
};
/**
 * Public page entry — wraps the inner form in an ErrorBoundary so a render
 * failure in any of the sections does not blank the whole dashboard pane.
 */
export const PoolDefaultsPage = () => (React.createElement(ErrorBoundary, null,
    React.createElement(PoolDefaultsPageInner, null)));
//# sourceMappingURL=pool-defaults-page.js.map