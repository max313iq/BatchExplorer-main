import * as React from "react";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { SearchBox } from "@fluentui/react/lib/SearchBox";
import { DefaultButton } from "@fluentui/react/lib/Button";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import {
    useMultiRegionStore,
    useMultiRegionState,
} from "../store/store-context";
import { AZURE_REGIONS } from "./shared/constants";

const stackTokens: IStackTokens = { childrenGap: 12 };

const PROVISIONING_OPTIONS: IDropdownOption[] = [
    { key: "all", text: "All States" },
    { key: "pending", text: "Pending" },
    { key: "creating", text: "Creating" },
    { key: "created", text: "Created" },
    { key: "failed", text: "Failed" },
];

export const GlobalFilterBar: React.FC = () => {
    const store = useMultiRegionStore();
    const state = useMultiRegionState();
    const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
        null
    );

    const regionOptions: IDropdownOption[] = React.useMemo(
        () =>
            AZURE_REGIONS.map((r) => ({
                key: r,
                text: r,
            })),
        []
    );

    const subscriptionOptions: IDropdownOption[] = React.useMemo(
        () =>
            state.subscriptions.map((s) => ({
                key: s.subscriptionId,
                text: s.displayName || s.subscriptionId,
            })),
        [state.subscriptions]
    );

    // Debounced search handler
    const handleSearchChange = React.useCallback(
        (_e: any, value?: string) => {
            if (searchTimerRef.current) {
                clearTimeout(searchTimerRef.current);
            }
            searchTimerRef.current = setTimeout(() => {
                store.setGlobalFilter({
                    searchText: value ?? "",
                });
            }, 300);
        },
        [store]
    );

    // Cleanup debounce timer on unmount
    React.useEffect(() => {
        return () => {
            if (searchTimerRef.current) {
                clearTimeout(searchTimerRef.current);
            }
        };
    }, []);

    // Region multi-select handler
    const handleRegionChange = React.useCallback(
        (_e: any, option?: IDropdownOption) => {
            if (!option) return;
            const current = state.globalFilter.regions;
            const updated = option.selected
                ? [...current, option.key as string]
                : current.filter((r) => r !== option.key);
            store.setGlobalFilter({ regions: updated });
        },
        [store, state.globalFilter.regions]
    );

    // Subscription multi-select handler
    const handleSubscriptionChange = React.useCallback(
        (_e: any, option?: IDropdownOption) => {
            if (!option) return;
            const current = state.globalFilter.subscriptionIds;
            const updated = option.selected
                ? [...current, option.key as string]
                : current.filter((s) => s !== option.key);
            store.setGlobalFilter({ subscriptionIds: updated });
        },
        [store, state.globalFilter.subscriptionIds]
    );

    const handleProvisioningStateChange = React.useCallback(
        (_e: any, option?: IDropdownOption) => {
            if (option) {
                store.setGlobalFilter({
                    provisioningState: option.key as any,
                });
            }
        },
        [store]
    );

    // Clear all filters to defaults
    const handleClearFilters = React.useCallback(() => {
        store.setGlobalFilter({
            regions: [],
            subscriptionIds: [],
            provisioningState: "all",
            searchText: "",
        });
    }, [store]);

    // Show clear-affordances only when at least one filter is active.
    const hasActiveFilter = React.useMemo(() => {
        const f = state.globalFilter;
        return (
            (f.regions && f.regions.length > 0) ||
            (f.subscriptionIds && f.subscriptionIds.length > 0) ||
            (f.provisioningState && f.provisioningState !== "all") ||
            (f.searchText && f.searchText.length > 0)
        );
    }, [state.globalFilter]);

    // TODO(persist): persist globalFilter via store action so refresh keeps state.
    // The store currently exposes only setGlobalFilter(patch); adding a dedicated
    // persistence action / localStorage hydration is out of this file's scope.
    // TODO(presets): allow saving the active filter as a named preset (cross-cutting).

    return (
        <div
            role="region"
            aria-label="Global filter bar"
            style={{
                padding: "12px 16px",
                backgroundColor: "#f3f2f1",
                borderBottom: "1px solid #edebe9",
            }}
        >
            <Stack horizontal tokens={stackTokens} wrap verticalAlign="end">
                <Dropdown
                    placeholder="Filter by region"
                    label="Regions"
                    ariaLabel="Filter by Azure region"
                    multiSelect
                    options={regionOptions}
                    selectedKeys={state.globalFilter.regions}
                    onChange={handleRegionChange}
                    styles={{ dropdown: { width: 200 } }}
                />
                <Dropdown
                    placeholder="Filter by subscription"
                    label="Subscriptions"
                    ariaLabel="Filter by subscription"
                    multiSelect
                    options={subscriptionOptions}
                    selectedKeys={state.globalFilter.subscriptionIds}
                    onChange={handleSubscriptionChange}
                    styles={{ dropdown: { width: 220 } }}
                />
                <Dropdown
                    placeholder="Account state"
                    label="Account State"
                    ariaLabel="Filter by account provisioning state"
                    options={PROVISIONING_OPTIONS}
                    selectedKey={state.globalFilter.provisioningState}
                    onChange={handleProvisioningStateChange}
                    styles={{ dropdown: { width: 150 } }}
                />
                <SearchBox
                    placeholder="Search accounts..."
                    ariaLabel="Search accounts by text"
                    defaultValue={state.globalFilter.searchText}
                    onChange={handleSearchChange}
                    styles={{ root: { width: 200, marginTop: 22 } }}
                />
                {hasActiveFilter && (
                    <DefaultButton
                        text="Clear all filters"
                        ariaLabel="Clear all active filters"
                        title="Clear all active filters"
                        iconProps={{ iconName: "ClearFilter" }}
                        onClick={handleClearFilters}
                        styles={{ root: { marginTop: 22 } }}
                    />
                )}
            </Stack>
        </div>
    );
};
