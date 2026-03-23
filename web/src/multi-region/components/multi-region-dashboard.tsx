import * as React from "react";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { DefaultButton, IconButton } from "@fluentui/react/lib/Button";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
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
import { AgentLogPanel } from "./shared/agent-log-panel";

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

async function checkAuthStatus(): Promise<boolean> {
    try {
        const res = await fetch("/api/auth/status");
        if (!res.ok) return false;
        const data = await res.json();
        return data.loggedIn === true;
    } catch {
        return false;
    }
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
    loggedIn: boolean | null;
    onRetry: () => void;
}> = ({ loggedIn, onRetry }) => {
    if (loggedIn === null) {
        return (
            <MessageBar messageBarType={MessageBarType.info}>
                Checking Azure CLI login status...
            </MessageBar>
        );
    }
    if (!loggedIn) {
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
                <b>Azure CLI not logged in.</b> Run{" "}
                <code
                    style={{
                        background: "#333",
                        padding: "2px 6px",
                        borderRadius: 3,
                        color: "#eee",
                    }}
                >
                    az login
                </code>{" "}
                then click Retry.
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
        case "nodes":
            return <NodesPage orchestrator={orchestrator} />;
        default:
            return null;
    }
};

// --- Dashboard Content ---

const DashboardContent: React.FC = () => {
    const store = useMultiRegionStore();
    const [loggedIn, setLoggedIn] = React.useState<boolean | null>(null);
    const [activePage, setActivePage] = React.useState<PageKey>("overview");
    const [sidebarCollapsed, setSidebarCollapsed] = React.useState(
        () => store.getUserPreferences().sidebarCollapsed
    );

    const orchestrator = React.useMemo(
        () => new OrchestratorAgent(createAgentContext(store)),
        [store]
    );

    const checkLogin = React.useCallback(async () => {
        setLoggedIn(null);
        const ok = await checkAuthStatus();
        setLoggedIn(ok);
        if (ok) loadSubscriptions(store);
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
                } catch {
                    /* silent */
                }
            }
        });
    }, [checkLogin, orchestrator, store]);

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
            <AuthBanner loggedIn={loggedIn} onRetry={checkLogin} />
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
