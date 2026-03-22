import * as React from "react";
import { PrimaryButton } from "@fluentui/react/lib/Button";
import { Dropdown, IDropdownOption } from "@fluentui/react/lib/Dropdown";
import { TextField } from "@fluentui/react/lib/TextField";
import {
    DetailsList,
    DetailsListLayoutMode,
    IColumn,
    SelectionMode,
} from "@fluentui/react/lib/DetailsList";
import { ProgressIndicator } from "@fluentui/react/lib/ProgressIndicator";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import { useMultiRegionState } from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";

const AZURE_REGIONS = [
    "eastus",
    "eastus2",
    "westus",
    "westus2",
    "westus3",
    "centralus",
    "northcentralus",
    "southcentralus",
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
    "centralindia",
    "southindia",
    "brazilsouth",
    "southafricanorth",
    "uaenorth",
];

const stackTokens: IStackTokens = { childrenGap: 12 };

interface AccountProvisioningPageProps {
    orchestrator: OrchestratorAgent;
}

export const AccountProvisioningPage: React.FC<
    AccountProvisioningPageProps
> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [selectedRegions, setSelectedRegions] = React.useState<string[]>([]);
    const [subscriptionId, setSubscriptionId] = React.useState("");
    const [isRunning, setIsRunning] = React.useState(false);

    const regionOptions: IDropdownOption[] = React.useMemo(
        () => AZURE_REGIONS.map((r) => ({ key: r, text: r })),
        []
    );

    const handleCreate = React.useCallback(async () => {
        if (!subscriptionId || selectedRegions.length === 0) return;
        setIsRunning(true);
        try {
            await orchestrator.execute({
                action: "create_accounts",
                payload: {
                    subscriptionId,
                    regions: selectedRegions,
                },
            });
        } finally {
            setIsRunning(false);
        }
    }, [orchestrator, subscriptionId, selectedRegions]);

    const columns: IColumn[] = [
        {
            key: "region",
            name: "Region",
            fieldName: "region",
            minWidth: 120,
            maxWidth: 180,
        },
        {
            key: "accountName",
            name: "Account Name",
            fieldName: "accountName",
            minWidth: 160,
            maxWidth: 240,
        },
        {
            key: "resourceGroup",
            name: "Resource Group",
            fieldName: "resourceGroup",
            minWidth: 200,
            maxWidth: 300,
        },
        {
            key: "status",
            name: "Status",
            minWidth: 100,
            maxWidth: 120,
            onRender: (item) => <StatusBadge status={item.provisioningState} />,
        },
        {
            key: "error",
            name: "Error",
            fieldName: "error",
            minWidth: 200,
            onRender: (item) =>
                item.error ? (
                    <span style={{ color: "#a80000", fontSize: "12px" }}>
                        {item.error}
                    </span>
                ) : null,
        },
    ];

    const createdCount = state.accounts.filter(
        (a) => a.provisioningState === "created"
    ).length;
    const failedCount = state.accounts.filter(
        (a) => a.provisioningState === "failed"
    ).length;
    const totalCount = state.accounts.length;

    return (
        <div style={{ padding: "16px" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: "20px" }}>
                Account Provisioning
            </h2>

            <Stack tokens={stackTokens}>
                {state.subscriptions.length > 0 ? (
                    <Dropdown
                        label="Subscription"
                        placeholder="Select subscription"
                        options={state.subscriptions.map((s) => ({
                            key: s.subscriptionId,
                            text: `${s.displayName} (${s.subscriptionId.substring(0, 8)}...)`,
                        }))}
                        selectedKey={subscriptionId || undefined}
                        onChange={(_e, o) =>
                            o && setSubscriptionId(o.key as string)
                        }
                        styles={{ dropdown: { maxWidth: 450 } }}
                    />
                ) : (
                    <TextField
                        label="Subscription ID"
                        value={subscriptionId}
                        onChange={(_e, v) => setSubscriptionId(v ?? "")}
                        placeholder="Enter Azure subscription ID (run 'az login' to auto-load)"
                        styles={{ root: { maxWidth: 450 } }}
                    />
                )}
                <Dropdown
                    label="Regions (select up to 20)"
                    placeholder="Select regions"
                    multiSelect
                    options={regionOptions}
                    selectedKeys={selectedRegions}
                    onChange={(_e, option) => {
                        if (!option) return;
                        setSelectedRegions((prev) =>
                            option.selected
                                ? [...prev, option.key as string]
                                : prev.filter((r) => r !== option.key)
                        );
                    }}
                    styles={{ dropdown: { maxWidth: 450 } }}
                />

                {selectedRegions.length > 20 && (
                    <MessageBar messageBarType={MessageBarType.warning}>
                        Maximum 20 regions recommended
                    </MessageBar>
                )}

                <PrimaryButton
                    text={
                        isRunning
                            ? "Creating..."
                            : `Create ${selectedRegions.length} Accounts`
                    }
                    disabled={
                        isRunning ||
                        !subscriptionId ||
                        selectedRegions.length === 0
                    }
                    onClick={handleCreate}
                    styles={{ root: { maxWidth: 250 } }}
                />
            </Stack>

            {isRunning && (
                <ProgressIndicator
                    label={`Creating accounts... ${createdCount + failedCount}/${totalCount > 0 ? totalCount : selectedRegions.length}`}
                    percentComplete={
                        totalCount > 0
                            ? (createdCount + failedCount) / totalCount
                            : undefined
                    }
                    styles={{ root: { marginTop: 16 } }}
                />
            )}

            {state.accounts.length > 0 && (
                <div style={{ marginTop: 16 }}>
                    <div
                        style={{
                            fontSize: "13px",
                            marginBottom: 8,
                            color: "#605e5c",
                        }}
                    >
                        {createdCount} created, {failedCount} failed,{" "}
                        {totalCount - createdCount - failedCount} in progress
                    </div>
                    <DetailsList
                        items={state.accounts}
                        columns={columns}
                        layoutMode={DetailsListLayoutMode.justified}
                        selectionMode={SelectionMode.none}
                        compact
                    />
                </div>
            )}
        </div>
    );
};
