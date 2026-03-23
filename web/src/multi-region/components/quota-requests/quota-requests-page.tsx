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
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import { StatusBadge } from "../shared/status-badge";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";

const stackTokens: IStackTokens = { childrenGap: 12 };

interface QuotaRequestsPageProps {
    orchestrator: OrchestratorAgent;
}

export const QuotaRequestsPage: React.FC<QuotaRequestsPageProps> = ({
    orchestrator,
}) => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();

    // Pre-fill from user preferences on mount
    const prefsLoaded = React.useRef(false);
    const [quotaType, setQuotaType] = React.useState<string>("LowPriority");
    const [newLimit, setNewLimit] = React.useState("680");
    const [email, setEmail] = React.useState("");
    const [supportPlanId, setSupportPlanId] = React.useState("");
    const [selectedAccountIds, setSelectedAccountIds] = React.useState<
        Set<string>
    >(new Set());
    const [customToken, setCustomToken] = React.useState("");
    const [ticketSubscriptionId, setTicketSubscriptionId] = React.useState("");
    const [selectAll, setSelectAll] = React.useState(false);
    const [isRunning, setIsRunning] = React.useState(false);

    React.useEffect(() => {
        if (prefsLoaded.current) return;
        prefsLoaded.current = true;
        const prefs = store.getUserPreferences();
        if (prefs.lastEmail) {
            setEmail(prefs.lastEmail);
        }
        if (prefs.lastQuotaLimit) {
            setNewLimit(String(prefs.lastQuotaLimit));
        }
        if (prefs.lastQuotaType) {
            setQuotaType(prefs.lastQuotaType);
        }
        if (prefs.lastSupportPlanId) {
            setSupportPlanId(prefs.lastSupportPlanId);
        }
    }, [store]);

    // Save preferences when fields change
    const handleEmailChange = React.useCallback(
        (value: string) => {
            setEmail(value);
            store.saveUserPreferences({ lastEmail: value });
        },
        [store]
    );

    const handleNewLimitChange = React.useCallback(
        (value: string) => {
            setNewLimit(value);
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed)) {
                store.saveUserPreferences({ lastQuotaLimit: parsed });
            }
        },
        [store]
    );

    const handleQuotaTypeChange = React.useCallback(
        (value: string) => {
            setQuotaType(value);
            store.saveUserPreferences({
                lastQuotaType: value as "LowPriority" | "Dedicated" | "Spot",
            });
        },
        [store]
    );

    const handleSupportPlanIdChange = React.useCallback(
        (value: string) => {
            setSupportPlanId(value);
            store.saveUserPreferences({ lastSupportPlanId: value });
        },
        [store]
    );

    const createdAccounts = state.accounts.filter(
        (a) => a.provisioningState === "created"
    );

    React.useEffect(() => {
        if (selectAll) {
            setSelectedAccountIds(new Set(createdAccounts.map((a) => a.id)));
        }
    }, [selectAll, createdAccounts.length]);

    const quotaTypeOptions: IDropdownOption[] = [
        { key: "LowPriority", text: "Low Priority" },
        { key: "Dedicated", text: "Dedicated" },
        { key: "Spot", text: "Spot" },
    ];

    const handleSubmit = React.useCallback(async () => {
        if (selectedAccountIds.size === 0 || !email) return;
        setIsRunning(true);
        try {
            await orchestrator.execute({
                action: "submit_quota_requests",
                payload: {
                    accountIds: Array.from(selectedAccountIds),
                    quotaType,
                    newLimit: parseInt(newLimit, 10),
                    contactConfig: {
                        email,
                        timezone: "Russian Standard Time",
                        country: "MEX",
                        language: "en-us",
                    },
                    supportPlanId,
                    customToken: customToken.trim() || undefined,
                    ticketSubscriptionId:
                        ticketSubscriptionId.trim() || undefined,
                },
            });
        } finally {
            setIsRunning(false);
        }
    }, [
        orchestrator,
        selectedAccountIds,
        quotaType,
        newLimit,
        email,
        supportPlanId,
    ]);

    const accountColumns: IColumn[] = [
        {
            key: "select",
            name: "",
            minWidth: 30,
            maxWidth: 30,
            onRender: (item) => (
                <Checkbox
                    checked={selectedAccountIds.has(item.id)}
                    onChange={(_e, checked) => {
                        setSelectedAccountIds((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                        });
                    }}
                />
            ),
        },
        {
            key: "accountName",
            name: "Account",
            fieldName: "accountName",
            minWidth: 160,
        },
        { key: "region", name: "Region", fieldName: "region", minWidth: 120 },
    ];

    const requestColumns: IColumn[] = [
        {
            key: "accountName",
            name: "Account",
            minWidth: 140,
            onRender: (item) => {
                const account = state.accounts.find(
                    (a) => a.id === item.accountId
                );
                return account?.accountName ?? item.accountId;
            },
        },
        { key: "region", name: "Region", fieldName: "region", minWidth: 120 },
        {
            key: "ticketId",
            name: "Ticket ID",
            fieldName: "ticketId",
            minWidth: 200,
        },
        {
            key: "status",
            name: "Status",
            minWidth: 100,
            onRender: (item) => <StatusBadge status={item.status} />,
        },
        {
            key: "submittedAt",
            name: "Submitted",
            minWidth: 160,
            onRender: (item) =>
                item.submittedAt
                    ? new Date(item.submittedAt).toLocaleString()
                    : "-",
        },
    ];

    return (
        <div style={{ padding: "16px" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: "20px" }}>
                Quota Requests
            </h2>

            <Stack tokens={stackTokens}>
                <Checkbox
                    label={`Select all created accounts (${createdAccounts.length})`}
                    checked={selectAll}
                    onChange={(_e, checked) => setSelectAll(!!checked)}
                />

                {!selectAll && createdAccounts.length > 0 && (
                    <DetailsList
                        items={createdAccounts}
                        columns={accountColumns}
                        layoutMode={DetailsListLayoutMode.justified}
                        selectionMode={SelectionMode.none}
                        compact
                    />
                )}

                <Stack horizontal tokens={stackTokens}>
                    <Dropdown
                        label="Quota Type"
                        options={quotaTypeOptions}
                        selectedKey={quotaType}
                        onChange={(_e, o) =>
                            o && handleQuotaTypeChange(o.key as string)
                        }
                        styles={{ dropdown: { width: 180 } }}
                    />
                    <TextField
                        label="New Limit (vCPUs)"
                        value={newLimit}
                        onChange={(_e, v) => handleNewLimitChange(v ?? "680")}
                        type="number"
                        styles={{ root: { width: 130 } }}
                    />
                </Stack>

                <TextField
                    label="Contact Email"
                    value={email}
                    onChange={(_e, v) => handleEmailChange(v ?? "")}
                    placeholder="your@email.com"
                    styles={{ root: { maxWidth: 350 } }}
                />
                <TextField
                    label="Support Plan ID"
                    value={supportPlanId}
                    onChange={(_e, v) => handleSupportPlanIdChange(v ?? "")}
                    placeholder="U291cmNlOk..."
                    styles={{ root: { maxWidth: 450 } }}
                />
                <TextField
                    label="Bearer Token (optional — leave empty to use Azure CLI token)"
                    value={customToken}
                    onChange={(_e, v) => setCustomToken(v ?? "")}
                    placeholder="Paste Bearer token here, or leave empty for auto"
                    multiline
                    rows={3}
                    styles={{ root: { maxWidth: 550 } }}
                    description={
                        customToken.trim()
                            ? "Using custom token"
                            : "Using auto token from Azure CLI"
                    }
                />

                <Stack horizontal tokens={{ childrenGap: 8 }}>
                    <PrimaryButton
                        text={
                            isRunning
                                ? "Submitting..."
                                : `Submit ${selectedAccountIds.size} Quota Requests`
                        }
                        disabled={
                            isRunning || selectedAccountIds.size === 0 || !email
                        }
                        onClick={handleSubmit}
                        styles={{ root: { maxWidth: 300 } }}
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
                </Stack>
            </Stack>

            {isRunning && (
                <ProgressIndicator
                    label="Submitting quota requests..."
                    styles={{ root: { marginTop: 16 } }}
                />
            )}

            {state.quotaRequests.length > 0 && (
                <div style={{ marginTop: 16 }}>
                    <h3 style={{ fontSize: "16px", margin: "0 0 8px" }}>
                        Submitted Requests
                    </h3>
                    <DetailsList
                        items={state.quotaRequests}
                        columns={requestColumns}
                        layoutMode={DetailsListLayoutMode.justified}
                        selectionMode={SelectionMode.none}
                        compact
                    />
                </div>
            )}
        </div>
    );
};
