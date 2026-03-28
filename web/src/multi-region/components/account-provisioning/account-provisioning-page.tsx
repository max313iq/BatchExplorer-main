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
import { Text } from "@fluentui/react/lib/Text";
import { Icon } from "@fluentui/react/lib/Icon";
import { Pivot, PivotItem } from "@fluentui/react/lib/Pivot";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import {
    AZURE_REGIONS,
    DEFAULT_CONFIG,
    isValidSubscriptionId,
} from "../shared/constants";

const stackTokens: IStackTokens = { childrenGap: 12 };

/* ---- Skeleton ---- */
const SKELETON_KEYFRAMES = `
@keyframes skeletonPulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}`;

const AccountTableSkeleton: React.FC = () => (
    <div aria-hidden="true" style={{ marginTop: 8 }}>
        {Array.from({ length: 4 }).map((_, row) => (
            <div
                key={row}
                style={{
                    display: "flex",
                    gap: 12,
                    padding: "8px 0",
                    borderBottom: "1px solid #2a2a2a",
                }}
            >
                {[120, 160, 200, 100, 200].map((w, i) => (
                    <div
                        key={i}
                        style={{
                            width: w,
                            height: 10,
                            background: "#333",
                            borderRadius: 4,
                            animation:
                                "skeletonPulse 1.5s ease-in-out infinite",
                            animationDelay: `${row * 0.1}s`,
                        }}
                    />
                ))}
            </div>
        ))}
    </div>
);

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
    const [validationError, setValidationError] = React.useState<string | null>(
        null
    );

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
            setValidationError(null);
            store.saveUserPreferences({ lastSubscriptionId: newValue });
        },
        [store]
    );

    // Save regions preference when they change
    const handleRegionsChange = React.useCallback(
        (newRegions: string[]) => {
            // Enforce max regions limit
            if (newRegions.length > DEFAULT_CONFIG.maxRegionsPerRequest) {
                return;
            }
            setSelectedRegions(newRegions);
            store.saveUserPreferences({ lastRegions: newRegions });
        },
        [store]
    );

    const regionOptions: IDropdownOption[] = React.useMemo(
        () => AZURE_REGIONS.map((r) => ({ key: r, text: r })),
        []
    );

    const validateInputs = React.useCallback((): boolean => {
        if (!subscriptionId.trim()) {
            setValidationError("Subscription ID is required.");
            return false;
        }
        // Only validate format when manually entered (not from dropdown)
        if (
            state.subscriptions.length === 0 &&
            !isValidSubscriptionId(subscriptionId)
        ) {
            setValidationError(
                "Subscription ID must be a valid UUID (e.g. 12345678-1234-1234-1234-123456789abc)."
            );
            return false;
        }
        if (selectedRegions.length === 0) {
            setValidationError("Select at least one region.");
            return false;
        }
        setValidationError(null);
        return true;
    }, [subscriptionId, selectedRegions, state.subscriptions.length]);

    const handleCreate = React.useCallback(async () => {
        if (!validateInputs()) return;
        setIsRunning(true);
        try {
            await orchestrator.execute({
                action: "create_accounts",
                payload: {
                    subscriptionId: subscriptionId.trim(),
                    regions: selectedRegions,
                },
            });
        } finally {
            setIsRunning(false);
        }
    }, [orchestrator, subscriptionId, selectedRegions, validateInputs]);

    const handleDiscover = React.useCallback(async () => {
        if (!subscriptionId.trim()) {
            setValidationError("Subscription ID is required.");
            return;
        }
        if (
            state.subscriptions.length === 0 &&
            !isValidSubscriptionId(subscriptionId)
        ) {
            setValidationError("Subscription ID must be a valid UUID.");
            return;
        }
        setValidationError(null);
        setIsDiscovering(true);
        setDiscoverError(null);
        try {
            await orchestrator.execute({
                action: "discover_accounts",
                payload: { subscriptionId: subscriptionId.trim() },
            });
        } catch (err: any) {
            setDiscoverError(err?.message ?? String(err));
        } finally {
            setIsDiscovering(false);
        }
    }, [orchestrator, subscriptionId, state.subscriptions.length]);

    const handleRetryFailed = React.useCallback(() => {
        const ids = store.retryFailedAccounts();
        store.addNotification({
            type: "info",
            message: `Retrying ${ids.length} failed account(s)...`,
            autoDismissMs: 5000,
        });
    }, [store]);

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
            <style>{SKELETON_KEYFRAMES}</style>
            <h2 style={{ margin: "0 0 16px", fontSize: "20px" }}>
                Account Provisioning
            </h2>

            {validationError && (
                <MessageBar
                    messageBarType={MessageBarType.error}
                    onDismiss={() => setValidationError(null)}
                    styles={{ root: { marginBottom: 12 } }}
                >
                    {validationError}
                </MessageBar>
            )}

            <Pivot
                styles={{ root: { marginBottom: 16 } }}
                aria-label="Account provisioning tabs"
            >
                <PivotItem headerText="Create New" itemIcon="Add">
                    <div style={{ paddingTop: 12 }}>
                        <Stack tokens={stackTokens}>
                            {subscriptionSelector}
                            <Dropdown
                                label={`Regions (select up to ${DEFAULT_CONFIG.maxRegionsPerRequest})`}
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

                            {selectedRegions.length >=
                                DEFAULT_CONFIG.maxRegionsPerRequest && (
                                <MessageBar
                                    messageBarType={MessageBarType.warning}
                                >
                                    Maximum{" "}
                                    {DEFAULT_CONFIG.maxRegionsPerRequest}{" "}
                                    regions reached
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
                                        !subscriptionId.trim() ||
                                        selectedRegions.length === 0
                                    }
                                    onClick={handleCreate}
                                    styles={{ root: { maxWidth: 250 } }}
                                    aria-label={`Create ${selectedRegions.length} Batch accounts`}
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
                                    disabled={
                                        isDiscovering || !subscriptionId.trim()
                                    }
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

            {(isRunning || isDiscovering) && state.accounts.length === 0 && (
                <AccountTableSkeleton />
            )}

            {state.accounts.length > 0 && (
                <div style={{ marginTop: 8 }}>
                    <div
                        style={{
                            fontSize: "13px",
                            marginBottom: 8,
                            color: "#605e5c",
                        }}
                        role="status"
                        aria-live="polite"
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

            {!isRunning && !isDiscovering && state.accounts.length === 0 && (
                <Stack
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}
                    styles={{
                        root: {
                            padding: "48px 16px",
                            background: "#1e1e1e",
                            borderRadius: 6,
                            marginTop: 16,
                        },
                    }}
                    role="status"
                >
                    <Icon
                        iconName="AccountManagement"
                        styles={{
                            root: { fontSize: 40, color: "#555" },
                        }}
                    />
                    <Text
                        variant="large"
                        styles={{
                            root: { color: "#888", fontWeight: 600 },
                        }}
                    >
                        No accounts provisioned
                    </Text>
                    <Text
                        styles={{
                            root: { color: "#666", fontSize: 13 },
                        }}
                    >
                        Create new Batch accounts or discover existing ones from
                        a subscription.
                    </Text>
                </Stack>
            )}
        </div>
    );
};
