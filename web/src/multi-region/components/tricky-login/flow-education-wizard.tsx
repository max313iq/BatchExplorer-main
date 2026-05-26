/**
 * Flow-education wizard — "Why are you using this flow?" dialog.
 *
 * Pure educational surface. Triggered from the method-picker card; opens
 * a dialog showing one entry per flow with:
 *   - What it does (operator-facing)
 *   - When to use it
 *   - Defensive vs offensive framing
 *   - Wire-shape headline (mitmproxy-eye-view)
 *   - Corpus playbook + source reference
 *
 * NO side effects beyond a local "current entry" selector. NO mint. NO
 * token material exposed (the wizard is metadata-only by construction —
 * the FLOW_EDUCATION data lives in corpus-advisories.ts and is static).
 */
import * as React from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  Sparkles,
  X,
  Zap,
  Repeat2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { FLOW_EDUCATION } from "./corpus-advisories";
import type { TrickyLoginMethod } from "./tricky-login-helpers";

const METHOD_ICON: Readonly<Record<TrickyLoginMethod, React.ElementType>> = {
  "msal-silent": Repeat2,
  "foci-exchange": Zap,
  auto: Sparkles,
};

export interface FlowEducationWizardProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Open/close callback (mirrors Radix Dialog onOpenChange). */
  onOpenChange: (next: boolean) => void;
  /**
   * Optional initial method to land on. If absent, lands on Auto.
   * Operators usually open the wizard pointed at the currently-selected
   * method, so we default to whatever the page passes in.
   */
  initialMethod?: TrickyLoginMethod;
}

/**
 * Tabbed wizard dialog. Each tab is one of the three flows; the body
 * renders the entry's static fields and the corpus citation. Keyboard:
 * Esc closes (Radix default), Left/Right arrows step entries.
 */
export const FlowEducationWizard: React.FC<FlowEducationWizardProps> = ({
  open,
  onOpenChange,
  initialMethod,
}) => {
  // Selected entry index — defaults to the initial method.
  const initialIndex = React.useMemo(() => {
    if (!initialMethod) return 0;
    const idx = FLOW_EDUCATION.findIndex((e) => e.method === initialMethod);
    return idx >= 0 ? idx : 0;
  }, [initialMethod]);

  const [index, setIndex] = React.useState<number>(initialIndex);

  // Reset to the initial index whenever the dialog re-opens.
  React.useEffect(() => {
    if (open) setIndex(initialIndex);
  }, [open, initialIndex]);

  // Arrow-key navigation within the open dialog. Bound on the dialog
  // content's keydown so we don't capture global key events.
  const handleContentKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((i) => (i + 1) % FLOW_EDUCATION.length);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => (i - 1 + FLOW_EDUCATION.length) % FLOW_EDUCATION.length);
      }
    },
    [],
  );

  const entry = FLOW_EDUCATION[index];
  const EntryIcon = METHOD_ICON[entry?.method ?? "auto"] ?? Sparkles;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        onKeyDown={handleContentKeyDown}
        aria-describedby="flow-education-description"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4 text-primary" aria-hidden />
            Why are you using this flow?
          </DialogTitle>
          <DialogDescription id="flow-education-description">
            Operator-education guide for the three Tricky Login flows. Each
            entry includes the on-the-wire shape and a citation to the
            authoritative corpus playbook so you can read the source code
            yourself.
          </DialogDescription>
        </DialogHeader>

        {/* Flow tab strip */}
        <div
          className="flex gap-2 border-b pb-2"
          role="tablist"
          aria-label="Flow education tabs"
        >
          {FLOW_EDUCATION.map((e, i) => {
            const Icon = METHOD_ICON[e.method];
            const selected = i === index;
            return (
              <button
                key={e.method}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`flow-edu-panel-${e.method}`}
                onClick={() => setIndex(i)}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span>{e.label}</span>
              </button>
            );
          })}
        </div>

        {entry && (
          <div
            id={`flow-edu-panel-${entry.method}`}
            role="tabpanel"
            aria-labelledby={`flow-edu-tab-${entry.method}`}
            className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-2 text-sm"
          >
            <div className="flex items-center gap-2">
              <EntryIcon className="h-4 w-4 text-primary" aria-hidden />
              <span className="font-semibold">{entry.label}</span>
              <Badge variant="outline" className="text-2xs">
                Step {index + 1} / {FLOW_EDUCATION.length}
              </Badge>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-2xs uppercase tracking-wider text-muted-foreground">
                What it does
              </div>
              <p className="m-0 text-xs">{entry.whatItDoes}</p>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-2xs uppercase tracking-wider text-muted-foreground">
                When to use it
              </div>
              <p className="m-0 text-xs">{entry.whenToUse}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1 rounded-md border bg-success/5 p-2">
                <div className="text-2xs uppercase tracking-wider text-success">
                  Defensive framing
                </div>
                <p className="m-0 text-2xs leading-snug">
                  {entry.defensiveFraming}
                </p>
              </div>
              <div className="flex flex-col gap-1 rounded-md border bg-warning/5 p-2">
                <div className="text-2xs uppercase tracking-wider text-warning">
                  Offensive framing
                </div>
                <p className="m-0 text-2xs leading-snug">
                  {entry.offensiveFraming}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-2xs uppercase tracking-wider text-muted-foreground">
                Wire shape (mitmproxy view)
              </div>
              <pre className="m-0 whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono text-2xs leading-snug">
                {entry.wireShape}
              </pre>
            </div>

            <div className="flex flex-col gap-1 rounded-md border bg-card/40 p-2">
              <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-muted-foreground">
                <Info className="h-3 w-3" aria-hidden />
                Authoritative corpus reference
              </div>
              <p className="m-0 text-2xs">
                <span className="font-semibold">Playbook:</span>{" "}
                <code className="font-mono">{entry.corpusRef}</code>
              </p>
              <p className="m-0 text-2xs">
                <span className="font-semibold">Source:</span>{" "}
                <code className="break-all font-mono">{entry.corpusSource}</code>
              </p>
              <p className="m-0 pt-1 text-3xs italic text-muted-foreground">
                Corpus root: C:\Users\baimgprodsesa1\Desktop\New folder\
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="flex flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setIndex((i) =>
                  (i - 1 + FLOW_EDUCATION.length) % FLOW_EDUCATION.length,
                )
              }
              className="gap-1"
              aria-label="Previous flow"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setIndex((i) => (i + 1) % FLOW_EDUCATION.length)
              }
              className="gap-1"
              aria-label="Next flow"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
          <Button
            variant="default"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="gap-1"
            aria-label="Close flow education"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// Re-export the icon X for callers who want a close-button glyph that
// matches the rest of the wizard surface (currently unused — kept for
// future expansion).
export { X as WizardCloseIcon };
