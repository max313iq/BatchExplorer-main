import * as React from "react";
import { Copy, Maximize2, Minimize2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  useMultiRegionState,
  useMultiRegionStore,
} from "../../store/store-context";
import { AgentLogEntry } from "../../store/store-types";
import { DEFAULT_CONFIG } from "./constants";

type LogLevel = "all" | "info" | "warn" | "error";

const COMPACT_HEIGHT = 120;
const FULL_HEIGHT = 300;

const LEVEL_TONE: Record<string, string> = {
  info: "text-foreground/80",
  warn: "text-warning",
  error: "text-destructive",
};

const LEVEL_OPTIONS: { key: LogLevel; text: string }[] = [
  { key: "all", text: "All" },
  { key: "info", text: "Info" },
  { key: "warn", text: "Warn" },
  { key: "error", text: "Error" },
];

function formatLogLine(log: AgentLogEntry): string {
  const ts = new Date(log.timestamp).toLocaleTimeString();
  const level = log.level.toUpperCase().padEnd(5);
  return `${ts} [${log.agent}] ${level} ${log.message}`;
}

export const AgentLogPanel: React.FC = () => {
  const state = useMultiRegionState();
  const store = useMultiRegionStore();
  const [expanded, setExpanded] = React.useState(false);
  const [levelFilter, setLevelFilter] = React.useState<LogLevel>("all");
  const [panelSize, setPanelSize] = React.useState<"compact" | "full">(
    "compact",
  );
  const containerRef = React.useRef<HTMLDivElement>(null);

  const filteredLogs = React.useMemo(() => {
    // Defensive: state.agentLogs is initialized to [] in the store,
    // but a stale snapshot during a tenant switch / session reset can
    // briefly leave it undefined. Coerce to [] so the panel doesn't
    // crash the whole page with "Cannot read properties of undefined
    // (reading 'slice')" during a render mid-state-change.
    const recent = (state.agentLogs ?? []).slice(
      -DEFAULT_CONFIG.logRetentionCount,
    );
    if (levelFilter === "all") return recent;
    return recent.filter((log) => log.level === levelFilter);
  }, [state.agentLogs, levelFilter]);

  React.useEffect(() => {
    if (containerRef.current && expanded) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredLogs.length, expanded]);

  const handleCopyLogs = React.useCallback(() => {
    const text = state.agentLogs.map(formatLogLine).join("\n");
    // Guard against insecure contexts / older browsers where clipboard is
    // undefined — calling writeText on it would throw synchronously and
    // crash the click handler.
    const clip = navigator.clipboard;
    if (!clip?.writeText) {
      store.addNotification({
        type: "error",
        message:
          "Clipboard API unavailable — copy the logs manually from the panel.",
      });
      return;
    }
    clip.writeText(text).then(
      () => {
        store.addNotification({
          type: "success",
          message: `Copied ${state.agentLogs.length} log line${state.agentLogs.length === 1 ? "" : "s"}.`,
          autoDismissMs: 1800,
        });
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        store.addNotification({
          type: "error",
          message: `Copy failed: ${msg}`,
        });
      },
    );
  }, [state.agentLogs, store]);

  const handleClearLogs = React.useCallback(() => {
    store.clearLogs();
  }, [store]);

  const toggleSize = React.useCallback(() => {
    setPanelSize((prev) => (prev === "compact" ? "full" : "compact"));
  }, []);

  const maxHeight = panelSize === "compact" ? COMPACT_HEIGHT : FULL_HEIGHT;

  return (
    <div className="border-t border-border bg-surface-base">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label="Toggle agent logs panel"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        className="flex cursor-pointer select-none items-center justify-between bg-surface-raised px-4 py-2 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Agent Logs{" "}
          <span className="ml-1 font-normal normal-case tracking-normal tabular-nums">
            ({state.agentLogs.length})
          </span>
        </span>
        <span className="text-2xs text-muted-foreground">
          {expanded ? "Collapse" : "Expand"}
        </span>
      </div>
      {expanded && (
        <div className="bg-surface-base">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <Select
              value={levelFilter}
              onValueChange={(v) => setLevelFilter(v as LogLevel)}
            >
              <SelectTrigger className="h-7 w-[100px] text-xs">
                <SelectValue placeholder="All levels" />
              </SelectTrigger>
              <SelectContent>
                {LEVEL_OPTIONS.map((o) => (
                  <SelectItem key={o.key} value={o.key} className="text-xs">
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Clear Logs"
              aria-label="Clear Logs"
              onClick={handleClearLogs}
            >
              <Trash2 />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Copy Logs"
              aria-label="Copy Logs"
              onClick={handleCopyLogs}
            >
              <Copy />
            </Button>
            <div className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={
                panelSize === "compact"
                  ? "Expand to full size"
                  : "Shrink to compact"
              }
              aria-label="Toggle panel size"
              onClick={toggleSize}
            >
              {panelSize === "compact" ? <Maximize2 /> : <Minimize2 />}
            </Button>
          </div>
          <div
            ref={containerRef}
            className="overflow-y-auto px-4 pb-2 pt-1 font-mono text-xs leading-relaxed"
            style={{ maxHeight: `${maxHeight}px` }}
          >
            {filteredLogs.map((log: AgentLogEntry, idx: number) => (
              <div
                key={idx}
                className={cn(
                  "whitespace-pre-wrap break-words py-px",
                  LEVEL_TONE[log.level] ?? "text-foreground/80",
                )}
              >
                <span className="text-muted-foreground/60 tabular-nums">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>{" "}
                <span className="font-semibold text-muted-foreground">
                  [{log.agent}]
                </span>{" "}
                <span
                  className={cn(
                    "font-semibold uppercase",
                    LEVEL_TONE[log.level],
                  )}
                >
                  {log.level}
                </span>{" "}
                {log.message}
              </div>
            ))}
            {filteredLogs.length === 0 && (
              <div className="py-2 text-xs text-muted-foreground/60">
                No logs yet
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
