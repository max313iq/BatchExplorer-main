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
import { UnusedQuotaPage } from "./unused-quota/unused-quota-page";
import { AzureAccountsPage } from "./azure-accounts/azure-accounts-page";
import { MonitoringPage } from "./monitoring/monitoring-page";
import { SupportTicketPage } from "./support-ticket/support-ticket-page";
import { AgentLogPanel } from "./shared/agent-log-panel";
import { ActivityPanel } from "./shared/activity-panel";
import * as msalAuth from "../auth/msal-auth";

// Auth mode: always MSAL (Entra ID) — no CLI proxy fallback
let _authMode: "msal" | "cli" = "msal";

const DEFAULT_SCHEDULER_OPTIONS = {
    concurrency: 1,
    delayMs: 2000,
    retryAttempts: 5,
    retryBackoffSeconds: [2, 4, 8, 16, 32],
    jitterPct: 0.2,
    maxQueueSize: 100,
};

async function getAccessTokenFromCli(tenantId?: string): Promise<string> {
    return msalAuth.getArmToken(tenantId);
}

async function getBatchAccessTokenFromCli(tenantId?: string): Promise<string> {
    return msalAuth.getBatchToken(tenantId);
}

export interface HealthCheckResult {
    healthy: boolean;
    error: string | null;
}

/**
 * Optional token provider that, when supplied, overrides the proxy-based
 * token fetching. This allows the desktop Electron app to inject its own
 * MSAL-based auth without needing a dev server proxy.
 */
export interface TokenProvider {
    getAccessToken: () => Promise<string>;
    getBatchAccessToken: () => Promise<string>;
    checkHealth: () => Promise<HealthCheckResult>;
    loadSubscriptions: (store: MultiRegionStore) => Promise<void>;
}

export interface MultiRegionDashboardProps {
    tokenProvider?: TokenProvider;
}

async function performHealthCheck(
    tokenProvider?: TokenProvider
): Promise<HealthCheckResult> {
    // Desktop mode: delegate entirely to the injected token provider
    if (tokenProvider) {
        return tokenProvider.checkHealth();
    }

    // Web mode: MSAL popup auth — check for active user first
    try {
        const user = await msalAuth.getCurrentUser();
        if (!user) {
            return {
                healthy: false,
                error: "Not signed in. Click 'Sign in with Azure' to authenticate via Entra ID.",
            };
        }
        // User exists — try to get tokens silently
        const armToken = await msalAuth.getArmToken();
        if (!armToken)
            return { healthy: false, error: "Failed to acquire ARM token." };
        const batchToken = await msalAuth.getBatchToken();
        if (!batchToken)
            return { healthy: false, error: "Failed to acquire Batch token." };
        // Attempt to list subscriptions, but an empty list is NOT a failure
        // as long as the user is authenticated and tokens are valid.
        try {
            await msalAuth.listSubscriptions();
        } catch {
            // Subscription listing is best-effort; auth is still healthy
        }
        return { healthy: true, error: null };
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (msg.includes("Not signed in") || msg.includes("no_account")) {
            return {
                healthy: false,
                error: "Not signed in. Click 'Sign in with Azure' to authenticate via Entra ID.",
            };
        }
        return { healthy: false, error: msg };
    }
}

async function loadSubscriptions(store: MultiRegionStore): Promise<void> {
    try {
        const subs = await msalAuth.listSubscriptions();
        store.setSubscriptions(subs);
    } catch {
        /* subscriptions are optional */
    }
}

function createAgentContext(
    store: MultiRegionStore,
    tokenProvider?: TokenProvider
): AgentContext {
    return {
        store,
        scheduler: new RequestScheduler(DEFAULT_SCHEDULER_OPTIONS),
        armUrl: "https://management.azure.com",
        getAccessToken: tokenProvider?.getAccessToken ?? getAccessTokenFromCli,
        getBatchAccessToken:
            tokenProvider?.getBatchAccessToken ?? getBatchAccessTokenFromCli,
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
    onLogin?: () => void;
    onLogout?: () => void;
    authMode?: "msal" | "cli";
    userName?: string;
}> = ({ healthCheck, onRetry, onLogin, onLogout, authMode, userName }) => {
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
                    <Stack horizontal tokens={{ childrenGap: 8 }}>
                        {onLogin && (
                            <DefaultButton
                                text="Sign in with Azure"
                                iconProps={{ iconName: "AzureLogo" }}
                                onClick={onLogin}
                                styles={{
                                    root: {
                                        height: 28,
                                        minWidth: 0,
                                        backgroundColor: "#0078d4",
                                        color: "white",
                                        border: "none",
                                    },
                                    label: { fontSize: 12, color: "white" },
                                    icon: { color: "white" },
                                    rootHovered: {
                                        backgroundColor: "#106ebe",
                                        color: "white",
                                    },
                                }}
                            />
                        )}
                        <DefaultButton
                            text="Retry"
                            onClick={onRetry}
                            styles={{
                                root: { height: 28, minWidth: 0 },
                                label: { fontSize: 12 },
                            }}
                        />
                    </Stack>
                }
            >
                <b>Health check failed.</b> {healthCheck.error}
            </MessageBar>
        );
    }
    // Authenticated — show user info
    if (authMode === "msal" && userName) {
        return (
            <MessageBar
                messageBarType={MessageBarType.success}
                actions={
                    onLogout ? (
                        <DefaultButton
                            text="Sign out"
                            onClick={onLogout}
                            styles={{
                                root: { height: 24, minWidth: 0 },
                                label: { fontSize: 11 },
                            }}
                        />
                    ) : undefined
                }
            >
                Signed in as <b>{userName}</b> via Entra ID
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
        case "azure-accounts":
            return <AzureAccountsPage />;
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
        case "unused-quota":
            return (
                <UnusedQuotaPage
                    orchestrator={orchestrator}
                    onNavigate={onNavigate as (key: string) => void}
                />
            );
        case "monitoring":
            return <MonitoringPage orchestrator={orchestrator} />;
        case "support-tickets":
            return <SupportTicketPage orchestrator={orchestrator} />;
        case "nodes":
            return <NodesPage orchestrator={orchestrator} />;
        default:
            return null;
    }
};

// --- Dashboard Content ---

const DashboardContent: React.FC<{ tokenProvider?: TokenProvider }> = ({
    tokenProvider,
}) => {
    const store = useMultiRegionStore();
    const [healthCheck, setHealthCheck] =
        React.useState<HealthCheckResult | null>(null);
    const [activePage, setActivePage] =
        React.useState<PageKey>("azure-accounts");
    const [sidebarCollapsed, setSidebarCollapsed] = React.useState(
        () => store.getUserPreferences().sidebarCollapsed
    );
    const [autoRefreshEnabled, setAutoRefreshEnabled] = React.useState(true);
    const autoRefreshRunningRef = React.useRef(false);
    const [currentAuthMode, setCurrentAuthMode] = React.useState<
        "msal" | "cli"
    >(_authMode);
    const [msalUserName, setMsalUserName] = React.useState<string>("");

    const orchestrator = React.useMemo(
        () => new OrchestratorAgent(createAgentContext(store, tokenProvider)),
        [store, tokenProvider]
    );

    const checkLogin = React.useCallback(async () => {
        setHealthCheck(null);
        const result = await performHealthCheck(tokenProvider);
        setHealthCheck(result);
        if (result.healthy) {
            if (tokenProvider) {
                await tokenProvider.loadSubscriptions(store);
            } else {
                await loadSubscriptions(store);
            }
        }
        return result;
    }, [store, tokenProvider]);

    // After login: sync all MSAL accounts + their subscriptions into store.azureAccounts
    // so the Azure Accounts page reflects the new account without needing a manual refresh.
    const syncAccountsToStore = React.useCallback(async () => {
        try {
            const msalAccounts = await msalAuth.getAllLoggedInAccounts();
            if (msalAccounts.length === 0) return;
            // Create loading-state entries first so the UI shows immediately
            store.setAzureAccounts(
                msalAccounts.map((acct) => ({
                    homeAccountId: acct.homeAccountId,
                    username: acct.username ?? "",
                    name: acct.name ?? acct.username ?? "",
                    tenantId: acct.tenantId ?? "",
                    environment: acct.environment ?? "",
                    subscriptions: [],
                    subscriptionCount: 0,
                    status: "loading" as const,
                    error: null,
                    addedAt: new Date().toISOString(),
                }))
            );
            // Load subscriptions per account (parallel, best-effort)
            await Promise.allSettled(
                msalAccounts.map(async (acct) => {
                    try {
                        const subs = await msalAuth.listSubscriptionsForAccount(
                            acct.homeAccountId
                        );
                        store.updateAzureAccount(acct.homeAccountId, {
                            subscriptions: subs as any,
                            subscriptionCount: subs.length,
                            status: "active",
                            error: null,
                        });
                    } catch (err: any) {
                        store.updateAzureAccount(acct.homeAccountId, {
                            status: "error",
                            error:
                                err?.message ?? "Failed to load subscriptions",
                        });
                    }
                })
            );
        } catch {
            // Best-effort — Azure Accounts page has its own Refresh button
        }
    }, [store]);

    // Azure login via MSAL popup
    const handleLogin = React.useCallback(async () => {
        try {
            const account = await msalAuth.login();
            if (account) {
                _authMode = "msal";
                setCurrentAuthMode("msal");
                setMsalUserName(
                    account.username ?? account.name ?? "Azure User"
                );
            }
        } catch (e: any) {
            // Popup might have closed/timed out — don't show error yet
            console.warn(
                "[MSAL] Popup closed/error, checking if auth succeeded anyway:",
                e?.message
            );
        }
        // Re-check auth after popup attempt (even if it threw)
        await new Promise((r) => setTimeout(r, 500));
        const result = await checkLogin();
        if (!result?.healthy) {
            const user = await msalAuth.getCurrentUser();
            if (user) {
                _authMode = "msal";
                setCurrentAuthMode("msal");
                setMsalUserName(user.username ?? user.name ?? "Azure User");
                await checkLogin();
            }
        }
        // Sync logged-in accounts into store so Azure Accounts page updates
        await syncAccountsToStore();
    }, [checkLogin, syncAccountsToStore]);

    // Logout
    const handleLogout = React.useCallback(async () => {
        try {
            await msalAuth.logout();
            _authMode = "cli";
            setCurrentAuthMode("cli");
            setMsalUserName("");
            setHealthCheck(null);
        } catch {
            /* ignore logout errors */
        }
    }, []);

    // Wait for MSAL to process any redirect, THEN check auth
    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            // getCurrentUser() triggers getMsalInstance() which processes
            // the redirect hash. Must complete before health check.
            const user = await msalAuth.getCurrentUser();
            if (cancelled) return;
            if (user) {
                _authMode = "msal";
                setCurrentAuthMode("msal");
                setMsalUserName(user.username ?? user.name ?? "Azure User");
            }
            // Now run the health check (MSAL is fully initialized)
            await checkLogin();
        })();
        return () => {
            cancelled = true;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-save
    React.useEffect(() => store.enableAutoSave(), [store]);

    // Auto-discover ALL resources ONLY after successful auth
    React.useEffect(() => {
        if (!healthCheck?.healthy) return;
        let cancelled = false;
        (async () => {
            try {
                await orchestrator.execute({
                    action: "discover_accounts",
                    payload: {},
                });
                if (cancelled) return;
                await Promise.all([
                    orchestrator.execute({
                        action: "refresh_pool_info",
                        payload: {},
                    }),
                    orchestrator.execute({
                        action: "refresh_account_info",
                        payload: {},
                    }),
                ]);
                if (cancelled) return;
                if (store.getState().poolInfos.length > 0) {
                    await orchestrator.execute({
                        action: "list_nodes",
                        payload: {},
                    });
                }
            } catch {
                /* logged by agents */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [healthCheck?.healthy, orchestrator, store]);

    // Periodic auto-refresh (60s interval)
    React.useEffect(() => {
        if (!autoRefreshEnabled) return;

        const interval = setInterval(async () => {
            if (autoRefreshRunningRef.current) return;
            if (store.getState().accounts.length === 0) return;

            autoRefreshRunningRef.current = true;
            try {
                // Parallel: pools + accounts
                await Promise.all([
                    orchestrator.execute({
                        action: "refresh_pool_info",
                        payload: {},
                    }),
                    orchestrator.execute({
                        action: "refresh_account_info",
                        payload: {},
                    }),
                ]);
                // Then nodes
                if (store.getState().poolInfos.length > 0) {
                    await orchestrator.execute({
                        action: "list_nodes",
                        payload: {},
                    });
                }
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
            <AuthBanner
                healthCheck={healthCheck}
                onRetry={checkLogin}
                onLogin={!tokenProvider ? handleLogin : undefined}
                onLogout={currentAuthMode === "msal" ? handleLogout : undefined}
                authMode={currentAuthMode}
                userName={msalUserName}
            />
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

export const MultiRegionDashboard: React.FC<MultiRegionDashboardProps> = ({
    tokenProvider,
}) => {
    const [store] = React.useState(() => new MultiRegionStore());

    return (
        <MultiRegionStoreProvider store={store}>
            <ErrorBoundary>
                <DashboardContent tokenProvider={tokenProvider} />
            </ErrorBoundary>
        </MultiRegionStoreProvider>
    );
};
