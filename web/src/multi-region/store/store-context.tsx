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
        // Sync in case store changed between render and effect
        setState(store.getState());
        return unsubscribe;
    }, [store]);

    return state;
}
