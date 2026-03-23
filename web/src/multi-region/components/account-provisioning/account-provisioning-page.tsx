import * as React from "react";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
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
import { Pivot, PivotItem } from "@fluentui/react/lib/Pivot";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { ManagedAccount } from "../../store/store-types";

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
    const store = useMultiRegionStore();
    const [selectedRegions, setSelectedRegions] = React.useState<string[]>([]);
    const [subscriptionId, setSubscriptionId] = React.useState("");
    const [isRunning, setIsRunning] = React.useState(false);
    const [isDiscovering, setIsDiscovering] = React.useState(false);
    const [discoverError, setDiscoverError] = React.useState<string | null>(
        null
    );
    const [discoveredAccounts, setDiscoveredAccounts] = React.useState<
        ManagedAccount[]
    >([]);

    // Pre-fill from user preferences on mount
    React.useEffect(() => {
        const prefs = store.getUserPreferences();
        if (prefs.lastSubscriptionId) {
            setSubscriptionId(prefs.lastSubscriptionId);
        }
        if (prefs.lastRegions && prefs.lastRegions.length > 0) {
            setSelectedRegions(prefs.lastRegions);
        }
    }, [store]);

    // Save subscription preference when it changes
    const handleSubscriptionChange = React.useCallback(
        (newValue: string) => {
            setSubscriptionId(newValue);
            store.saveUserPreferences({ lastSubscriptionId: newValue });
        },
        [store]
    );

    // Save regions preference when they change
    const handleRegionsChange = React.useCallback(
        (newRegions: string[]) => {
            setSelectedRegions(newRegions);
            store.saveUserPreferences({ lastRegions: newRegions });
        },
        [store]
    );

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

    const handleDiscover = React.useCallback(async () => {
        if (!subscriptionId) return;
        setIsDiscovering(true);
        setDiscoverError(null);
        setDiscoveredAccounts([]);
        try {
            await orchestrator.execute({
                action: "discover_accounts",
                payload: { subscriptionId },
            });
        } catch (err: any) {
            setDiscoverError(err?.message ?? String(err));
        } finally {
            setIsDiscovering(false);
        }
    }, [orchestrator, subscriptionId]);

    const handleRetryFailed = React.useCallback(() => {
        const ids = store.retryFailedAccounts();
        store.addNotification({
            type: "info",
            message: `Retrying ${ids.length} failed account(s)...`,
            autoDismissMs: 5000,
        });
    }, [store]);

    // Update discovered accounts when state changes
    const importedIds = React.useMemo(
        () => new Set(state.accounts.map((a) => a.id)),
        [state.accounts]
    );

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

    // Subscription selector shared between tabs
    const subscriptionSelector = (
        <>
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
                        o && handleSubscriptionChange(o.key as string)
                    }
                    styles={{ dropdown: { maxWidth: 450 } }}
                />
            ) : (
                <TextField
                    label="Subscription ID"
                    value={subscriptionId}
                    onChange={(_e, v) => handleSubscriptionChange(v ?? "")}
                    placeholder="Enter Azure subscription ID (run 'az login' to auto-load)"
                    styles={{ root: { maxWidth: 450 } }}
                />
            )}
        </>
    );

    return (
        <div style={{ padding: "16px" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: "20px" }}>
                Account Provisioning
            </h2>

            <Pivot styles={{ root: { marginBottom: 16 } }}>
                <PivotItem headerText="Create New" itemIcon="Add">
                    <div style={{ paddingTop: 12 }}>
                        <Stack tokens={stackTokens}>
                            {subscriptionSelector}
                            <Dropdown
                                label="Regions (select up to 20)"
                                placeholder="Select regions"
                                multiSelect
                                options={regionOptions}
                                selectedKeys={selectedRegions}
                                onChange={(_e, option) => {
                                    if (!option) return;
                                    const newRegions = option.selected
                                        ? [
                                              ...selectedRegions,
                                              option.key as string,
                                          ]
                                        : selectedRegions.filter(
                                              (r) => r !== option.key
                                          );
                                    handleRegionsChange(newRegions);
                                }}
                                styles={{ dropdown: { maxWidth: 450 } }}
                            />

                            {selectedRegions.length > 20 && (
                                <MessageBar
                                    messageBarType={MessageBarType.warning}
                                >
                                    Maximum 20 regions recommended
                                </MessageBar>
                            )}

                            <Stack horizontal tokens={{ childrenGap: 8 }}>
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
                                {isRunning && (
                                    <DefaultButton
                                        text="Stop"
                                        onClick={() => orchestrator.cancel()}
                                        styles={{
                                            root: {
                                                borderColor: "#d13438",
                                                color: "#d13438",
                                            },
                                        }}
                                    />
                                )}
                                {failedCount > 0 && !isRunning && (
                                    <DefaultButton
                                        text={`Retry Failed (${failedCount})`}
                                        onClick={handleRetryFailed}
                                        iconProps={{ iconName: "Refresh" }}
                                    />
                                )}
                            </Stack>
                        </Stack>

                        {isRunning && (
                            <ProgressIndicator
                                label={`Creating accounts... ${createdCount + failedCount}/${totalCount > 0 ? totalCount : selectedRegions.length}`}
                                percentComplete={
                                    totalCount > 0
                                        ? (createdCount + failedCount) /
                                          totalCount
                                        : undefined
                                }
                                styles={{ root: { marginTop: 16 } }}
                            />
                        )}
                    </div>
                </PivotItem>

                <PivotItem
                    headerText="Import Existing"
                    itemIcon="CloudDownload"
                >
                    <div style={{ paddingTop: 12 }}>
                        <Stack tokens={stackTokens}>
                            {subscriptionSelector}

                            <Stack
                                horizontal
                                tokens={{ childrenGap: 8 }}
                                verticalAlign="end"
                            >
                                <PrimaryButton
                                    text={
                                        isDiscovering
                                            ? "Discovering..."
                                            : "Discover Batch Accounts"
                                    }
                                    disabled={isDiscovering || !subscriptionId}
                                    onClick={handleDiscover}
                                    iconProps={{
                                        iconName: "Search",
                                    }}
                                />
                            </Stack>

                            {discoverError && (
                                <MessageBar
                                    messageBarType={MessageBarType.error}
                                    onDismiss={() => setDiscoverError(null)}
                                >
                                    {discoverError}
                                </MessageBar>
                            )}

                            {isDiscovering && (
                                <ProgressIndicator label="Discovering Batch accounts from Azure..." />
                            )}

                            <MessageBar messageBarType={MessageBarType.info}>
                                Discovers all existing Batch accounts in the
                                selected subscription and imports them so you
                                can manage quota, pools, and nodes on them.
                            </MessageBar>
                        </Stack>
                    </div>
                </PivotItem>
            </Pivot>

            {state.accounts.length > 0 && (
                <div style={{ marginTop: 8 }}>
                    <div
                        style={{
                            fontSize: "13px",
                            marginBottom: 8,
                            color: "#605e5c",
                        }}
                    >
                        {totalCount} accounts ({createdCount} ready,{" "}
                        {failedCount} failed)
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
