import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StatusToneName } from "@/styles/tokens";

/**
 * Maps a raw Batch status string to one of five semantic tones. The mapping
 * deliberately groups intermediate states (rebooting, reimaging, starting,
 * waitingforstarttask) under "warning" so they read as in-flight rather than
 * either OK or broken.
 */
const STATUS_TO_TONE: Record<string, StatusToneName> = {
  // Generic lifecycle
  pending: "warning",
  creating: "info",
  created: "success",
  submitted: "info",
  approved: "success",
  denied: "error",
  failed: "error",
  idle: "muted",
  running: "info",
  completed: "success",
  error: "error",
  // Node states
  rebooting: "warning",
  reimaging: "warning",
  starting: "info",
  waitingforstarttask: "warning",
  starttaskfailed: "error",
  unusable: "error",
  offline: "muted",
  preempted: "warning",
  leavingpool: "warning",
  unknown: "muted",
};

const TONE_CLASS: Record<StatusToneName, string> = {
  success:
    "border-success/40 bg-success/15 text-success [&]:hover:bg-success/20",
  warning:
    "border-warning/40 bg-warning/15 text-warning [&]:hover:bg-warning/20",
  error:
    "border-destructive/40 bg-destructive/15 text-destructive [&]:hover:bg-destructive/20",
  info: "border-info/40 bg-info/15 text-info [&]:hover:bg-info/20",
  muted: "border-border bg-muted text-muted-foreground [&]:hover:bg-muted/80",
};

interface StatusBadgeProps {
  status: string;
  label?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label }) => {
  const normalizedStatus = status.toLowerCase().replace(/\s/g, "");
  const tone = STATUS_TO_TONE[normalizedStatus] ?? "muted";

  return (
    <Badge
      variant="outline"
      className={cn(
        "border px-2 py-0 capitalize tracking-tight transition-colors duration-150",
        TONE_CLASS[tone],
      )}
      title={status}
      aria-label={`Status: ${status}`}
    >
      {label ?? status}
    </Badge>
  );
};
