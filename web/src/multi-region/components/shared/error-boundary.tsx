import * as React from "react";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { PrimaryButton } from "@fluentui/react/lib/Button";

interface ErrorBoundaryProps {
    children: React.ReactNode;
    fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
    resetKey: number;
}

export class ErrorBoundary extends React.Component<
    ErrorBoundaryProps,
    ErrorBoundaryState
> {
    state: ErrorBoundaryState = { hasError: false, error: null, resetKey: 0 };

    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        console.error("[ErrorBoundary]", error, info.componentStack);
    }

    private handleReset = () => {
        this.setState((prev) => ({
            hasError: false,
            error: null,
            resetKey: prev.resetKey + 1,
        }));
    };

    render(): React.ReactNode {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }
            return (
                <div
                    style={{
                        padding: 32,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 16,
                    }}
                >
                    <MessageBar
                        messageBarType={MessageBarType.error}
                        isMultiline
                        styles={{ root: { maxWidth: 600 } }}
                    >
                        <b>Something went wrong.</b>
                        <br />
                        {this.state.error?.message ?? "Unknown error"}
                    </MessageBar>
                    <PrimaryButton
                        text="Reload Dashboard"
                        onClick={this.handleReset}
                    />
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
