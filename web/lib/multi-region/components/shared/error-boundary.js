import * as React from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
export class ErrorBoundary extends React.Component {
    constructor() {
        super(...arguments);
        Object.defineProperty(this, "state", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: { hasError: false, error: null, resetKey: 0 }
        });
        Object.defineProperty(this, "handleReset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => {
                this.setState((prev) => ({
                    hasError: false,
                    error: null,
                    resetKey: prev.resetKey + 1,
                }));
            }
        });
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, info) {
        console.error("[ErrorBoundary]", error, info.componentStack);
    }
    render() {
        var _a, _b;
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }
            return (React.createElement("div", { className: "flex flex-col items-center gap-4 p-8" },
                React.createElement(Alert, { variant: "destructive", className: "max-w-2xl" },
                    React.createElement(AlertCircle, null),
                    React.createElement(AlertTitle, null, "Something went wrong."),
                    React.createElement(AlertDescription, null, (_b = (_a = this.state.error) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : "Unknown error")),
                React.createElement(Button, { onClick: this.handleReset }, "Reload Dashboard")));
        }
        return (React.createElement(React.Fragment, { key: this.state.resetKey }, this.props.children));
    }
}
//# sourceMappingURL=error-boundary.js.map