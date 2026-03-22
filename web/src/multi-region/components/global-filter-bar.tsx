import * as React from "react";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { SearchBox } from "@fluentui/react/lib/SearchBox";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import {
    useMultiRegionStore,
    useMultiRegionState,
} from "../store/store-context";

const AZURE_REGIONS = [
    "eastus",
    "eastus2",
    "westus",
    "westus2",
    "westus3",
    "centralus",
    "northcentralus",
    "southcentralus",
    "westcentralus",
    "canadacentral",
    "canadaeast",
    "northeurope",
    "westeurope",
    "uksouth",
    "ukwest",
    "francecentral",
    "germanywestcentral",
    "switzerlandnorth",
    "norwayeast",
    "swedencentral",
    "southeastasia",
    "eastasia",
    "japaneast",
    "japanwest",
    "koreacentral",
    "koreasouth",
    "australiaeast",
    "australiasoutheast",
    "australiacentral",
    "centralindia",
    "southindia",
    "westindia",
    "brazilsouth",
    "brazilsoutheast",
    "southafricanorth",
    "uaenorth",
    "qatarcentral",
    "polandcentral",
    "italynorth",
];

const stackTokens: IStackTokens = { childrenGap: 12 };

export const GlobalFilterBar: React.FC = () => {
    const store = useMultiRegionStore();
    const state = useMultiRegionState();

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

    const statusOptions: IDropdownOption[] = [
        { key: "all", text: "All Statuses" },
        { key: "pending", text: "Pending" },
        { key: "submitted", text: "Submitted" },
        { key: "approved", text: "Approved" },
        { key: "denied", text: "Denied" },
    ];

    const provisioningOptions: IDropdownOption[] = [
        { key: "all", text: "All States" },
        { key: "pending", text: "Pending" },
        { key: "creating", text: "Creating" },
        { key: "created", text: "Created" },
        { key: "failed", text: "Failed" },
    ];

    return (
        <div
            style={{
                padding: "12px 16px",
                backgroundColor: "#f3f2f1",
                borderBottom: "1px solid #edebe9",
            }}
        >
            <Stack horizontal tokens={stackTokens} wrap>
                <Dropdown
                    placeholder="Filter by region"
                    label="Regions"
                    multiSelect
                    options={regionOptions}
                    selectedKeys={state.globalFilter.regions}
                    onChange={(_e, option) => {
                        if (!option) return;
                        const current = state.globalFilter.regions;
                        const updated = option.selected
                            ? [...current, option.key as string]
                            : current.filter((r) => r !== option.key);
                        store.setGlobalFilter({ regions: updated });
                    }}
                    styles={{ dropdown: { width: 200 } }}
                />
                <Dropdown
                    placeholder="Filter by subscription"
                    label="Subscriptions"
                    multiSelect
                    options={subscriptionOptions}
                    selectedKeys={state.globalFilter.subscriptionIds}
                    onChange={(_e, option) => {
                        if (!option) return;
                        const current = state.globalFilter.subscriptionIds;
                        const updated = option.selected
                            ? [...current, option.key as string]
                            : current.filter((s) => s !== option.key);
                        store.setGlobalFilter({
                            subscriptionIds: updated,
                        });
                    }}
                    styles={{ dropdown: { width: 220 } }}
                />
                <Dropdown
                    placeholder="Quota status"
                    label="Quota Status"
                    options={statusOptions}
                    selectedKey={state.globalFilter.quotaStatus}
                    onChange={(_e, option) => {
                        if (option) {
                            store.setGlobalFilter({
                                quotaStatus: option.key as any,
                            });
                        }
                    }}
                    styles={{ dropdown: { width: 150 } }}
                />
                <Dropdown
                    placeholder="Account state"
                    label="Account State"
                    options={provisioningOptions}
                    selectedKey={state.globalFilter.provisioningState}
                    onChange={(_e, option) => {
                        if (option) {
                            store.setGlobalFilter({
                                provisioningState: option.key as any,
                            });
                        }
                    }}
                    styles={{ dropdown: { width: 150 } }}
                />
                <SearchBox
                    placeholder="Search accounts..."
                    value={state.globalFilter.searchText}
                    onChange={(_e, value) => {
                        store.setGlobalFilter({
                            searchText: value ?? "",
                        });
                    }}
                    styles={{ root: { width: 200, marginTop: 22 } }}
                />
            </Stack>
        </div>
    );
};
