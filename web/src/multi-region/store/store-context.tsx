import * as React from "react";
import { MultiRegionStore } from "./multi-region-store";
import { MultiRegionState } from "./store-types";

const StoreContext = React.createContext<MultiRegionStore | null>(null);

export interface MultiRegionStoreProviderProps {
    store: MultiRegionStore;
    children: React.ReactNode;
}

export const MultiRegionStoreProvider: React.FC<
    MultiRegionStoreProviderProps
> = ({ store, children }) => {
    return (
        <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    );
};

export function useMultiRegionStore(): MultiRegionStore {
    const store = React.useContext(StoreContext);
    if (!store) {
        throw new Error(
            "useMultiRegionStore must be used within a <MultiRegionStoreProvider>"
        );
    }
    return store;
}

export function useMultiRegionState(): MultiRegionState {
    const store = useMultiRegionStore();
    const [state, setState] = React.useState<MultiRegionState>(
        store.getState()
    );

    React.useEffect(() => {
        const unsubscribe = store.onChange(() => {
            setState(store.getState());
        });
        setState(store.getState());
        return unsubscribe;
    }, [store]);

    return state;
}

/** Only re-renders when the selected slice changes (shallow equality) */
export function useMultiRegionSelector<T>(
    selector: (state: MultiRegionState) => T
): T {
    const store = useMultiRegionStore();
    const selectorRef = React.useRef(selector);
    selectorRef.current = selector;

    const [value, setValue] = React.useState(() => selector(store.getState()));

    React.useEffect(() => {
        return store.onChange(() => {
            const next = selectorRef.current(store.getState());
            setValue((prev) => (prev === next ? prev : next));
        });
    }, [store]);

    return value;
}

/** Memoized dashboard stats */
export function useDashboardStats() {
    const state = useMultiRegionState();
    return React.useMemo(() => {
        const accounts = state.accounts;
        const quotas = state.quotaRequests;
        const pools = state.pools;
        const nodes = state.nodes;
        return {
            totalAccounts: accounts.length,
            createdAccounts: accounts.filter(
                (a) => a.provisioningState === "created"
            ).length,
            failedAccounts: accounts.filter(
                (a) => a.provisioningState === "failed"
            ).length,
            pendingQuotas: quotas.filter(
                (q) => q.status === "pending" || q.status === "submitted"
            ).length,
            approvedQuotas: quotas.filter((q) => q.status === "approved")
                .length,
            deniedQuotas: quotas.filter((q) => q.status === "denied").length,
            failedQuotas: quotas.filter((q) => q.status === "failed").length,
            totalPools: pools.length,
            createdPools: pools.filter((p) => p.provisioningState === "created")
                .length,
            failedPools: pools.filter((p) => p.provisioningState === "failed")
                .length,
            totalNodes: nodes.length,
            nonWorkingNodes: nodes.filter(
                (n) =>
                    n.state === "unusable" ||
                    n.state === "starttaskfailed" ||
                    n.state === "offline" ||
                    n.state === "unknown" ||
                    n.state === "preempted"
            ).length,
        };
    }, [state.accounts, state.quotaRequests, state.pools, state.nodes]);
}
