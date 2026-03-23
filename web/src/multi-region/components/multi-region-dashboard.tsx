import * as React from "react";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { DefaultButton, IconButton } from "@fluentui/react/lib/Button";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import { Toggle } from "@fluentui/react/lib/Toggle";
import {
    MultiRegionStoreProvider,
    useMultiRegionState,
    useMultiRegionStore,
} from "../store/store-context";
import { MultiRegionStore } from "../store/multi-region-store";
import { RequestScheduler } from "../scheduling/request-scheduler";
import { OrchestratorAgent } from "../agents/orchestrator-agent";
import { AgentContext } from "../agents/agent-types";
import { SidebarNav, PageKey } from "./shared/sidebar-nav";
import { ToastContainer } from "./shared/toast-container";
import { ErrorBoundary } from "./shared/error-boundary";
import { GlobalFilterBar } from "./global-filter-bar";
import { OverviewPage } from "./overview/overview-page";
import { AccountProvisioningPage } from "./account-provisioning/account-provisioning-page";
import { QuotaRequestsPage } from "./quota-requests/quota-requests-page";
import { QuotaStatusPage } from "./quota-status/quota-status-page";
import { PoolCreationPage } from "./pool-creation/pool-creation-page";
import { NodesPage } from "./nodes/nodes-page";
import { PoolInfoPage } from "./pool-info/pool-info-page";
import { AccountInfoPage } from "./account-info/account-info-page";
import { AgentLogPanel } from "./shared/agent-log-panel";
import { ActivityPanel } from "./shared/activity-panel";

const DEFAULT_SCHEDULER_OPTIONS = {
    concurrency: 1,
    delayMs: 2000,
    retryAttempts: 5,
    retryBackoffSeconds: [2, 4, 8, 16, 32],
    jitterPct: 0.2,
    maxQueueSize: 100,
};

interface CachedToken {
    accessToken: string;
    expiresOn: string;
}

let _cachedArmToken: CachedToken | null = null;
let _cachedBatchToken: CachedToken | null = null;

function isTokenValid(cached: CachedToken | null): boolean {
    if (!cached) return false;
    return Date.now() < new Date(cached.expiresOn).getTime() - 2 * 60 * 1000;
}

async function fetchTokenFromProxy(endpoint: string): Promise<CachedToken> {
    const response = await fetch(endpoint);
    if (!response.ok) {
        let errorMsg = `Token request failed (${response.status})`;
        try {
            const err = await response.json();
            errorMsg = err?.error ?? err?.details ?? errorMsg;
        } catch {
            /* use default */
        }
        throw new Error(errorMsg);
    }
    const data = await response.json();
    return { accessToken: data.accessToken, expiresOn: data.expiresOn };
}

async function getAccessTokenFromCli(): Promise<string> {
    if (isTokenValid(_cachedArmToken)) return _cachedArmToken!.accessToken;
    _cachedArmToken = await fetchTokenFromProxy("/api/token");
    return _cachedArmToken.accessToken;
}

async function getBatchAccessTokenFromCli(): Promise<string> {
    if (isTokenValid(_cachedBatchToken)) return _cachedBatchToken!.accessToken;
    _cachedBatchToken = await fetchTokenFromProxy("/api/token/batch");
    return _cachedBatchToken.accessToken;
}

interface HealthCheckResult {
    healthy: boolean;
    error: string | null;
}

async function performHealthCheck(): Promise<HealthCheckResult> {
    // Step 1: Check Azure CLI login
    try {
        const authRes = await fetch("/api/auth/status");
        if (!authRes.ok) {
            return {
                healthy: false,
                error: "Cannot reach auth service. Is the proxy server running?",
            };
        }
        const authData = await authRes.json();
        if (authData.loggedIn !== true) {
            return {
                healthy: false,
                error: "Azure CLI not logged in. Run `az login` then retry.",
            };
        }
    } catch {
        return {
            healthy: false,
            error: "Cannot reach auth service. Is the proxy server running?",
        };
    }

    // Step 2: Check ARM token
    try {
        const armRes = await fetch("/api/token");
        if (!armRes.ok) {
            return {
                healthy: false,
                error: "Failed to acquire ARM token. Run `az login` to refresh credentials.",
            };
        }
    } catch {
        return {
            healthy: false,
            error: "Failed to acquire ARM token. Network error.",
        };
    }

    // Step 3: Check Batch token
    try {
        const batchRes = await fetch("/api/token/batch");
        if (!batchRes.ok) {
            return {
                healthy: false,
                error: "Failed to acquire Batch token. Ensure your account has Batch service access.",
            };
        }
    } catch {
        return {
            healthy: false,
            error: "Failed to acquire Batch token. Network error.",
        };
    }

    // Step 4: Check subscriptions
    try {
        const subsRes = await fetch("/api/subscriptions");
        if (!subsRes.ok) {
            return {
                healthy: false,
                error: "Failed to list subscriptions. Your account may not have any subscriptions.",
            };
        }
        const subs = await subsRes.json();
        if (!Array.isArray(subs) || subs.length === 0) {
            return {
                healthy: false,
                error: "No Azure subscriptions found. Ensure your account has at least one active subscription.",
            };
        }
    } catch {
        return {
            healthy: false,
            error: "Failed to list subscriptions. Network error.",
        };
    }

    return { healthy: true, error: null };
}

async function loadSubscriptions(store: MultiRegionStore): Promise<void> {
    try {
        const response = await fetch("/api/subscriptions");
        if (!response.ok) return;
        const subs = await response.json();
        store.setSubscriptions(
            subs.map((s: any) => ({
                subscriptionId: s.subscriptionId,
                displayName: s.displayName,
            }))
        );
    } catch {
        /* subscriptions are optional */
    }
}

function createAgentContext(store: MultiRegionStore): AgentContext {
    return {
        store,
        scheduler: new RequestScheduler(DEFAULT_SCHEDULER_OPTIONS),
        armUrl: "https://management.azure.com",
        getAccessToken: getAccessTokenFromCli,
        getBatchAccessToken: getBatchAccessTokenFromCli,
    };
}

function exportSession(store: MultiRegionStore): void {
    const json = store.exportSessionAsJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${store.sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// --- Auth Banner ---

const AuthBanner: React.FC<{
    healthCheck: HealthCheckResult | null;
    onRetry: () => void;
}> = ({ healthCheck, onRetry }) => {
    if (healthCheck === null) {
        return (
            <MessageBar messageBarType={MessageBarType.info}>
                Running health check...
            </MessageBar>
        );
    }
    if (!healthCheck.healthy) {
        return (
            <MessageBar
                messageBarType={MessageBarType.severeWarning}
                isMultiline
                actions={
                    <DefaultButton
                        text="Retry"
                        onClick={onRetry}
                        styles={{
                            root: { height: 28, minWidth: 0 },
                            label: { fontSize: 12 },
                        }}
                    />
                }
            >
                <b>Health check failed.</b> {healthCheck.error}
            </MessageBar>
        );
    }
    return null;
};

// --- Session Bar (compact) ---

const SessionBar: React.FC<{ store: MultiRegionStore }> = ({ store }) => {
    const state = useMultiRegionState();
    const [sessions, setSessions] = React.useState(store.listSessions());
    const refreshSessions = React.useCallback(
        () => setSessions(store.listSessions()),
        [store]
    );

    const sessionOptions: IDropdownOption[] = React.useMemo(
        () =>
            sessions.map((s) => ({
                key: s.id,
                text: `${s.id.substring(0, 22)}... (${s.accountCount}A/${s.quotaCount}Q/${s.poolCount}P)`,
            })),
        [sessions]
    );

    return (
        <Stack
            horizontal
            verticalAlign="center"
            tokens={{ childrenGap: 8 }}
            styles={{
                root: {
                    padding: "3px 12px",
                    background: "#1e1e1e",
                    borderBottom: "1px solid #333",
                    minHeight: 32,
                },
            }}
        >
            <Text
                variant="tiny"
                styles={{
                    root: {
                        color: "#0078d4",
                        fontFamily: "monospace",
                        fontSize: 10,
                        userSelect: "all",
                    },
                }}
            >
                {state.sessionId}
            </Text>
            <Text variant="tiny" styles={{ root: { color: "#555" } }}>
                {state.accounts.length}A / {state.quotaRequests.length}Q /{" "}
                {state.pools.length}P
            </Text>

            <Stack
                horizontal
                tokens={{ childrenGap: 4 }}
                styles={{ root: { marginLeft: "auto" } }}
            >
                <IconButton
                    iconProps={{ iconName: "Save" }}
                    title="Save session"
                    onClick={() => {
                        store.saveSession();
                        refreshSessions();
                        store.addNotification({
                            type: "success",
                            message: "Session saved",
                        });
                    }}
                    styles={{ root: { height: 24, width: 24 } }}
                />
                {sessions.length > 0 && (
                    <Dropdown
                        placeholder="Load..."
                        options={sessionOptions}
                        onChange={(_e, opt) => {
                            if (opt) {
                                store.loadSession(opt.key as string);
                                refreshSessions();
                            }
                        }}
                        styles={{
                            root: { width: 200 },
                            dropdown: { height: 24 },
                            title: {
                                height: 24,
                                lineHeight: "22px",
                                fontSize: 11,
                            },
                            caretDownWrapper: {
                                height: 24,
                                lineHeight: "24px",
                            },
                        }}
                        onRenderTitle={() => (
                            <span style={{ fontSize: 11 }}>
                                Load ({sessions.length})
                            </span>
                        )}
                    />
                )}
                <IconButton
                    iconProps={{ iconName: "Add" }}
                    title="New session"
                    onClick={() => {
                        store.newSession();
                        refreshSessions();
                    }}
                    styles={{ root: { height: 24, width: 24 } }}
                />
                <IconButton
                    iconProps={{ iconName: "Download" }}
                    title="Export session as JSON"
                    onClick={() => exportSession(store)}
                    styles={{ root: { height: 24, width: 24 } }}
                />
                <IconButton
                    iconProps={{ iconName: "Copy" }}
                    title="Copy session ID"
                    onClick={() =>
                        navigator.clipboard?.writeText(state.sessionId)
                    }
                    styles={{ root: { height: 24, width: 24 } }}
                />
            </Stack>
        </Stack>
    );
};

// --- Page Router ---

const PageContent: React.FC<{
    page: PageKey;
    orchestrator: OrchestratorAgent;
    store: MultiRegionStore;
    onNavigate: (key: PageKey) => void;
}> = ({ page, orchestrator, store, onNavigate }) => {
    switch (page) {
        case "overview":
            return (
                <OverviewPage
                    orchestrator={orchestrator}
                    store={store}
                    onNavigate={onNavigate}
                />
            );
        case "accounts":
            return <AccountProvisioningPage orchestrator={orchestrator} />;
        case "quotas":
            return <QuotaRequestsPage orchestrator={orchestrator} />;
        case "quota-status":
            return <QuotaStatusPage orchestrator={orchestrator} />;
        case "pools":
            return <PoolCreationPage orchestrator={orchestrator} />;
        case "pool-info":
            return <PoolInfoPage orchestrator={orchestrator} />;
        case "account-info":
            return <AccountInfoPage orchestrator={orchestrator} />;
        case "nodes":
            return <NodesPage orchestrator={orchestrator} />;
        default:
            return null;
    }
};

// --- Dashboard Content ---

const DashboardContent: React.FC = () => {
    const store = useMultiRegionStore();
    const [healthCheck, setHealthCheck] =
        React.useState<HealthCheckResult | null>(null);
    const [activePage, setActivePage] = React.useState<PageKey>("overview");
    const [sidebarCollapsed, setSidebarCollapsed] = React.useState(
        () => store.getUserPreferences().sidebarCollapsed
    );
    const [autoRefreshEnabled, setAutoRefreshEnabled] = React.useState(true);
    const autoRefreshRunningRef = React.useRef(false);

    const orchestrator = React.useMemo(
        () => new OrchestratorAgent(createAgentContext(store)),
        [store]
    );

    const checkLogin = React.useCallback(async () => {
        setHealthCheck(null);
        const result = await performHealthCheck();
        setHealthCheck(result);
        if (result.healthy) loadSubscriptions(store);
    }, [store]);

    // Auto-save
    React.useEffect(() => store.enableAutoSave(), [store]);

    // Check auth + auto-discover on mount
    React.useEffect(() => {
        checkLogin().then(async () => {
            const prefs = store.getUserPreferences();
            if (
                prefs.lastSubscriptionId &&
                store.getState().accounts.length === 0
            ) {
                try {
                    await orchestrator.execute({
                        action: "discover_accounts",
                        payload: {
                            subscriptionId: prefs.lastSubscriptionId,
                        },
                    });
                    // Chain: refresh pool info then account info after discover
                    await orchestrator.execute({
                        action: "refresh_pool_info",
                        payload: {},
                    });
                    await orchestrator.execute({
                        action: "refresh_account_info",
                        payload: {},
                    });
                } catch {
                    /* silent */
                }
            }
        });
    }, [checkLogin, orchestrator, store]);

    // Periodic auto-refresh (60s interval)
    React.useEffect(() => {
        if (!autoRefreshEnabled) return;

        const interval = setInterval(async () => {
            if (autoRefreshRunningRef.current) return;
            if (store.getState().accounts.length === 0) return;

            autoRefreshRunningRef.current = true;
            try {
                await orchestrator.execute({
                    action: "refresh_pool_info",
                    payload: {},
                });
                await orchestrator.execute({
                    action: "refresh_account_info",
                    payload: {},
                });
            } catch {
                /* silent */
            } finally {
                autoRefreshRunningRef.current = false;
            }
        }, 60000);

        return () => clearInterval(interval);
    }, [autoRefreshEnabled, orchestrator, store]);

    const handleToggleSidebar = React.useCallback(() => {
        setSidebarCollapsed((c) => {
            store.saveUserPreferences({ sidebarCollapsed: !c });
            return !c;
        });
    }, [store]);

    return (
        <div
            style={{ display: "flex", flexDirection: "column", height: "100%" }}
        >
            <SessionBar store={store} />
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 8 }}
                styles={{
                    root: {
                        padding: "2px 12px",
                        background: "#1e1e1e",
                        borderBottom: "1px solid #2a2a2a",
                    },
                }}
            >
                <Toggle
                    label="Auto-refresh (60s)"
                    inlineLabel
                    checked={autoRefreshEnabled}
                    onChange={(_e, checked) =>
                        setAutoRefreshEnabled(checked ?? false)
                    }
                    styles={{
                        root: { marginBottom: 0 },
                        label: { color: "#999", fontSize: 11 },
                    }}
                />
            </Stack>
            <AuthBanner healthCheck={healthCheck} onRetry={checkLogin} />
            <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
                <SidebarNav
                    activeKey={activePage}
                    onNavigate={setActivePage}
                    collapsed={sidebarCollapsed}
                    onToggleCollapse={handleToggleSidebar}
                />
                <div
                    style={{
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        overflow: "hidden",
                    }}
                >
                    {activePage !== "overview" && <GlobalFilterBar />}
                    <div
                        style={{
                            flex: 1,
                            overflow: "auto",
                            padding: "0 16px 16px",
                        }}
                    >
                        <PageContent
                            page={activePage}
                            orchestrator={orchestrator}
                            store={store}
                            onNavigate={setActivePage}
                        />
                    </div>
                </div>
            </div>
            <ActivityPanel />
            <AgentLogPanel />
            <ToastContainer />
        </div>
    );
};

// --- Root ---

export const MultiRegionDashboard: React.FC = () => {
    const [store] = React.useState(() => new MultiRegionStore());

    return (
        <MultiRegionStoreProvider store={store}>
            <ErrorBoundary>
                <DashboardContent />
            </ErrorBoundary>
        </MultiRegionStoreProvider>
    );
};
