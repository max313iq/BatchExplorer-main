import * as React from "react";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { PrimaryButton } from "@fluentui/react/lib/Button";

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    ErrorBoundaryState
> {
    state: ErrorBoundaryState = { hasError: false, error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        console.error("[ErrorBoundary]", error, info.componentStack);
    }

    render(): React.ReactNode {
        if (this.state.hasError) {
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
                        onClick={() => {
                            this.setState({ hasError: false, error: null });
                        }}
                    />
                </div>
            );
        }
        return this.props.children;
    }
}
