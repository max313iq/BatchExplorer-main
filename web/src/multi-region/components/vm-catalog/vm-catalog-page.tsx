/**
 * VM Catalog page — browse Azure VMs with live per-region availability,
 * Batch-supported flag, side-by-side comparison, export, and quick filters.
 *
 * Default scope: GPU SKUs only (Standard_ND/NC/NV/NG*). The Compute/skus
 * endpoint can return 600+ rows per subscription, the vast majority of
 * which are CPU-only and irrelevant for Batch GPU pools — pulling all of
 * them slows the load and floods the picker. The "Include CPU SKUs"
 * toggle in the toolbar lifts the filter when needed.
 *
 * Data sources (15-minute TTL-cached):
 *   - Microsoft.Compute/skus               (GPU subset, streamed)
 *   - Microsoft.Batch/.../virtualMachineSkus (per-region Batch support)
 *
 * Filters are designed for "I have a workload, find me the right VM":
 *   - Quick category chips: GPU, HPC, Compute, Memory, Storage, Burstable
 *   - GPU type chips: H100, A100, V100, T4, …
 *   - GPU count chips: 1 / 2 / 4 / 8 (whatever values the data has)
 *   - vCPU & memory range inputs
 *   - Region multi-select (with "Your accounts" shortcut)
 *   - Sort: name, GPU count desc, vCPUs desc, memory desc
 *   - Batch-supported only toggle (default ON)
 *   - Architecture (x64 / ARM64) chip
 *
 * Power-user affordances:
 *   - Per-row copy-SKU-name button
 *   - Per-row pin (favourite) — persists in localStorage; pinned rows float to top
 *   - Side-by-side compare (up to 4 SKUs) with capability diff highlighting
 *   - Export filtered rows to CSV or JSON
 *   - Keyboard: `/` focuses search, `Esc` clears search
 *   - Tooltips on every capability badge (vCPU/Mem/GPU/PremiumIO/InfiniBand/AccelNet/UltraSSD)
 *
 * Loading is progressive: rows render page-by-page, and Batch-availability
 * probes decorate rows asynchronously as each region's probe lands.
 */
import * as React from "react";
import {
  ChevronDown,
  Copy,
  Cpu,
  ExternalLink,
  FileDown,
  FileJson,
  Filter,
  GitCompare,
  HardDrive,
  Info,
  Layers,
  Loader2,
  MapPin,
  MemoryStick,
  Network,
  RefreshCw,
  Rows3,
  Search,
  ServerCog,
  Shield,
  ShieldX,
  Sparkles,
  Star,
  X,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BorderBeam,
  DotPattern,
  Meteors,
  NumberTicker,
} from "@/components/ui/effects";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useMultiRegionState } from "../../store/store-context";
import { useTenantChange } from "../../hooks/use-tenant-change";
import { getArmTokenForAccount } from "../../auth/msal-auth";
import { resolveActiveTenantId } from "../../auth/perform-tenant-switch";
import {
  cachePeek,
  ensureDiskHydrated,
  ComputeVmSku,
  isGpuSkuName,
  listAllVmSkus,
  listBatchSupportedVmSkus,
  subscribeQuotaCache,
  vmSkusCacheKey,
} from "../../services/quota-service";

import {
  classifyGpu,
  distinctGpuTypes,
  GpuType,
} from "./gpu-classifier";

// ---------------------------------------------------------------------------
// GPU-tier color theming
// ---------------------------------------------------------------------------

/**
 * Map a GPU type to a visual tier. The tier determines the chip color in
 * both the page chip filter and the per-row badge. Newest accelerators
 * (H100/H200/MI300X) get the strongest "primary" tone; A100-class get the
 * "accent" tone; older GPUs degrade gracefully to muted/secondary tones so
 * the operator's eye lands on the modern hardware first.
 */
type GpuTier = "primary" | "accent" | "info" | "warning" | "muted";

const GPU_TIER: Record<GpuType, GpuTier> = {
  H100: "primary",
  H200: "primary",
  MI300X: "primary",
  A100: "accent",
  A10: "accent",
  V100: "info",
  P100: "info",
  T4: "warning",
  P40: "warning",
  M60: "muted",
  K80: "muted",
  V620: "muted",
  "Other GPU": "muted",
};

/**
 * Tailwind class fragments per tier — `solid` is used for the active chip
 * state and the row badge; `soft` is the resting background; `text` is the
 * label color when not active. Kept literal so Tailwind's static analyzer
 * keeps every variant.
 */
const TIER_CLASSES: Record<
  GpuTier,
  { solidBg: string; solidText: string; ringActive: string; softBg: string; softText: string; badgeBg: string; badgeText: string }
> = {
  primary: {
    solidBg: "bg-primary/15",
    solidText: "text-primary",
    ringActive: "border-primary",
    softBg: "hover:bg-primary/5",
    softText: "text-muted-foreground",
    badgeBg: "bg-primary/15",
    badgeText: "text-primary",
  },
  accent: {
    solidBg: "bg-accent/40",
    solidText: "text-accent-foreground",
    ringActive: "border-accent",
    softBg: "hover:bg-accent/20",
    softText: "text-muted-foreground",
    badgeBg: "bg-accent/30",
    badgeText: "text-accent-foreground",
  },
  info: {
    solidBg: "bg-info/15",
    solidText: "text-info",
    ringActive: "border-info",
    softBg: "hover:bg-info/5",
    softText: "text-muted-foreground",
    badgeBg: "bg-info/15",
    badgeText: "text-info",
  },
  warning: {
    solidBg: "bg-warning/15",
    solidText: "text-warning",
    ringActive: "border-warning",
    softBg: "hover:bg-warning/5",
    softText: "text-muted-foreground",
    badgeBg: "bg-warning/15",
    badgeText: "text-warning",
  },
  muted: {
    solidBg: "bg-muted/40",
    solidText: "text-foreground",
    ringActive: "border-foreground/40",
    softBg: "hover:bg-muted/40",
    softText: "text-muted-foreground",
    badgeBg: "bg-muted/40",
    badgeText: "text-muted-foreground",
  },
};

// ---------------------------------------------------------------------------
// Workload categories — coarse buckets matching Azure's marketing taxonomy.
// These power the "quick filter" chips at the top of the toolbar so users
// can jump straight to the family they care about without typing a regex.
// ---------------------------------------------------------------------------

type WorkloadCategory =
  | "gpu"
  | "hpc"
  | "compute"
  | "memory"
  | "storage"
  | "burstable"
  | "general";

interface CategoryMeta {
  id: WorkloadCategory;
  label: string;
  help: string;
  icon: React.ReactNode;
  /** Returns true if the SKU belongs to this category. */
  test: (name: string) => boolean;
}

/**
 * Order matters — the first matching category wins for `primaryCategory`.
 * GPU first so an N-family VM doesn't get mis-tagged as compute, then HPC
 * (HB/HC/HX families which are also CPU-only but require InfiniBand).
 */
const CATEGORIES: readonly CategoryMeta[] = [
  {
    id: "gpu",
    label: "GPU",
    help: "ND/NC/NV/NG families — NVIDIA + AMD accelerators for training, inference, rendering.",
    icon: <Sparkles className="h-3 w-3" />,
    test: (n) => /^Standard_(ND|NC|NV|NG)/i.test(n),
  },
  {
    id: "hpc",
    label: "HPC",
    help: "HB/HC/HX families — InfiniBand-enabled CPU SKUs for tightly-coupled MPI workloads.",
    icon: <Network className="h-3 w-3" />,
    test: (n) => /^Standard_(HB|HC|HX)/i.test(n),
  },
  {
    id: "compute",
    label: "Compute",
    help: "F-family — CPU-optimised, high core-to-memory ratio. Good for batch processing, web servers.",
    icon: <Cpu className="h-3 w-3" />,
    test: (n) => /^Standard_F/i.test(n),
  },
  {
    id: "memory",
    label: "Memory",
    help: "E/M-family — high RAM-per-vCPU. Good for in-memory analytics, large databases.",
    icon: <MemoryStick className="h-3 w-3" />,
    test: (n) => /^Standard_(E|M|GS)/i.test(n),
  },
  {
    id: "storage",
    label: "Storage",
    help: "L-family — local NVMe SSDs for data-intensive workloads (Cassandra, MongoDB, Elastic).",
    icon: <HardDrive className="h-3 w-3" />,
    test: (n) => /^Standard_L/i.test(n),
  },
  {
    id: "burstable",
    label: "Burstable",
    help: "B-family — cost-saving SKUs with baseline CPU + bursting credit. Dev/test, low-traffic.",
    icon: <Zap className="h-3 w-3" />,
    test: (n) => /^Standard_B/i.test(n),
  },
  {
    id: "general",
    label: "General",
    help: "A/D/Dv-family — balanced CPU/memory for most general-purpose workloads.",
    icon: <ServerCog className="h-3 w-3" />,
    test: (n) => /^Standard_(A|D)/i.test(n),
  },
];

function primaryCategory(name: string): WorkloadCategory | null {
  for (const c of CATEGORIES) {
    if (c.test(name)) return c.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Capability helpers — extract booleans from the loose string-typed
// capabilities map. Azure publishes these as "True"/"False" strings, but
// some legacy SKUs omit the field entirely; default to unknown (null).
// ---------------------------------------------------------------------------

function getCapBool(sku: ComputeVmSku, name: string): boolean | null {
  const v = sku.capabilities[name];
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}

function getCapString(sku: ComputeVmSku, name: string): string | null {
  const v = sku.capabilities[name];
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}

// ---------------------------------------------------------------------------
// Local-storage key for pinned SKUs. Scoped per-subscription so a user
// switching between subs doesn't see stale pins from the previous one.
// ---------------------------------------------------------------------------

const PINNED_STORAGE_KEY = "azurebatchmanager.vmcatalog.pinned";

function loadPinned(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function savePinned(pinned: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PINNED_STORAGE_KEY,
      JSON.stringify(Array.from(pinned)),
    );
  } catch {
    /* localStorage full or blocked — non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the initial Compute SKU walk. The result is cached
 * for 15 min so this only matters on the very first load. Generous
 * because the GPU-only filter still needs to walk every page server-
 * side to find the GPU rows — that walk is bounded by ARM, not by us.
 */
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Max SKUs that can be in the compare drawer at once. */
const COMPARE_MAX = 4;

// Stable predicate (top-level so Function#toString is identical across
// mounts → quota-service caches it under one key).
const GPU_ONLY_FILTER = (sku: ComputeVmSku): boolean => isGpuSkuName(sku.name);

// ---------------------------------------------------------------------------
// Hook: progressive catalog loader
// ---------------------------------------------------------------------------

interface CatalogState {
  loading: boolean;
  partial: boolean;
  error: string | null;
  allVms: ComputeVmSku[];
  batchSupported: Set<string>;
  fetchedAt: string | null;
  /** True if the cached data set is GPU-only; false if it includes CPUs. */
  scope: "gpu" | "all";
}

const EMPTY: CatalogState = {
  loading: false,
  partial: false,
  error: null,
  allVms: [],
  batchSupported: new Set(),
  fetchedAt: null,
  scope: "gpu",
};

function useVmCatalog(
  subscriptionId: string | undefined,
  tenantId: string | undefined,
  regionsToProbe: string[],
  refreshKey: number,
  includeCpu: boolean,
): { state: CatalogState; cancel: () => void } {
  const [state, setState] = React.useState<CatalogState>(EMPTY);
  const abortRef = React.useRef<AbortController | null>(null);

  const cancel = React.useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setState((s) => ({ ...s, loading: false }));
  }, []);

  // ---- Hydrate from disk-backed cache on mount / sub change -------------
  // The quota-service cache is hydrated lazily; calling cachePeek() here
  // reads the persisted entry (if any) and renders rows immediately,
  // before any network call. The user no longer waits on the catalog —
  // they see whatever was cached up to 7 days ago, with a "refreshing"
  // indicator if a background load is in flight.
  React.useEffect(() => {
    if (!subscriptionId) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    // Synchronous first paint from localStorage if it's already
    // hot — avoids waiting on the disk pull for the common case
    // where the page was visited recently.
    const peek = cachePeek<ComputeVmSku[]>(
      vmSkusCacheKey(subscriptionId, !includeCpu),
    );
    if (peek) {
      setState({
        loading: false,
        partial: true,
        error: null,
        allVms: peek.value,
        batchSupported: new Set(),
        fetchedAt: new Date(peek.fetchedAt).toISOString(),
        scope: includeCpu ? "all" : "gpu",
      });
    }

    // Async layer: pull the dev-server disk snapshot into the
    // in-memory cache. Cold-start fast-path — first reload after a
    // long absence (or after browser quota eviction) gets the full
    // catalog in one localhost round-trip instead of N×ARM calls.
    // The subscribeQuotaCache listener below picks up the new
    // entries via notify("*") and re-renders.
    void ensureDiskHydrated().then(() => {
      if (cancelled) return;
      const next = cachePeek<ComputeVmSku[]>(
        vmSkusCacheKey(subscriptionId, !includeCpu),
      );
      if (next) {
        setState((s) => ({
          ...s,
          loading: false,
          partial: true,
          allVms: next.value,
          fetchedAt: new Date(next.fetchedAt).toISOString(),
          scope: includeCpu ? "all" : "gpu",
        }));
      }
    });

    // Subscribe to cache notifications so a background prefetch (kicked
    // off elsewhere) refreshes the page automatically.
    const unsub = subscribeQuotaCache((key) => {
      if (
        key !== "*" &&
        key !== vmSkusCacheKey(subscriptionId, !includeCpu)
      ) {
        return;
      }
      const next = cachePeek<ComputeVmSku[]>(
        vmSkusCacheKey(subscriptionId, !includeCpu),
      );
      if (next) {
        setState((s) => ({
          ...s,
          allVms: next.value,
          partial: true,
          fetchedAt: new Date(next.fetchedAt).toISOString(),
        }));
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [subscriptionId, includeCpu]);

  // ---- Background load (only when cache is missing or user hits Refresh) -
  React.useEffect(() => {
    if (!subscriptionId) return;
    let cancelled = false;

    // Defer the cache-vs-network decision until the disk hydration
    // has had a chance to land. Otherwise a cold reload races the
    // (in-flight) disk pull and fires a redundant ARM scan even
    // though a fresh snapshot is moments away on disk.
    void ensureDiskHydrated().then(() => {
      if (cancelled) return;
      const cached = cachePeek<ComputeVmSku[]>(
        vmSkusCacheKey(subscriptionId, !includeCpu),
      );
      if (cached && refreshKey === 0) {
        // Still kick off the per-region Batch probes — those have a shorter
        // TTL and are useful even when the Compute catalog is fresh.
        void runBatchProbes(subscriptionId, tenantId, regionsToProbe, setState);
        return;
      }
      startNetworkLoad(cached);
    });

    function startNetworkLoad(cached: { value: ComputeVmSku[] } | null) {
      if (cancelled) return;

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setState((s) => ({
        ...s,
        loading: true,
        // Keep allVms populated from cache while we refresh — the user
        // sees the old data with a "refreshing…" badge instead of a blank.
        partial: cached ? true : false,
        error: null,
        scope: includeCpu ? "all" : "gpu",
      }));

      const timeoutId = window.setTimeout(() => {
        if (!ctrl.signal.aborted) ctrl.abort("timeout");
      }, LOAD_TIMEOUT_MS);

      (async () => {
        try {
          const accounts = await import("../../auth/msal-auth").then((m) =>
            m.getAllLoggedInAccounts(),
          );
          if (accounts.length === 0) {
            throw new Error(
              "Sign in with Azure first — the catalog needs an ARM token.",
            );
          }
          const account =
            accounts.find(
              (a) =>
                resolveActiveTenantId(a) === tenantId ||
                a.tenantId === tenantId,
            ) ?? accounts[0];
          const token = await getArmTokenForAccount(
            account.homeAccountId,
            tenantId,
          );

          await listAllVmSkus(subscriptionId, token, {
            signal: ctrl.signal,
            filter: includeCpu ? undefined : GPU_ONLY_FILTER,
            onPartial: (skus, hasMore) => {
              if (ctrl.signal.aborted) return;
              setState((s) => ({
                ...s,
                allVms: skus,
                partial: true,
                loading: hasMore,
                fetchedAt: new Date().toISOString(),
              }));
            },
          });

          await runBatchProbes(
            subscriptionId,
            tenantId,
            regionsToProbe,
            setState,
          );

          setState((s) => ({ ...s, loading: false }));
        } catch (e) {
          if (ctrl.signal.aborted) {
            setState((s) => ({
              ...s,
              loading: false,
              error:
                s.allVms.length > 0
                  ? null
                  : "Catalog load was cancelled or timed out. Hit Refresh to try again.",
            }));
            return;
          }
          setState((s) => ({
            ...s,
            loading: false,
            error: (e as Error)?.message ?? String(e),
          }));
        } finally {
          window.clearTimeout(timeoutId);
        }
      })();
    }

    return () => {
      cancelled = true;
      if (abortRef.current) abortRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId, tenantId, refreshKey, regionsToProbe.join(","), includeCpu]);

  return { state, cancel };
}

/**
 * Per-region Batch SKU probes — extracted so we can run them either as
 * part of a fresh Compute load or independently when the Compute cache
 * is already warm. Each probe is an independent ARM call gated by the
 * request-governance layer; their failures are non-fatal.
 */
async function runBatchProbes(
  subscriptionId: string,
  tenantId: string | undefined,
  regions: string[],
  setState: React.Dispatch<React.SetStateAction<CatalogState>>,
): Promise<void> {
  if (regions.length === 0) return;
  try {
    const accounts = await import("../../auth/msal-auth").then((m) =>
      m.getAllLoggedInAccounts(),
    );
    if (accounts.length === 0) return;
    const account =
      accounts.find(
        (a) =>
          resolveActiveTenantId(a) === tenantId || a.tenantId === tenantId,
      ) ?? accounts[0];
    const token = await getArmTokenForAccount(account.homeAccountId, tenantId);
    for (const region of regions) {
      listBatchSupportedVmSkus(subscriptionId, region, token)
        .then((skus) => {
          setState((s) => {
            const next = new Set(s.batchSupported);
            for (const sk of skus) {
              next.add(`${sk.name.toLowerCase()}::${region.toLowerCase()}`);
            }
            return { ...s, batchSupported: next };
          });
        })
        .catch(() => {
          /* non-fatal */
        });
    }
  } catch {
    /* token acquisition failure — UI stays on cached data */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCapNumber(sku: ComputeVmSku, name: string): number | null {
  const v = sku.capabilities[name];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface VmRow {
  sku: ComputeVmSku;
  vCPUs: number | null;
  memoryGB: number | null;
  hasGpu: boolean;
  gpuCount: number | null;
  gpuType: GpuType | null;
  blockedRegions: Set<string>;
  availableRegions: string[];
  family: string;
  category: WorkloadCategory | null;
  /** True if the SKU has the PremiumIO capability set. */
  premiumIO: boolean | null;
  /** True if the SKU exposes the RDMA / InfiniBand capability. */
  rdma: boolean | null;
  /** True if the SKU supports Accelerated Networking. */
  acceleratedNetworking: boolean | null;
  /** True if the SKU advertises Ultra SSD availability. */
  ultraSsd: boolean | null;
  /** Local SSD disk size in GB, when present. */
  maxResourceVolumeGB: number | null;
  /** CPU architecture string ("x64" / "Arm64"), when present. */
  cpuArchitecture: string | null;
}

function deriveRow(sku: ComputeVmSku): VmRow {
  const blocked = new Set<string>();
  for (const r of sku.restrictions ?? []) {
    if (r.type === "Location" && Array.isArray(r.values)) {
      for (const v of r.values) blocked.add(v.toLowerCase());
    }
  }
  const availableRegions = sku.locations
    .map((l) => l.toLowerCase())
    .filter((l) => !blocked.has(l))
    .sort();
  const vCPUs = getCapNumber(sku, "vCPUs");
  const memoryGB = getCapNumber(sku, "MemoryGB");
  const gpu = classifyGpu(sku);
  const maxVolumeMB = getCapNumber(sku, "MaxResourceVolumeMB");
  return {
    sku,
    vCPUs,
    memoryGB,
    hasGpu: gpu.hasGpu,
    gpuCount: gpu.gpuCount,
    gpuType: gpu.gpuType,
    blockedRegions: blocked,
    availableRegions,
    family: sku.family ?? sku.size ?? "—",
    category: primaryCategory(sku.name),
    premiumIO: getCapBool(sku, "PremiumIO"),
    rdma: getCapBool(sku, "RdmaEnabled"),
    acceleratedNetworking: getCapBool(sku, "AcceleratedNetworkingEnabled"),
    ultraSsd: getCapBool(sku, "UltraSSDAvailable"),
    maxResourceVolumeGB:
      maxVolumeMB !== null ? Math.round(maxVolumeMB / 1024) : null,
    cpuArchitecture: getCapString(sku, "CpuArchitectureType"),
  };
}

type SortKey = "name" | "gpus" | "vcpus" | "memory" | "regions";

interface Filters {
  search: string;
  gpuTypes: Set<string>;
  gpuCounts: Set<number>;
  regions: Set<string>;
  categories: Set<WorkloadCategory>;
  /** Empty = both; otherwise "x64" or "Arm64". */
  architectures: Set<string>;
  vcpuMin: string;
  vcpuMax: string;
  memMin: string;
  memMax: string;
  batchOnly: boolean;
  includeCpu: boolean;
  /** Hide SKUs with no available regions (i.e. blocked everywhere for sub). */
  hideUnavailable: boolean;
  sort: SortKey;
}

const DEFAULT_FILTERS: Filters = {
  search: "",
  gpuTypes: new Set(),
  gpuCounts: new Set(),
  regions: new Set(),
  categories: new Set(),
  architectures: new Set(),
  vcpuMin: "",
  vcpuMax: "",
  memMin: "",
  memMax: "",
  batchOnly: true,
  includeCpu: false,
  hideUnavailable: false,
  sort: "gpus",
};

function parseRange(min: string, max: string): { lo: number; hi: number } {
  const lo = min === "" ? -Infinity : Number(min);
  const hi = max === "" ? Infinity : Number(max);
  return {
    lo: Number.isFinite(lo) ? lo : -Infinity,
    hi: Number.isFinite(hi) ? hi : Infinity,
  };
}

// ---------------------------------------------------------------------------
// CSV / JSON export — derived from filteredRows so the exported file
// mirrors exactly what the user sees on screen.
// ---------------------------------------------------------------------------

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows: VmRow[]): string {
  const header = [
    "Name",
    "Family",
    "Category",
    "vCPUs",
    "MemoryGB",
    "GpuType",
    "GpuCount",
    "Architecture",
    "PremiumIO",
    "RDMA/InfiniBand",
    "AcceleratedNetworking",
    "UltraSSD",
    "LocalDiskGB",
    "AvailableRegions",
    "BlockedRegions",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.sku.name,
        r.family,
        r.category ?? "",
        r.vCPUs ?? "",
        r.memoryGB ?? "",
        r.gpuType ?? "",
        r.gpuCount ?? "",
        r.cpuArchitecture ?? "",
        r.premiumIO === null ? "" : r.premiumIO ? "true" : "false",
        r.rdma === null ? "" : r.rdma ? "true" : "false",
        r.acceleratedNetworking === null
          ? ""
          : r.acceleratedNetworking
            ? "true"
            : "false",
        r.ultraSsd === null ? "" : r.ultraSsd ? "true" : "false",
        r.maxResourceVolumeGB ?? "",
        r.availableRegions.join("|"),
        Array.from(r.blockedRegions).join("|"),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

function rowsToJson(rows: VmRow[]): string {
  const out = rows.map((r) => ({
    name: r.sku.name,
    family: r.family,
    category: r.category,
    vCPUs: r.vCPUs,
    memoryGB: r.memoryGB,
    gpuType: r.gpuType,
    gpuCount: r.gpuCount,
    architecture: r.cpuArchitecture,
    capabilities: r.sku.capabilities,
    availableRegions: r.availableRegions,
    blockedRegions: Array.from(r.blockedRegions),
  }));
  return JSON.stringify(out, null, 2);
}

function downloadBlob(filename: string, mime: string, body: string): void {
  if (typeof window === "undefined") return;
  try {
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch {
    /* download blocked — non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Chip components
// ---------------------------------------------------------------------------

interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  size?: "xs" | "sm";
  /** Optional tier — when set, active state uses the tier color instead of primary. */
  tier?: GpuTier;
  /** Optional tooltip content shown on hover. */
  title?: string;
}

const Chip: React.FC<ChipProps> = ({
  active,
  onClick,
  children,
  size = "sm",
  tier,
  title,
}) => {
  const t = tier ? TIER_CLASSES[tier] : null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "rounded-full border font-medium transition-all duration-fast",
        // Subtle elevation lift on hover — feels tactile without being noisy.
        "hover:-translate-y-px hover:shadow-elev-1 active:translate-y-0",
        // Focus ring uses the project token so keyboard nav is always visible.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        size === "xs" ? "px-2 py-0.5 text-2xs" : "px-2.5 py-1 text-xs",
        active
          ? t
            ? cn(t.ringActive, t.solidBg, t.solidText)
            : "border-primary bg-primary/15 text-primary"
          : t
            ? cn("border-border bg-card", t.softText, t.softBg)
            : "border-border bg-card text-muted-foreground hover:bg-muted/40",
      )}
    >
      {children}
    </button>
  );
};

/**
 * Tiny capability badge with built-in tooltip. Used to communicate the
 * supplementary booleans (PremiumIO, InfiniBand, etc.) at-a-glance on
 * each row, without the user needing to expand the row to see them.
 *
 * Tone: "good" = green, "info" = blue, "warn" = amber. Unknown state
 * (boolean is null) renders as a muted dash so the column doesn't lie.
 */
const CapBadge: React.FC<{
  label: string;
  state: boolean | null;
  tone?: "good" | "info" | "warn";
  icon?: React.ReactNode;
  tooltip: string;
}> = ({ label, state, tone = "info", icon, tooltip }) => {
  if (state === null) return null;
  const toneCls =
    !state
      ? "bg-muted/30 text-muted-foreground ring-border"
      : tone === "good"
        ? "bg-success/10 text-success ring-success/30"
        : tone === "warn"
          ? "bg-warning/10 text-warning ring-warning/30"
          : "bg-info/10 text-info ring-info/30";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-2xs font-medium ring-1 transition-colors",
            toneCls,
          )}
        >
          {icon}
          {label}
          {!state && <span className="ml-0.5 opacity-50">·off</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" className="max-w-xs">
        <div className="font-medium">{label}</div>
        <div className="mt-0.5 text-2xs opacity-80">{tooltip}</div>
        <div className="mt-0.5 text-2xs">
          State: <span className="font-mono">{state ? "true" : "false"}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

// ---------------------------------------------------------------------------
// Row card
// ---------------------------------------------------------------------------

interface VmRowProps {
  row: VmRow;
  batchSupportedAnyRegion: boolean;
  batchSupportedByRegion: Map<string, boolean>;
  onUseVm: (vmName: string) => void;
  /** Display density toggle — "tight" hides secondary metadata. */
  density?: "comfortable" | "tight";
  pinned: boolean;
  onTogglePin: () => void;
  inCompare: boolean;
  compareDisabled: boolean;
  onToggleCompare: () => void;
  onCopyName: () => void;
}

const VmRowCard: React.FC<VmRowProps> = ({
  row,
  batchSupportedAnyRegion,
  batchSupportedByRegion,
  onUseVm,
  density = "comfortable",
  pinned,
  onTogglePin,
  inCompare,
  compareDisabled,
  onToggleCompare,
  onCopyName,
}) => {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const { sku } = row;
  const tier = row.gpuType ? GPU_TIER[row.gpuType] : "muted";
  const tierClasses = TIER_CLASSES[tier];

  const copy = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCopyName();
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    },
    [onCopyName],
  );

  return (
    <div
      className={cn(
        "group overflow-hidden rounded-lg border bg-card transition-all duration-base",
        pinned
          ? "border-primary/50 ring-1 ring-primary/20"
          : "border-border hover:border-foreground/20",
        "hover:shadow-elev-1",
        inCompare && "ring-2 ring-accent/50",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          // Subtle gradient on header — left edge tinted by GPU tier so
          // the catalog reads as a stack of color-coded cards. On non-GPU
          // SKUs the gradient collapses to neutral muted.
          "flex w-full items-start gap-3 p-3 text-left transition-colors duration-fast",
          row.hasGpu &&
            tier === "primary" &&
            "bg-gradient-to-r from-primary/[0.06] via-transparent to-transparent",
          row.hasGpu &&
            tier === "accent" &&
            "bg-gradient-to-r from-accent/[0.15] via-transparent to-transparent",
          row.hasGpu &&
            tier === "info" &&
            "bg-gradient-to-r from-info/[0.06] via-transparent to-transparent",
          row.hasGpu &&
            tier === "warning" &&
            "bg-gradient-to-r from-warning/[0.05] via-transparent to-transparent",
        )}
        aria-expanded={open}
      >
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 transition-transform duration-fast",
            "group-hover:scale-105",
            row.hasGpu
              ? cn(
                  tierClasses.badgeBg,
                  // Tier-matched ring color so the avatar reads at-a-glance.
                  tier === "primary" && "ring-primary/30",
                  tier === "accent" && "ring-accent/40",
                  tier === "info" && "ring-info/30",
                  tier === "warning" && "ring-warning/30",
                  tier === "muted" && "ring-border",
                )
              : "bg-muted/40 ring-border",
          )}
        >
          {row.hasGpu ? (
            <Cpu className={cn("h-4 w-4", tierClasses.badgeText)} />
          ) : (
            <ServerCog className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm font-medium">
              {sku.name}
            </span>
            <span className="text-2xs text-muted-foreground">· {row.family}</span>
            {row.gpuType && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold ring-1",
                      tierClasses.badgeBg,
                      tierClasses.badgeText,
                      tier === "primary" && "ring-primary/30",
                      tier === "accent" && "ring-accent/40",
                      tier === "info" && "ring-info/30",
                      tier === "warning" && "ring-warning/30",
                      tier === "muted" && "ring-border",
                    )}
                  >
                    {tier === "primary" && <Sparkles className="h-2.5 w-2.5" />}
                    {row.gpuType}
                    {row.gpuCount && row.gpuCount > 0 && (
                      <span className="opacity-70">×{row.gpuCount}</span>
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <div className="font-medium">
                    {row.gpuType}
                    {row.gpuCount ? ` × ${row.gpuCount}` : ""}
                  </div>
                  <div className="mt-0.5 text-2xs opacity-80">
                    GPU accelerator inferred from the SKU name. Count is
                    reported by Microsoft.Compute capabilities.
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
            {batchSupportedAnyRegion ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-2xs font-semibold text-success ring-1 ring-success/30">
                    <Shield className="h-3 w-3" />
                    Batch
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Azure Batch supports this SKU in at least one of the regions
                  you've probed.
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-2xs font-medium text-muted-foreground ring-1 ring-border">
                    <ShieldX className="h-3 w-3" />
                    Not Batch
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  Either no Batch-account regions are selected, or Batch
                  doesn't support this SKU in any probed region. Add a region
                  chip below to widen the probe.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {density === "comfortable" && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              {row.vCPUs !== null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1">
                      <Cpu className="h-3 w-3" />
                      {row.vCPUs} vCPU
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <span className="font-medium">Virtual CPUs</span>
                    <div className="mt-0.5 text-2xs opacity-80">
                      Logical processor count per VM. For HT-enabled SKUs,
                      physical-core count is roughly vCPUs ÷ 2.
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              {row.memoryGB !== null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1">
                      <MemoryStick className="h-3 w-3" />
                      {row.memoryGB} GB
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <span className="font-medium">Memory (RAM)</span>
                    <div className="mt-0.5 text-2xs opacity-80">
                      Total per-VM RAM in GiB.
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              {row.cpuArchitecture && (
                <span className="rounded-sm bg-muted/40 px-1.5 py-px font-mono text-2xs text-foreground/80">
                  {row.cpuArchitecture}
                </span>
              )}
              <span>· {row.availableRegions.length} regions</span>
              {row.blockedRegions.size > 0 && (
                <span className="text-warning">
                  · {row.blockedRegions.size} blocked
                </span>
              )}
              {/* Capability mini-badges */}
              <span className="ml-1 inline-flex flex-wrap items-center gap-1">
                <CapBadge
                  label="PremiumIO"
                  state={row.premiumIO}
                  tone="good"
                  tooltip="Supports Premium Storage (SSD-backed disks with consistent low-latency I/O)."
                />
                <CapBadge
                  label="InfiniBand"
                  state={row.rdma}
                  tone="info"
                  icon={<Network className="h-2.5 w-2.5" />}
                  tooltip="RDMA over InfiniBand for low-latency MPI / multi-node training. Required for tightly-coupled HPC workloads."
                />
                <CapBadge
                  label="AccelNet"
                  state={row.acceleratedNetworking}
                  tone="info"
                  tooltip="SR-IOV-based accelerated networking — bypasses the host vSwitch for lower latency and higher PPS."
                />
                <CapBadge
                  label="UltraSSD"
                  state={row.ultraSsd}
                  tone="info"
                  tooltip="Supports Azure Ultra Disks — sub-ms latency, up to 160K IOPS per disk."
                />
              </span>
            </div>
          )}
        </div>
        <div
          className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Pin toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
                className={cn(
                  "rounded p-1 transition-colors",
                  pinned
                    ? "text-primary hover:bg-primary/10"
                    : "text-muted-foreground/60 hover:bg-muted/40 hover:text-foreground",
                )}
                aria-pressed={pinned}
                aria-label={pinned ? "Unpin SKU" : "Pin SKU"}
              >
                <Star
                  className={cn(
                    "h-3.5 w-3.5",
                    pinned && "fill-current",
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {pinned
                ? "Unpin — removes from your favourites."
                : "Pin — float to top, persists across sessions."}
            </TooltipContent>
          </Tooltip>
          {/* Copy SKU name */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={copy}
                className={cn(
                  "rounded p-1 transition-colors",
                  copied
                    ? "text-success"
                    : "text-muted-foreground/60 hover:bg-muted/40 hover:text-foreground",
                )}
                aria-label="Copy SKU name to clipboard"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {copied ? "Copied!" : `Copy "${sku.name}"`}
            </TooltipContent>
          </Tooltip>
          {/* Compare toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (compareDisabled && !inCompare) return;
                  onToggleCompare();
                }}
                className={cn(
                  "rounded p-1 transition-colors",
                  inCompare
                    ? "text-accent-foreground bg-accent/40"
                    : compareDisabled
                      ? "cursor-not-allowed text-muted-foreground/30"
                      : "text-muted-foreground/60 hover:bg-muted/40 hover:text-foreground",
                )}
                aria-pressed={inCompare}
                aria-label={
                  inCompare ? "Remove from comparison" : "Add to comparison"
                }
                disabled={compareDisabled && !inCompare}
              >
                <GitCompare className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {inCompare
                ? "Remove from comparison"
                : compareDisabled
                  ? `Compare list full (max ${COMPARE_MAX})`
                  : "Add to side-by-side comparison"}
            </TooltipContent>
          </Tooltip>
          <span className="ml-1 select-none">
            {open ? "Hide" : "Details"}
          </span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-base",
              open && "rotate-180",
            )}
          />
        </div>
      </button>

      {open && (
        <div className="animate-slide-in-bottom border-t border-border bg-surface-base/40 p-3 text-xs">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Capabilities
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3 w-3 cursor-help opacity-70" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    Raw key/value capabilities published by
                    Microsoft.Compute/skus. First 14 shown.
                  </TooltipContent>
                </Tooltip>
              </div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-2xs text-muted-foreground">
                {Object.entries(sku.capabilities)
                  .slice(0, 14)
                  .map(([k, v]) => (
                    <li key={k} className="truncate">
                      <span className="text-foreground">{k}:</span> {v}
                    </li>
                  ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Available regions
              </div>
              <div className="flex flex-wrap gap-1">
                {row.availableRegions.map((r) => {
                  const probed = batchSupportedByRegion.has(r);
                  const supported = probed && batchSupportedByRegion.get(r);
                  return (
                    <span
                      key={r}
                      className={cn(
                        "rounded px-1.5 py-0.5 font-mono text-2xs",
                        supported && "bg-success/10 text-success",
                        probed && !supported && "bg-warning/10 text-warning",
                        !probed && "bg-muted/40 text-muted-foreground",
                      )}
                      title={
                        probed
                          ? supported
                            ? "Batch supports this VM here"
                            : "Available, but Batch doesn't support this VM here"
                          : "Region not probed (add a Batch account here to check)"
                      }
                    >
                      {r}
                    </span>
                  );
                })}
                {row.blockedRegions.size > 0 && (
                  <>
                    <span className="ml-2 text-2xs text-muted-foreground">
                      Blocked:
                    </span>
                    {Array.from(row.blockedRegions).map((r) => (
                      <span
                        key={r}
                        className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-2xs text-destructive"
                      >
                        {r}
                      </span>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <a
              href={`https://learn.microsoft.com/azure/virtual-machines/sizes?WT.mc_id=batchmanager#${encodeURIComponent(
                row.family.toLowerCase(),
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3 w-3" />
              Azure docs · {row.family}
            </a>
            <Button
              type="button"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                onUseVm(sku.name);
              }}
              className="gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              Use this VM in pool creation
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const VmCatalogPage: React.FC = () => {
  const state = useMultiRegionState();
  const navigate = useNavigate();
  const subs = state.subscriptions ?? [];
  const accounts = state.accounts ?? [];

  const [selectedSubId, setSelectedSubId] = React.useState<string>(
    () => subs[0]?.subscriptionId ?? "",
  );
  React.useEffect(() => {
    if (!selectedSubId && subs.length > 0) {
      setSelectedSubId(subs[0].subscriptionId);
    }
  }, [subs, selectedSubId]);

  const selectedSub = React.useMemo(
    () => subs.find((s) => s.subscriptionId === selectedSubId),
    [subs, selectedSubId],
  );

  const [filters, setFilters] = React.useState<Filters>(DEFAULT_FILTERS);
  const [refreshKey, setRefreshKey] = React.useState(0);
  /**
   * Display density. "comfortable" shows full row metadata; "tight" hides
   * the secondary line so 2x more rows fit on screen — useful when the
   * operator is scanning a long catalog. Lives in component state, not
   * filters, because it doesn't affect what data is shown.
   */
  const [density, setDensity] = React.useState<"comfortable" | "tight">("comfortable");

  // Pinned SKUs — persisted across reloads in localStorage. Pinned rows
  // float to the top of the list and are never hidden by row-cap pagination.
  const [pinned, setPinned] = React.useState<Set<string>>(() => loadPinned());
  const togglePin = React.useCallback((skuName: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(skuName)) next.delete(skuName);
      else next.add(skuName);
      savePinned(next);
      return next;
    });
  }, []);

  // SKUs currently in the compare drawer. Capped at COMPARE_MAX so the
  // side-by-side table stays readable on a normal-width screen.
  const [compareSet, setCompareSet] = React.useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = React.useState(false);
  const [compareDiffOnly, setCompareDiffOnly] = React.useState(false);
  const toggleCompare = React.useCallback((skuName: string) => {
    setCompareSet((prev) => {
      const next = new Set(prev);
      if (next.has(skuName)) next.delete(skuName);
      else if (next.size < COMPARE_MAX) next.add(skuName);
      return next;
    });
  }, []);
  const clearCompare = React.useCallback(() => setCompareSet(new Set()), []);

  // Copy-feedback toast — small inline confirmation when the user uses
  // the row-level copy button. Floats up from the bottom-right.
  const [copyToast, setCopyToast] = React.useState<string | null>(null);
  const copyToName = React.useCallback((name: string) => {
    try {
      void navigator.clipboard?.writeText(name);
    } catch {
      /* clipboard blocked — non-fatal */
    }
    setCopyToast(name);
    setTimeout(() => setCopyToast(null), 1800);
  }, []);

  // Search keyboard shortcut: `/` to focus, Esc to clear (while focused).
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack when the user is typing in any input/textarea or
      // when a modifier key is pressed.
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target?.isContentEditable ?? false);
      if (e.key === "/" && !inEditable && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Account regions for this sub — the "Your accounts" shortcut populates from this.
  const accountRegions = React.useMemo(() => {
    const set = new Set<string>();
    for (const a of accounts) {
      if (a.subscriptionId === selectedSubId && a.region) {
        set.add(a.region.toLowerCase());
      }
    }
    return Array.from(set).sort();
  }, [accounts, selectedSubId]);

  // Regions to probe = filter selection ∪ account regions. If neither
  // exists we still probe nothing — the loader skips the loop and the
  // "Batch-supported" badge stays grey until the user adds a region.
  const regionsToProbe = React.useMemo(() => {
    const set = new Set<string>(accountRegions);
    for (const r of filters.regions) set.add(r.toLowerCase());
    return Array.from(set);
  }, [accountRegions, filters.regions]);

  const { state: catalog, cancel } = useVmCatalog(
    selectedSubId || undefined,
    selectedSub?.tenantId,
    regionsToProbe,
    refreshKey,
    filters.includeCpu,
  );

  const rows = React.useMemo(
    () => catalog.allVms.map(deriveRow),
    [catalog.allVms],
  );

  const allRegions = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const region of r.availableRegions) set.add(region);
    return Array.from(set).sort();
  }, [rows]);

  const allArchitectures = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.cpuArchitecture) set.add(r.cpuArchitecture);
    }
    return Array.from(set).sort();
  }, [rows]);

  const gpuTypeOptions = React.useMemo(
    () => distinctGpuTypes(catalog.allVms),
    [catalog.allVms],
  );

  const gpuCountOptions = React.useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) {
      if (r.hasGpu && r.gpuCount && r.gpuCount > 0) set.add(r.gpuCount);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [rows]);

  const categoryOptions = React.useMemo(() => {
    // Only surface categories actually represented in the loaded data so
    // we don't show a "Storage" chip when no L-family SKU exists.
    const present = new Set<WorkloadCategory>();
    for (const r of rows) {
      if (r.category) present.add(r.category);
    }
    return CATEGORIES.filter((c) => present.has(c.id));
  }, [rows]);

  /**
   * Per-chip match counts — the user can see how many SKUs each chip
   * would surface BEFORE clicking it. Counts factor in every OTHER
   * active filter so toggling a single chip never lies about its
   * contribution. Computed from the same predicate used by filteredRows
   * minus the chip-class being counted.
   */
  const chipCounts = React.useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const vcpu = parseRange(filters.vcpuMin, filters.vcpuMax);
    const mem = parseRange(filters.memMin, filters.memMax);
    const matchesEverythingExceptChip = (
      row: VmRow,
      excludeKey:
        | "gpuTypes"
        | "gpuCounts"
        | "regions"
        | "categories"
        | "architectures",
    ): boolean => {
      if (excludeKey !== "categories" && filters.categories.size > 0) {
        if (!row.category || !filters.categories.has(row.category)) return false;
      }
      if (
        excludeKey !== "architectures" &&
        filters.architectures.size > 0
      ) {
        if (
          !row.cpuArchitecture ||
          !filters.architectures.has(row.cpuArchitecture)
        ) {
          return false;
        }
      }
      if (excludeKey !== "gpuTypes" && filters.gpuTypes.size > 0) {
        if (!row.gpuType || !filters.gpuTypes.has(row.gpuType)) return false;
      }
      if (excludeKey !== "gpuCounts" && filters.gpuCounts.size > 0) {
        if (
          row.gpuCount === null ||
          !filters.gpuCounts.has(row.gpuCount)
        ) {
          return false;
        }
      }
      if (excludeKey !== "regions" && filters.regions.size > 0) {
        let any = false;
        for (const want of filters.regions) {
          if (row.availableRegions.includes(want.toLowerCase())) {
            any = true;
            break;
          }
        }
        if (!any) return false;
      }
      if (row.vCPUs !== null) {
        if (row.vCPUs < vcpu.lo || row.vCPUs > vcpu.hi) return false;
      }
      if (row.memoryGB !== null) {
        if (row.memoryGB < mem.lo || row.memoryGB > mem.hi) return false;
      }
      if (filters.batchOnly && regionsToProbe.length > 0) {
        const anySupported = regionsToProbe.some((r) =>
          catalog.batchSupported.has(`${row.sku.name.toLowerCase()}::${r}`),
        );
        if (!anySupported) return false;
      }
      if (filters.hideUnavailable && row.availableRegions.length === 0) {
        return false;
      }
      if (q) {
        const hit =
          row.sku.name.toLowerCase().includes(q) ||
          row.family.toLowerCase().includes(q) ||
          (row.gpuType ?? "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    };
    const gpuType: Record<string, number> = {};
    const gpuCount: Record<number, number> = {};
    const region: Record<string, number> = {};
    const category: Record<string, number> = {};
    const architecture: Record<string, number> = {};
    for (const row of rows) {
      if (row.gpuType && matchesEverythingExceptChip(row, "gpuTypes")) {
        gpuType[row.gpuType] = (gpuType[row.gpuType] ?? 0) + 1;
      }
      if (
        row.gpuCount !== null &&
        row.gpuCount > 0 &&
        matchesEverythingExceptChip(row, "gpuCounts")
      ) {
        gpuCount[row.gpuCount] = (gpuCount[row.gpuCount] ?? 0) + 1;
      }
      if (matchesEverythingExceptChip(row, "regions")) {
        for (const r of row.availableRegions) {
          region[r] = (region[r] ?? 0) + 1;
        }
      }
      if (row.category && matchesEverythingExceptChip(row, "categories")) {
        category[row.category] = (category[row.category] ?? 0) + 1;
      }
      if (
        row.cpuArchitecture &&
        matchesEverythingExceptChip(row, "architectures")
      ) {
        architecture[row.cpuArchitecture] =
          (architecture[row.cpuArchitecture] ?? 0) + 1;
      }
    }
    return { gpuType, gpuCount, region, category, architecture };
  }, [
    rows,
    filters,
    regionsToProbe,
    catalog.batchSupported,
  ]);

  const filteredRows = React.useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const vcpu = parseRange(filters.vcpuMin, filters.vcpuMax);
    const mem = parseRange(filters.memMin, filters.memMax);
    return rows
      .filter((row) => {
        if (filters.categories.size > 0) {
          if (!row.category || !filters.categories.has(row.category)) return false;
        }
        if (filters.architectures.size > 0) {
          if (
            !row.cpuArchitecture ||
            !filters.architectures.has(row.cpuArchitecture)
          ) {
            return false;
          }
        }
        // GPU type chip filter (multi-select; empty = no constraint)
        if (filters.gpuTypes.size > 0) {
          if (!row.gpuType || !filters.gpuTypes.has(row.gpuType)) return false;
        }
        // GPU count chip filter (multi-select)
        if (filters.gpuCounts.size > 0) {
          if (
            row.gpuCount === null ||
            !filters.gpuCounts.has(row.gpuCount)
          ) {
            return false;
          }
        }
        // Region multi-select
        if (filters.regions.size > 0) {
          let any = false;
          for (const want of filters.regions) {
            if (row.availableRegions.includes(want.toLowerCase())) {
              any = true;
              break;
            }
          }
          if (!any) return false;
        }
        // vCPU & memory range
        if (row.vCPUs !== null) {
          if (row.vCPUs < vcpu.lo || row.vCPUs > vcpu.hi) return false;
        }
        if (row.memoryGB !== null) {
          if (row.memoryGB < mem.lo || row.memoryGB > mem.hi) return false;
        }
        // Hide SKUs with no available regions (e.g. blocked everywhere)
        if (filters.hideUnavailable && row.availableRegions.length === 0) {
          return false;
        }
        // Batch-supported
        if (filters.batchOnly) {
          if (regionsToProbe.length > 0) {
            const anySupported = regionsToProbe.some((r) =>
              catalog.batchSupported.has(`${row.sku.name.toLowerCase()}::${r}`),
            );
            if (!anySupported) return false;
          }
        }
        // Free text
        if (!q) return true;
        return (
          row.sku.name.toLowerCase().includes(q) ||
          row.family.toLowerCase().includes(q) ||
          (row.gpuType ?? "").toLowerCase().includes(q) ||
          Object.values(row.sku.capabilities).some((v) =>
            String(v).toLowerCase().includes(q),
          )
        );
      })
      .sort((a, b) => {
        // Pinned rows always sort first so favourites stay visible no
        // matter what sort key the user picked.
        const aPin = pinned.has(a.sku.name) ? 0 : 1;
        const bPin = pinned.has(b.sku.name) ? 0 : 1;
        if (aPin !== bPin) return aPin - bPin;
        switch (filters.sort) {
          case "gpus":
            return (b.gpuCount ?? 0) - (a.gpuCount ?? 0);
          case "vcpus":
            return (b.vCPUs ?? 0) - (a.vCPUs ?? 0);
          case "memory":
            return (b.memoryGB ?? 0) - (a.memoryGB ?? 0);
          case "regions":
            return b.availableRegions.length - a.availableRegions.length;
          case "name":
          default:
            return a.sku.name.localeCompare(b.sku.name);
        }
      });
  }, [rows, filters, regionsToProbe, catalog.batchSupported, pinned]);

  // Roll-up stats — shown in the header pill row so the user gets the
  // shape of the catalog at a glance (and "after filters" deltas).
  const stats = React.useMemo(() => {
    let totalGpu = 0;
    let batchSupportedCount = 0;
    let totalVcpus = 0;
    let vcpuRowCount = 0;
    let totalMemory = 0;
    let memRowCount = 0;
    const regionSet = new Set<string>();
    for (const r of filteredRows) {
      if (r.hasGpu) totalGpu++;
      if (r.vCPUs !== null) {
        totalVcpus += r.vCPUs;
        vcpuRowCount++;
      }
      if (r.memoryGB !== null) {
        totalMemory += r.memoryGB;
        memRowCount++;
      }
      for (const reg of r.availableRegions) regionSet.add(reg);
      if (regionsToProbe.length > 0) {
        const supported = regionsToProbe.some((reg) =>
          catalog.batchSupported.has(`${r.sku.name.toLowerCase()}::${reg}`),
        );
        if (supported) batchSupportedCount++;
      }
    }
    return {
      totalGpu,
      batchSupportedCount,
      avgVcpus: vcpuRowCount > 0 ? totalVcpus / vcpuRowCount : null,
      avgMemory: memRowCount > 0 ? totalMemory / memRowCount : null,
      regionCoverage: regionSet.size,
    };
  }, [filteredRows, regionsToProbe, catalog.batchSupported]);

  const onUseVm = React.useCallback(
    (vmName: string) => {
      try {
        void navigator.clipboard.writeText(vmName);
      } catch {
        /* clipboard blocked — non-fatal */
      }
      navigate(`/pools?vmSize=${encodeURIComponent(vmName)}`);
    },
    [navigate],
  );

  const setFilter = React.useCallback(
    <K extends keyof Filters>(key: K, value: Filters[K]) =>
      setFilters((f) => ({ ...f, [key]: value })),
    [],
  );

  const toggleSetItem = <T,>(set: Set<T>, item: T): Set<T> => {
    const next = new Set(set);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    return next;
  };

  const clearAll = React.useCallback(() => {
    setFilters((f) => ({
      ...DEFAULT_FILTERS,
      // Preserve hardware scope across clear — re-loading the entire
      // catalog because the user clicked "clear filters" would be rude.
      includeCpu: f.includeCpu,
      batchOnly: f.batchOnly,
    }));
  }, []);

  const filtersActive =
    filters.search !== "" ||
    filters.gpuTypes.size > 0 ||
    filters.gpuCounts.size > 0 ||
    filters.regions.size > 0 ||
    filters.categories.size > 0 ||
    filters.architectures.size > 0 ||
    filters.vcpuMin !== "" ||
    filters.vcpuMax !== "" ||
    filters.memMin !== "" ||
    filters.memMax !== "" ||
    filters.hideUnavailable ||
    filters.sort !== "gpus";

  const exportCsv = React.useCallback(() => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const subSlug = (selectedSub?.displayName ?? "subscription")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase();
    downloadBlob(
      `vm-catalog-${subSlug}-${ts}.csv`,
      "text/csv;charset=utf-8",
      rowsToCsv(filteredRows),
    );
  }, [filteredRows, selectedSub]);

  const exportJson = React.useCallback(() => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const subSlug = (selectedSub?.displayName ?? "subscription")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase();
    downloadBlob(
      `vm-catalog-${subSlug}-${ts}.json`,
      "application/json;charset=utf-8",
      rowsToJson(filteredRows),
    );
  }, [filteredRows, selectedSub]);

  // React to global tenant switches — the VM catalog is scoped to a
  // subscription (which belongs to a tenant), so when the active tenant
  // flips we reset the selected sub plus any tenant-scoped picker state
  // (region filter, compare drawer). The store will re-emit subs for the
  // new tenant; the existing effect at the top of the component will then
  // auto-pick subs[0] when selectedSubId becomes empty.
  useTenantChange(undefined, (detail) => {
    const newTenantId = detail.tenantId;
    // Only reset if the currently-selected sub no longer belongs to the
    // new tenant — switching to a tenant that owns the same sub is a
    // no-op for this page.
    if (selectedSub && selectedSub.tenantId === newTenantId) return;
    setSelectedSubId("");
    setFilters((f) => ({ ...f, regions: new Set() }));
    setCompareSet(new Set());
    setCompareOpen(false);
  });

  return (
    <div className="flex flex-col gap-5 py-2">
      <div className="relative overflow-hidden rounded-xl border bg-card/50 p-6">
        <DotPattern fade="top-left" className="absolute inset-0" />
        <Meteors count={12} tone="primary" className="absolute inset-0" />
        <header className="relative z-10 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-primary">
              <Layers className="h-3 w-3" />
              VM Catalog
            </div>
            <h1 className="mt-2 text-3xl font-semibold leading-tight tracking-tight text-foreground">
              Azure VM size browser
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Browse Azure VM SKUs your subscription can see, with live
              Batch-availability cross-check. Default scope: GPU only — toggle
              "Include CPU SKUs" to widen. Press{" "}
              <kbd className="rounded border border-border bg-muted/50 px-1 py-px font-mono text-2xs">
                /
              </kbd>{" "}
              to focus search.
            </p>
            {/* Summary stats — at-a-glance overview of the filtered catalog */}
            {rows.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 text-2xs">
                <SummaryPill
                  label="Showing"
                  value={filteredRows.length}
                  hint={`of ${rows.length} loaded SKUs`}
                  tone="primary"
                />
                <SummaryPill
                  label="GPU SKUs"
                  value={stats.totalGpu}
                  hint="rows with at least 1 GPU"
                  tone="accent"
                />
                {regionsToProbe.length > 0 && (
                  <SummaryPill
                    label="Batch-supported"
                    value={stats.batchSupportedCount}
                    hint={`across ${regionsToProbe.length} probed region${regionsToProbe.length === 1 ? "" : "s"}`}
                    tone="success"
                  />
                )}
                <SummaryPill
                  label="Regions"
                  value={stats.regionCoverage}
                  hint="distinct regions covered"
                  tone="info"
                />
                {stats.avgVcpus !== null && (
                  <SummaryPill
                    label="Avg vCPUs"
                    value={Math.round(stats.avgVcpus)}
                    hint="mean of filtered set"
                    tone="muted"
                  />
                )}
                {stats.avgMemory !== null && (
                  <SummaryPill
                    label="Avg memory"
                    value={`${Math.round(stats.avgMemory)} GB`}
                    hint="mean of filtered set"
                    tone="muted"
                  />
                )}
                {pinned.size > 0 && (
                  <SummaryPill
                    label="Pinned"
                    value={pinned.size}
                    hint="your favourites — persisted"
                    tone="warning"
                    icon={<Star className="h-2.5 w-2.5" />}
                  />
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Density toggle — pill segmented control */}
            <div
              className="inline-flex rounded-md border border-border bg-card p-0.5"
              role="group"
              aria-label="Display density"
            >
              <button
                type="button"
                onClick={() => setDensity("comfortable")}
                className={cn(
                  "rounded px-2 py-1 text-2xs font-medium transition-all duration-fast",
                  density === "comfortable"
                    ? "bg-primary/15 text-primary shadow-elev-1"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={density === "comfortable"}
              >
                <Rows3 className="inline h-3 w-3" />
                <span className="ml-1">Comfy</span>
              </button>
              <button
                type="button"
                onClick={() => setDensity("tight")}
                className={cn(
                  "rounded px-2 py-1 text-2xs font-medium transition-all duration-fast",
                  density === "tight"
                    ? "bg-primary/15 text-primary shadow-elev-1"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={density === "tight"}
              >
                Tight
              </button>
            </div>
            {catalog.loading && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={cancel}
                className="gap-1.5 transition-all duration-fast hover:shadow-elev-1"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRefreshKey((n) => n + 1)}
              className="gap-1.5 transition-all duration-fast hover:shadow-elev-1"
              disabled={catalog.loading}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", catalog.loading && "animate-spin")}
              />
              Refresh
            </Button>
          </div>
        </header>
      </div>

      {/* Toolbar — top row: subscription, search, hardware scope */}
      <div className="sticky top-0 z-20 -mx-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/95 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <select
          value={selectedSubId}
          onChange={(e) => setSelectedSubId(e.target.value)}
          className="h-8 max-w-xs flex-1 rounded-md border border-border bg-card px-2 text-xs"
          aria-label="Subscription"
        >
          {subs.length === 0 && (
            <option value="">No subscriptions — sign in first</option>
          )}
          {subs.map((s) => (
            <option key={s.subscriptionId} value={s.subscriptionId}>
              {s.displayName} · {s.subscriptionId.substring(0, 8)}…
            </option>
          ))}
        </select>

        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder="Search by name, family, capability… (press /)"
            value={filters.search}
            onChange={(e) => setFilter("search", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filters.search) {
                e.preventDefault();
                setFilter("search", "");
              }
            }}
            className="h-8 pl-7 pr-7 text-xs"
            aria-label="Search VMs"
          />
          {filters.search && (
            <button
              type="button"
              onClick={() => setFilter("search", "")}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              aria-label="Clear search"
              title="Clear (Esc)"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <select
          value={filters.sort}
          onChange={(e) => setFilter("sort", e.target.value as SortKey)}
          className="h-8 rounded-md border border-border bg-card px-2 text-xs"
          aria-label="Sort"
        >
          <option value="gpus">Sort: GPU count ↓</option>
          <option value="vcpus">Sort: vCPUs ↓</option>
          <option value="memory">Sort: memory ↓</option>
          <option value="regions">Sort: region coverage ↓</option>
          <option value="name">Sort: name A-Z</option>
        </select>

        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40">
          <input
            type="checkbox"
            checked={filters.includeCpu}
            onChange={(e) => setFilter("includeCpu", e.target.checked)}
            className="h-3 w-3"
          />
          Include CPU SKUs
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40">
          <input
            type="checkbox"
            checked={filters.batchOnly}
            onChange={(e) => setFilter("batchOnly", e.target.checked)}
            className="h-3 w-3"
          />
          Batch-supported only
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40">
          <input
            type="checkbox"
            checked={filters.hideUnavailable}
            onChange={(e) => setFilter("hideUnavailable", e.target.checked)}
            className="h-3 w-3"
          />
          Hide unavailable
        </label>

        {/* Export buttons — feed the filtered rows out as CSV / JSON for
            offline review or pasting into a sheet / planning doc. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={exportCsv}
              disabled={filteredRows.length === 0}
              className="gap-1.5"
            >
              <FileDown className="h-3.5 w-3.5" />
              CSV
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Export the {filteredRows.length} filtered row
            {filteredRows.length === 1 ? "" : "s"} to a spreadsheet-friendly
            CSV.
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={exportJson}
              disabled={filteredRows.length === 0}
              className="gap-1.5"
            >
              <FileJson className="h-3.5 w-3.5" />
              JSON
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Export the {filteredRows.length} filtered row
            {filteredRows.length === 1 ? "" : "s"} (including raw
            capabilities) as JSON.
          </TooltipContent>
        </Tooltip>

        {compareSet.size > 0 && (
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => setCompareOpen(true)}
            className="gap-1.5"
          >
            <GitCompare className="h-3.5 w-3.5" />
            Compare {compareSet.size}
          </Button>
        )}

        {filtersActive && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={clearAll}
            className="gap-1"
          >
            <X className="h-3 w-3" />
            Clear filters
          </Button>
        )}
      </div>

      {/* Toolbar — chip rows */}
      <div className="relative flex flex-col gap-2 overflow-hidden rounded-lg border border-border bg-surface-base/40 p-3">
        <BorderBeam size={200} duration={8} />

        {/* Quick category chips — the "I want a workload-shaped VM" shortcut */}
        {categoryOptions.length > 0 && (
          <ChipRow
            label="Workload"
            icon={<Filter className="h-3.5 w-3.5" />}
            empty="No workload categories detected yet."
          >
            {categoryOptions.map((cat) => {
              const count = chipCounts.category[cat.id] ?? 0;
              return (
                <Chip
                  key={cat.id}
                  active={filters.categories.has(cat.id)}
                  onClick={() =>
                    setFilter(
                      "categories",
                      toggleSetItem(filters.categories, cat.id),
                    )
                  }
                  title={cat.help}
                >
                  <span className="mr-1 inline-flex">{cat.icon}</span>
                  {cat.label}
                  <span className="ml-1 text-2xs opacity-70 tabular-nums">
                    {count}
                  </span>
                </Chip>
              );
            })}
          </ChipRow>
        )}

        <ChipRow
          label="GPU type"
          icon={<Cpu className="h-3.5 w-3.5" />}
          empty="No GPU types loaded yet — wait for the catalog to populate."
        >
          {gpuTypeOptions.map((t) => {
            const count = chipCounts.gpuType[t] ?? 0;
            return (
              <Chip
                key={t}
                tier={GPU_TIER[t]}
                active={filters.gpuTypes.has(t)}
                onClick={() =>
                  setFilter("gpuTypes", toggleSetItem(filters.gpuTypes, t))
                }
              >
                {GPU_TIER[t] === "primary" && (
                  <Sparkles className="mr-1 inline h-2.5 w-2.5" />
                )}
                {t}
                <span className="ml-1 text-2xs opacity-70 tabular-nums">
                  {count}
                </span>
              </Chip>
            );
          })}
        </ChipRow>

        <ChipRow
          label="GPU count"
          empty="No GPU SKUs in catalog yet."
        >
          {gpuCountOptions.map((n) => {
            const count = chipCounts.gpuCount[n] ?? 0;
            return (
              <Chip
                key={n}
                active={filters.gpuCounts.has(n)}
                onClick={() =>
                  setFilter("gpuCounts", toggleSetItem(filters.gpuCounts, n))
                }
              >
                {n}× GPU
                <span className="ml-1 text-2xs opacity-70 tabular-nums">
                  {count}
                </span>
              </Chip>
            );
          })}
        </ChipRow>

        {allArchitectures.length > 1 && (
          <ChipRow
            label="Architecture"
            icon={<Cpu className="h-3.5 w-3.5" />}
            empty="—"
          >
            {allArchitectures.map((arch) => {
              const count = chipCounts.architecture[arch] ?? 0;
              return (
                <Chip
                  key={arch}
                  active={filters.architectures.has(arch)}
                  onClick={() =>
                    setFilter(
                      "architectures",
                      toggleSetItem(filters.architectures, arch),
                    )
                  }
                >
                  {arch}
                  <span className="ml-1 text-2xs opacity-70 tabular-nums">
                    {count}
                  </span>
                </Chip>
              );
            })}
          </ChipRow>
        )}

        <ChipRow
          label="Region"
          icon={<MapPin className="h-3.5 w-3.5" />}
          empty="Regions appear as the catalog loads."
          extra={
            accountRegions.length > 0 && (
              <Chip
                size="xs"
                active={
                  accountRegions.every((r) => filters.regions.has(r)) &&
                  filters.regions.size === accountRegions.length
                }
                onClick={() =>
                  setFilter(
                    "regions",
                    filters.regions.size === accountRegions.length
                      ? new Set()
                      : new Set(accountRegions),
                  )
                }
              >
                Your accounts ({accountRegions.length})
              </Chip>
            )
          }
        >
          {allRegions.map((r) => {
            const count = chipCounts.region[r] ?? 0;
            return (
              <Chip
                key={r}
                size="xs"
                active={filters.regions.has(r)}
                onClick={() =>
                  setFilter("regions", toggleSetItem(filters.regions, r))
                }
              >
                {r}
                <span className="ml-1 text-2xs opacity-70 tabular-nums">
                  {count}
                </span>
              </Chip>
            );
          })}
        </ChipRow>

        {/* Range row — vCPUs and memory */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Cpu className="h-3 w-3" /> vCPUs
          </span>
          <RangeInput
            value={filters.vcpuMin}
            placeholder="min"
            onChange={(v) => setFilter("vcpuMin", v)}
          />
          <span className="text-2xs text-muted-foreground">–</span>
          <RangeInput
            value={filters.vcpuMax}
            placeholder="max"
            onChange={(v) => setFilter("vcpuMax", v)}
          />

          <span className="ml-2 inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <MemoryStick className="h-3 w-3" /> Memory (GB)
          </span>
          <RangeInput
            value={filters.memMin}
            placeholder="min"
            onChange={(v) => setFilter("memMin", v)}
          />
          <span className="text-2xs text-muted-foreground">–</span>
          <RangeInput
            value={filters.memMax}
            placeholder="max"
            onChange={(v) => setFilter("memMax", v)}
          />
        </div>
      </div>

      {catalog.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {catalog.error}
        </div>
      )}

      {catalog.loading && !catalog.partial && (
        <>
          <div className="flex animate-fade-in items-center gap-2 rounded-md border border-border bg-card px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            First load — fetching {filters.includeCpu ? "all VM" : "GPU"}{" "}
            SKUs from Microsoft.Compute/skus. This runs once; the result
            is cached for 7 days.
          </div>
          {/* Skeleton rows so the layout doesn't visually collapse while
              the SKU walk runs. */}
          <div className="flex flex-col gap-2" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <VmRowSkeleton key={i} />
            ))}
          </div>
        </>
      )}
      {catalog.loading && catalog.partial && (
        <div className="flex animate-fade-in items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          <Loader2 className="h-4 w-4 animate-spin" />
          Refreshing in background — current results below are from the
          cached snapshot.
        </div>
      )}

      <div className="flex items-center gap-3 rounded-md border border-border bg-surface-base/40 px-3 py-2 text-2xs text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        <span>
          <span className="font-semibold text-foreground tabular-nums">
            <NumberTicker value={filteredRows.length} />
          </span>{" "}
          of{" "}
          <span className="tabular-nums">
            <NumberTicker value={rows.length} />
          </span>{" "}
          {filters.includeCpu ? "" : "GPU "}SKUs
          {catalog.loading && catalog.partial && (
            <span className="ml-2 inline-flex items-center gap-1 text-primary">
              <Loader2 className="h-3 w-3 animate-spin" />
              streaming more…
            </span>
          )}
        </span>
        {regionsToProbe.length > 0 && (
          <span>
            · Batch probed in {regionsToProbe.length} region
            {regionsToProbe.length === 1 ? "" : "s"}
          </span>
        )}
        {catalog.fetchedAt && (
          <span>
            · refreshed at{" "}
            {new Date(catalog.fetchedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {filteredRows.slice(0, 200).map((row) => {
          const supportedRegionMap = new Map<string, boolean>();
          for (const r of regionsToProbe) {
            const supported = catalog.batchSupported.has(
              `${row.sku.name.toLowerCase()}::${r}`,
            );
            supportedRegionMap.set(r, supported);
          }
          const anySupported = Array.from(supportedRegionMap.values()).some(
            Boolean,
          );
          const isPinned = pinned.has(row.sku.name);
          const inCompare = compareSet.has(row.sku.name);
          return (
            <VmRowCard
              key={row.sku.name}
              row={row}
              batchSupportedAnyRegion={anySupported}
              batchSupportedByRegion={supportedRegionMap}
              onUseVm={onUseVm}
              density={density}
              pinned={isPinned}
              onTogglePin={() => togglePin(row.sku.name)}
              inCompare={inCompare}
              compareDisabled={
                !inCompare && compareSet.size >= COMPARE_MAX
              }
              onToggleCompare={() => toggleCompare(row.sku.name)}
              onCopyName={() => copyToName(row.sku.name)}
            />
          );
        })}
        {filteredRows.length > 200 && (
          <div className="px-2 py-1 text-2xs text-muted-foreground">
            Showing first 200 of {filteredRows.length} matches — narrow the
            filters to see more.
          </div>
        )}
        {!catalog.loading && filteredRows.length === 0 && rows.length > 0 && (
          <div className="flex animate-fade-in flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-base/30 px-4 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/40">
              <Filter className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="text-sm font-medium text-foreground">
              No VMs match these filters
            </div>
            <div className="max-w-md text-xs text-muted-foreground">
              Try clearing chips, widening the vCPU/memory range, or
              unchecking "Batch-supported only".
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={clearAll}
              className="mt-1 gap-1"
            >
              <X className="h-3 w-3" />
              Clear filters
            </Button>
          </div>
        )}
        {/*
          Diagnostic banner for the "0 of 0 SKUs" case — i.e. the
          catalog never populated. Distinct from the "filters hide
          everything" banner above. Surfaces the three real causes the
          user can act on instead of leaving them staring at zeros.
        */}
        {!catalog.loading &&
          !catalog.error &&
          rows.length === 0 &&
          selectedSubId && (
            <div className="flex animate-fade-in flex-col items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-8 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/15 ring-1 ring-warning/30">
                <ShieldX className="h-5 w-5 text-warning" />
              </div>
              <p className="text-sm font-semibold text-warning">
                Catalog is empty for this subscription
              </p>
              <p className="text-xs text-muted-foreground">Possible causes:</p>
              <ul className="ml-4 list-disc text-left text-xs text-muted-foreground">
                <li>
                  No {filters.includeCpu ? "VM" : "GPU"} SKUs are visible to
                  this subscription &mdash; try toggling{" "}
                  <span className="font-semibold">Include CPU SKUs</span>
                </li>
                <li>
                  Your account may lack{" "}
                  <code>Microsoft.Compute/skus/read</code> on this
                  subscription
                </li>
                <li>
                  The catalog hasn't finished loading &mdash; click{" "}
                  <span className="font-semibold">Refresh</span> above
                </li>
              </ul>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setRefreshKey((n) => n + 1)}
                className="mt-1 gap-1"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh now
              </Button>
            </div>
          )}
        {!catalog.loading &&
          !catalog.error &&
          !selectedSubId && (
            <div className="flex animate-fade-in flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-surface-base/30 px-4 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/40 text-muted-foreground">
                <Layers className="h-5 w-5" />
              </div>
              <div className="text-sm font-medium text-foreground">
                Pick a subscription to load the catalog
              </div>
              <div className="max-w-md text-xs text-muted-foreground">
                The catalog reads <code>Microsoft.Compute/skus</code> per
                subscription. Sign in and choose one above to populate.
              </div>
            </div>
          )}
      </div>

      {/* Floating compare bar — appears at the bottom whenever there are
          SKUs queued for comparison, regardless of scroll position. */}
      {compareSet.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-3xl items-center gap-2 rounded-full border border-border bg-card/95 px-4 py-2 shadow-elev-3 backdrop-blur">
            <GitCompare className="h-3.5 w-3.5 text-accent-foreground" />
            <span className="text-xs font-medium text-foreground">
              {compareSet.size} of {COMPARE_MAX} queued for compare
            </span>
            <div className="hidden gap-1 sm:flex">
              {Array.from(compareSet).map((name) => (
                <span
                  key={name}
                  className="rounded-full bg-muted/50 px-2 py-0.5 font-mono text-2xs text-muted-foreground"
                  title={name}
                >
                  {name.replace(/^Standard_/, "")}
                </span>
              ))}
            </div>
            <Button
              type="button"
              size="xs"
              variant="default"
              onClick={() => setCompareOpen(true)}
              className="gap-1"
            >
              Open
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={clearCompare}
              className="gap-1"
              aria-label="Clear comparison"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      {/* Copy-feedback toast — small floating confirmation that the row's
          name landed on the clipboard. */}
      {copyToast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-20 right-6 z-40 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-1.5 text-xs text-success shadow-elev-2 animate-fade-in"
        >
          <Copy className="h-3.5 w-3.5" />
          Copied{" "}
          <span className="font-mono font-medium">{copyToast}</span>
        </div>
      )}

      {/* Side-by-side compare dialog */}
      <CompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        skuNames={Array.from(compareSet)}
        allRows={rows}
        onRemove={toggleCompare}
        onClearAll={clearCompare}
        diffOnly={compareDiffOnly}
        onToggleDiffOnly={setCompareDiffOnly}
        regionsToProbe={regionsToProbe}
        batchSupported={catalog.batchSupported}
      />
    </div>
  );
};

/**
 * Loading skeleton for a VM row card. Matches the comfortable layout so
 * the swap from skeleton → real row is non-jarring.
 */
const VmRowSkeleton: React.FC = () => (
  <div className="rounded-lg border border-border bg-card p-3">
    <div className="flex items-start gap-3">
      <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted/40" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-3 w-40 animate-pulse rounded bg-muted/40" />
          <div className="h-3 w-12 animate-pulse rounded-full bg-muted/30" />
          <div className="h-3 w-16 animate-pulse rounded-full bg-muted/30" />
        </div>
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted/20" />
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ChipRowProps {
  label: string;
  icon?: React.ReactNode;
  empty?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}

const ChipRow: React.FC<ChipRowProps> = ({
  label,
  icon,
  empty,
  extra,
  children,
}) => {
  // Children is normally an array of <Chip /> nodes — count to detect empty.
  const childArray = React.Children.toArray(children);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </span>
      {childArray.length === 0 ? (
        <span className="text-2xs text-muted-foreground/70">
          {empty ?? "—"}
        </span>
      ) : (
        children
      )}
      {extra}
    </div>
  );
};

const RangeInput: React.FC<{
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}> = ({ value, placeholder, onChange }) => (
  <Input
    type="number"
    inputMode="numeric"
    min={0}
    placeholder={placeholder}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="h-7 w-20 text-xs"
    aria-label={placeholder}
  />
);

/**
 * Summary stat pill — a label/value chip for the header summary row.
 * The "tone" prop maps to a Tailwind colour theme so different metric
 * types are distinguishable at a glance without the user reading labels.
 */
const SummaryPill: React.FC<{
  label: string;
  value: number | string;
  hint?: string;
  tone?: "primary" | "accent" | "info" | "warning" | "success" | "muted";
  icon?: React.ReactNode;
}> = ({ label, value, hint, tone = "muted", icon }) => {
  const toneCls = {
    primary: "border-primary/30 bg-primary/10 text-primary",
    accent: "border-accent/40 bg-accent/20 text-accent-foreground",
    info: "border-info/30 bg-info/10 text-info",
    warning: "border-warning/30 bg-warning/10 text-warning",
    success: "border-success/30 bg-success/10 text-success",
    muted: "border-border bg-card text-muted-foreground",
  }[tone];
  const pill = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium",
        toneCls,
      )}
    >
      {icon}
      <span className="opacity-80">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  );
  if (!hint) return pill;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </Tooltip>
  );
};

// ---------------------------------------------------------------------------
// Compare dialog — side-by-side capability table for up to COMPARE_MAX rows.
//
// Renders one column per selected SKU, one row per capability key found
// across the union of the selected SKUs. Optional "diff only" mode hides
// rows where every selected SKU agrees on the value, which is the most
// useful view when comparing two near-identical SKUs (e.g. NC24ads_v4 vs
// NC48ads_v4 — diff-only collapses everything to the few fields that
// actually differ).
// ---------------------------------------------------------------------------

interface CompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skuNames: string[];
  allRows: VmRow[];
  onRemove: (name: string) => void;
  onClearAll: () => void;
  diffOnly: boolean;
  onToggleDiffOnly: (v: boolean) => void;
  regionsToProbe: string[];
  batchSupported: Set<string>;
}

const CompareDialog: React.FC<CompareDialogProps> = ({
  open,
  onOpenChange,
  skuNames,
  allRows,
  onRemove,
  onClearAll,
  diffOnly,
  onToggleDiffOnly,
  regionsToProbe,
  batchSupported,
}) => {
  const selected = React.useMemo(
    () => skuNames.map((n) => allRows.find((r) => r.sku.name === n)).filter(
      (r): r is VmRow => Boolean(r),
    ),
    [skuNames, allRows],
  );

  // Build the union of capability keys, plus our derived metrics so
  // they appear in a fixed order at the top of the table.
  const { derivedRows, capabilityKeys } = React.useMemo(() => {
    const derived: Array<{ key: string; label: string; values: string[] }> = [];
    const push = (label: string, fn: (r: VmRow) => string) => {
      derived.push({
        key: `__derived_${label}`,
        label,
        values: selected.map(fn),
      });
    };
    push("Family", (r) => r.family);
    push("Category", (r) => r.category ?? "—");
    push("vCPUs", (r) => (r.vCPUs !== null ? String(r.vCPUs) : "—"));
    push("Memory (GB)", (r) =>
      r.memoryGB !== null ? String(r.memoryGB) : "—",
    );
    push("GPU type", (r) => r.gpuType ?? "—");
    push("GPU count", (r) =>
      r.gpuCount !== null ? String(r.gpuCount) : "—",
    );
    push("Architecture", (r) => r.cpuArchitecture ?? "—");
    push("Local SSD (GB)", (r) =>
      r.maxResourceVolumeGB !== null ? String(r.maxResourceVolumeGB) : "—",
    );
    push("Available regions", (r) => String(r.availableRegions.length));
    if (regionsToProbe.length > 0) {
      push("Batch (probed regions)", (r) => {
        const supported = regionsToProbe.filter((reg) =>
          batchSupported.has(`${r.sku.name.toLowerCase()}::${reg}`),
        );
        return `${supported.length}/${regionsToProbe.length}`;
      });
    }

    // Union of raw capability keys across selected SKUs.
    const keys = new Set<string>();
    for (const r of selected) {
      for (const k of Object.keys(r.sku.capabilities)) keys.add(k);
    }
    const sortedKeys = Array.from(keys).sort();
    return { derivedRows: derived, capabilityKeys: sortedKeys };
  }, [selected, regionsToProbe, batchSupported]);

  const renderCell = (value: string, allValues: string[]) => {
    const allSame = allValues.every((v) => v === allValues[0]);
    return (
      <td
        className={cn(
          "border-b border-border/50 px-3 py-1.5 text-xs",
          !allSame && "bg-warning/5 font-medium text-foreground",
          allSame && "text-muted-foreground",
        )}
      >
        {value === "" ? "—" : value}
      </td>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] w-[min(96vw,1100px)] max-w-none overflow-hidden p-0"
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-accent-foreground" />
            Side-by-side comparison
            <span className="rounded-full bg-muted/40 px-2 py-0.5 text-2xs font-normal text-muted-foreground">
              {selected.length} of {COMPARE_MAX}
            </span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            Comparing {selected.length} SKU
            {selected.length === 1 ? "" : "s"}. Differing values are
            highlighted.
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-2xs hover:bg-muted/40">
              <input
                type="checkbox"
                checked={diffOnly}
                onChange={(e) => onToggleDiffOnly(e.target.checked)}
                className="h-3 w-3"
              />
              Show differences only
            </label>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onClearAll}
              className="gap-1"
            >
              <X className="h-3 w-3" />
              Clear all
            </Button>
          </DialogDescription>
        </DialogHeader>
        {selected.length === 0 ? (
          <div className="flex items-center justify-center px-6 py-10 text-sm text-muted-foreground">
            Add SKUs from the catalog (use the{" "}
            <GitCompare className="mx-1 inline h-3.5 w-3.5" /> button on each
            row) to compare them here.
          </div>
        ) : (
          <ScrollArea className="max-h-[70vh]">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Capability
                  </th>
                  {selected.map((r) => (
                    <th
                      key={r.sku.name}
                      className="px-3 py-2 text-xs font-medium text-foreground"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono">
                          {r.sku.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemove(r.sku.name)}
                          className="rounded p-0.5 text-muted-foreground/60 hover:bg-muted/40 hover:text-foreground"
                          aria-label={`Remove ${r.sku.name} from comparison`}
                          title="Remove from compare"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="mt-0.5 text-2xs font-normal text-muted-foreground">
                        {r.family}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Derived rows first — these are the things humans actually
                    care about (vCPU/RAM/GPU) ahead of the alphabetical
                    capability dump. */}
                {derivedRows
                  .filter((dr) => {
                    if (!diffOnly) return true;
                    return !dr.values.every((v) => v === dr.values[0]);
                  })
                  .map((dr) => (
                    <tr key={dr.key} className="hover:bg-muted/20">
                      <td className="border-b border-border/50 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {dr.label}
                      </td>
                      {dr.values.map((v, i) => (
                        <React.Fragment key={i}>
                          {renderCell(v, dr.values)}
                        </React.Fragment>
                      ))}
                    </tr>
                  ))}
                {/* Section divider before the raw capability dump */}
                <tr>
                  <td
                    colSpan={selected.length + 1}
                    className="border-b border-border bg-muted/30 px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Raw capabilities (Microsoft.Compute/skus)
                  </td>
                </tr>
                {capabilityKeys
                  .map((k) => {
                    const values = selected.map(
                      (r) => r.sku.capabilities[k] ?? "",
                    );
                    return { k, values };
                  })
                  .filter(({ values }) => {
                    if (!diffOnly) return true;
                    return !values.every((v) => v === values[0]);
                  })
                  .map(({ k, values }) => (
                    <tr key={k} className="hover:bg-muted/20">
                      <td className="border-b border-border/50 px-3 py-1.5 font-mono text-2xs text-foreground/80">
                        {k}
                      </td>
                      {values.map((v, i) => (
                        <React.Fragment key={i}>
                          {renderCell(v, values)}
                        </React.Fragment>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
};
