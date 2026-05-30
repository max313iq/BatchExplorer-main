import * as React from "react";
import { AlertCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  resetKey: number;
  /** True when the captured error is a React hook-order mismatch caused by
   *  HMR swapping a module whose hook count changed across bundles. */
  isHookMismatch: boolean;
}

/**
 * React's hook-count-mismatch errors only fire in dev under HMR — production
 * hook order is statically frozen, so matching by message is safe. When the
 * dev-server hot-swaps a module that changed hook count, the retained React
 * fiber no longer matches the new bundle's call order; remounting children
 * won't help (the root fiber is still stale). Auto-reload is the only
 * reliable recovery.
 */
function isHmrHookMismatch(error: Error | null): boolean {
  const msg = error?.message ?? "";
  return (
    msg.includes("Rendered more hooks than during the previous render") ||
    msg.includes("Rendered fewer hooks than expected") ||
    msg.includes("Should have a queue") ||
    msg.includes("Cannot read properties of null (reading 'useState')") ||
    msg.includes("Cannot read properties of null (reading 'useEffect')")
  );
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    resetKey: 0,
    isHookMismatch: false,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
      isHookMismatch: isHmrHookMismatch(error),
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
    if (isHmrHookMismatch(error) && typeof window !== "undefined") {
      console.warn(
        "[ErrorBoundary] hook-order mismatch (HMR aftermath) — auto-reloading in 600ms",
      );
      // 600ms so the operator sees the alert; long enough to not reload-loop
      // if the same edit keeps producing the same error.
      window.setTimeout(() => window.location.reload(), 600);
    }
  }

  private handleReset = () => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      isHookMismatch: false,
      resetKey: prev.resetKey + 1,
    }));
  };

  private handleHardReload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const { error, isHookMismatch } = this.state;
      return (
        <div className="flex flex-col items-center gap-4 p-8">
          <Alert variant="destructive" className="max-w-2xl">
            <AlertCircle />
            <AlertTitle>Something went wrong.</AlertTitle>
            <AlertDescription>
              {error?.message || "Unknown error"}
              {isHookMismatch && (
                <span className="mt-2 block text-xs opacity-90">
                  Dev-mode hot-reload aftermath: a code change altered the
                  page&apos;s React hook sequence. Reloading automatically —
                  this never happens in production builds.
                </span>
              )}
            </AlertDescription>
          </Alert>
          {isHookMismatch ? (
            <Button onClick={this.handleHardReload}>Reload Page Now</Button>
          ) : (
            <Button onClick={this.handleReset}>Reload Dashboard</Button>
          )}
        </div>
      );
    }
    return (
      <React.Fragment key={this.state.resetKey}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
