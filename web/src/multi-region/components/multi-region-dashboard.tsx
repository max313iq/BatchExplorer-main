import * as React from "react";
import { Pivot, PivotItem } from "@fluentui/react/lib/Pivot";
import {
    MultiRegionStoreProvider,
    useMultiRegionStore,
} from "../store/store-context";
import { MultiRegionStore } from "../store/multi-region-store";
import { RequestScheduler } from "../scheduling/request-scheduler";
import { OrchestratorAgent } from "../agents/orchestrator-agent";
import { AgentContext } from "../agents/agent-types";
import { GlobalFilterBar } from "./global-filter-bar";
import { AccountProvisioningPage } from "./account-provisioning/account-provisioning-page";
import { QuotaRequestsPage } from "./quota-requests/quota-requests-page";
import { QuotaStatusPage } from "./quota-status/quota-status-page";
import { PoolCreationPage } from "./pool-creation/pool-creation-page";
import { AgentLogPanel } from "./shared/agent-log-panel";

// Default throttling config for multi-region operations
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

let _cachedToken: CachedToken | null = null;

async function getAccessTokenFromCli(): Promise<string> {
    // Return cached token if still valid (with 2-minute buffer)
    if (_cachedToken) {
        const expiresAt = new Date(_cachedToken.expiresOn).getTime();
        if (Date.now() < expiresAt - 2 * 60 * 1000) {
            return _cachedToken.accessToken;
        }
        _cachedToken = null;
    }

    const response = await fetch("/api/token");
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(
            err?.error ??
                "Failed to get Azure token. Run 'az login' in your terminal."
        );
    }

    const data = await response.json();
    _cachedToken = {
        accessToken: data.accessToken,
        expiresOn: data.expiresOn,
    };
    return data.accessToken;
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
        // Silently ignore — subscriptions are optional for the filter bar
    }
}

function createAgentContext(store: MultiRegionStore): AgentContext {
    const scheduler = new RequestScheduler(DEFAULT_SCHEDULER_OPTIONS);

    return {
        store,
        scheduler,
        armUrl: "https://management.azure.com",
        getAccessToken: getAccessTokenFromCli,
    };
}

const DashboardContent: React.FC = () => {
    const store = useMultiRegionStore();

    const orchestrator = React.useMemo(() => {
        const ctx = createAgentContext(store);
        return new OrchestratorAgent(ctx);
    }, [store]);

    // Auto-load subscriptions from Azure CLI on mount
    React.useEffect(() => {
        loadSubscriptions(store);
    }, [store]);

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                height: "100%",
            }}
        >
            <GlobalFilterBar />
            <div style={{ flex: 1, overflow: "auto" }}>
                <Pivot
                    styles={{
                        root: { padding: "0 16px" },
                    }}
                >
                    <PivotItem
                        headerText="Account Provisioning"
                        itemIcon="ServerProcesses"
                    >
                        <AccountProvisioningPage orchestrator={orchestrator} />
                    </PivotItem>
                    <PivotItem
                        headerText="Quota Requests"
                        itemIcon="AllCurrency"
                    >
                        <QuotaRequestsPage orchestrator={orchestrator} />
                    </PivotItem>
                    <PivotItem headerText="Quota Status" itemIcon="Diagnostic">
                        <QuotaStatusPage orchestrator={orchestrator} />
                    </PivotItem>
                    <PivotItem headerText="Pool Creation" itemIcon="BuildQueue">
                        <PoolCreationPage orchestrator={orchestrator} />
                    </PivotItem>
                </Pivot>
            </div>
            <AgentLogPanel />
        </div>
    );
};

export const MultiRegionDashboard: React.FC = () => {
    const [store] = React.useState(() => new MultiRegionStore());

    return (
        <MultiRegionStoreProvider store={store}>
            <DashboardContent />
        </MultiRegionStoreProvider>
    );
};
