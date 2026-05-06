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
import { ErrorBoundary } from "../shared/error-boundary";
import { SkeletonLoader } from "../shared/skeleton-loader";
import { ConfirmationDialog } from "../shared/confirmation-dialog";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import {
    AZURE_REGIONS,
    DEFAULT_CONFIG,
    isValidSubscriptionId,
} from "../shared/constants";
import {
    runPreflight,
    preflightCanSubmit,
    PreflightLevel,
    PreflightResult,
} from "../../shared/account-provisioning-preflight";

const stackTokens: IStackTokens = { childrenGap: 12 };

interface AccountProvisioningPageProps {
    orchestrator: OrchestratorAgent;
}

/* ---- Preflight chip → MessageBar ---- */
const LEVEL_TO_BAR: Record<PreflightLevel, MessageBarType> = {
    ok: MessageBarType.success,
    warn: MessageBarType.warning,
    error: MessageBarType.severeWarning,
    unknown: MessageBarType.info,
};

const PreflightChips: React.FC<{ checks: PreflightResult[] }> = ({
    checks,
}) => (
    <Stack
        tokens={{ childrenGap: 6 }}
        role="status"
        aria-live="polite"
        aria-label="Pre-flight checks"
    >
        {checks.map((c) => (
            <MessageBar
                key={c.id}
                messageBarType={LEVEL_TO_BAR[c.level]}
                styles={{ root: { fontSize: 12 } }}
                aria-label={`${c.label}: ${c.detail}`}
            >
                <b>{c.label}.</b> {c.detail}
            </MessageBar>
        ))}
    </Stack>
);

const AccountProvisioningPageInner: React.FC<AccountProvisioningPageProps> = ({
    orchestrator,
}) => {
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
    const [confirmHidden, setConfirmHidden] = React.useState(true);

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

    // Pre-flight checks (recomputed on each relevant change)
    const preflight = React.useMemo<PreflightResult[]>(
        () =>
            runPreflight({
                subscriptionId,
                selectedRegions,
                accounts: state.accounts,
                subscriptions: state.subscriptions,
                azureAccounts: state.azureAccounts ?? [],
                maxRegions: DEFAULT_CONFIG.maxRegionsPerRequest,
            }),
        [
            subscriptionId,
            selectedRegions,
            state.accounts,
            state.subscriptions,
            state.azureAccounts,
        ]
    );
    const canSubmit = React.useMemo(
        () => preflightCanSubmit(preflight),
        [preflight]
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

    const requestCreate = React.useCallback(() => {
        if (!validateInputs()) return;
        setConfirmHidden(false);
    }, [validateInputs]);

    const handleConfirmCreate = React.useCallback(async () => {
        setConfirmHidden(true);
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
    }, [orchestrator, subscriptionId, selectedRegions]);

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

    // Confirmation dialog message body
    const confirmMessage = (
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <p style={{ margin: "0 0 8px" }}>
                You are about to create{" "}
                <b>
                    {selectedRegions.length} Batch account
                    {selectedRegions.length === 1 ? "" : "s"}
                </b>{" "}
                across <b>{selectedRegions.length} region(s)</b>:
            </p>
            <div
                style={{
                    fontSize: 12,
                    color: "#a0a0a0",
                    margin: "0 0 12px",
                    maxHeight: 80,
                    overflowY: "auto",
                }}
            >
                {selectedRegions.join(", ")}
            </div>
            <MessageBar
                messageBarType={MessageBarType.warning}
                styles={{ root: { marginBottom: 8 } }}
            >
                Each account incurs Azure storage and management overhead. Costs
                scale with the number of pools and nodes you later attach.
            </MessageBar>
            <MessageBar messageBarType={MessageBarType.severeWarning}>
                <b>This action is irreversible from this UI.</b> Account and
                resource group cleanup must be performed manually in the Azure
                portal or via CLI.
            </MessageBar>
        </div>
    );

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
                    aria-label="Azure subscription"
                />
            ) : (
                <TextField
                    label="Subscription ID"
                    value={subscriptionId}
                    onChange={(_e, v) => handleSubscriptionChange(v ?? "")}
                    placeholder="Enter Azure subscription ID (run 'az login' to auto-load)"
                    styles={{ root: { maxWidth: 450 } }}
                    aria-label="Azure subscription ID"
                />
            )}
        </>
    );

    return (
        <div style={{ padding: "16px" }} role="region" aria-label="Account provisioning page">
            <h1 style={{ margin: "0 0 16px", fontSize: "20px" }}>
                Account Provisioning
            </h1>

            {validationError && (
                <MessageBar
                    messageBarType={MessageBarType.error}
                    onDismiss={() => setValidationError(null)}
                    styles={{ root: { marginBottom: 12 } }}
                    role="alert"
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
                        <h2
                            style={{
                                margin: "0 0 8px",
                                fontSize: 14,
                                fontWeight: 600,
                                color: "#a0a0a0",
                            }}
                        >
                            Configuration
                        </h2>
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
                                aria-label="Azure regions"
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

                            <h3
                                style={{
                                    margin: "8px 0 4px",
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: "#a0a0a0",
                                }}
                            >
                                Pre-flight checks
                            </h3>
                            <PreflightChips checks={preflight} />

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
                                        selectedRegions.length === 0 ||
                                        !canSubmit
                                    }
                                    onClick={requestCreate}
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
                                        aria-label="Stop account creation"
                                    />
                                )}
                                {failedCount > 0 && !isRunning && (
                                    <DefaultButton
                                        text={`Retry Failed (${failedCount})`}
                                        onClick={handleRetryFailed}
                                        iconProps={{ iconName: "Refresh" }}
                                        aria-label={`Retry ${failedCount} failed accounts`}
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
                                ariaValueText={`${createdCount + failedCount} of ${totalCount > 0 ? totalCount : selectedRegions.length} accounts processed`}
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
                                    aria-label="Discover existing Batch accounts"
                                />
                            </Stack>

                            {discoverError && (
                                <MessageBar
                                    messageBarType={MessageBarType.error}
                                    onDismiss={() => setDiscoverError(null)}
                                    role="alert"
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
                <div style={{ marginTop: 8 }}>
                    <SkeletonLoader variant="table" rows={4} columns={5} />
                </div>
            )}

            {state.accounts.length > 0 && (
                <div style={{ marginTop: 8 }}>
                    <h2
                        style={{
                            margin: "0 0 8px",
                            fontSize: 14,
                            fontWeight: 600,
                            color: "#a0a0a0",
                        }}
                    >
                        Provisioned accounts
                    </h2>
                    <div
                        style={{
                            fontSize: "13px",
                            marginBottom: 8,
                            color: "#605e5c",
                        }}
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
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
                        ariaLabelForGrid="Provisioned Batch accounts"
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
                        aria-hidden="true"
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

            <ConfirmationDialog
                hidden={confirmHidden}
                title="Create Batch accounts?"
                message={confirmMessage}
                confirmText={`Create ${selectedRegions.length} accounts`}
                cancelText="Cancel"
                danger
                onConfirm={handleConfirmCreate}
                onCancel={() => setConfirmHidden(true)}
                loading={isRunning}
            />
        </div>
    );
};

export const AccountProvisioningPage: React.FC<
    AccountProvisioningPageProps
> = (props) => (
    <ErrorBoundary>
        <AccountProvisioningPageInner {...props} />
    </ErrorBoundary>
);
