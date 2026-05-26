import * as React from "react";
import { MultiRegionStore } from "./multi-region-store";
import { MultiRegionState } from "./store-types";
export interface MultiRegionStoreProviderProps {
    store: MultiRegionStore;
    children: React.ReactNode;
}
export declare const MultiRegionStoreProvider: React.FC<MultiRegionStoreProviderProps>;
export declare function useMultiRegionStore(): MultiRegionStore;
export declare function useMultiRegionState(): MultiRegionState;
/** Only re-renders when the selected slice changes (shallow equality) */
export declare function useMultiRegionSelector<T>(selector: (state: MultiRegionState) => T): T;
/** Memoized dashboard stats */
export declare function useDashboardStats(): {
    totalAccounts: number;
    createdAccounts: number;
    failedAccounts: number;
    totalPools: number;
    createdPools: number;
    failedPools: number;
    totalNodes: number;
    runningNodes: number;
    nonWorkingNodes: number;
};
//# sourceMappingURL=store-context.d.ts.map