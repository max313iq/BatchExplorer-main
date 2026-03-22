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
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import { useMultiRegionState } from "../../store/store-context";
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
    const [quotaType, setQuotaType] = React.useState<string>("LowPriority");
    const [newLimit, setNewLimit] = React.useState("680");
    const [email, setEmail] = React.useState("");
    const [supportPlanId, setSupportPlanId] = React.useState("");
    const [selectedAccountIds, setSelectedAccountIds] = React.useState<
        Set<string>
    >(new Set());
    const [selectAll, setSelectAll] = React.useState(false);
    const [isRunning, setIsRunning] = React.useState(false);

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
                        onChange={(_e, o) => o && setQuotaType(o.key as string)}
                        styles={{ dropdown: { width: 180 } }}
                    />
                    <TextField
                        label="New Limit (vCPUs)"
                        value={newLimit}
                        onChange={(_e, v) => setNewLimit(v ?? "680")}
                        type="number"
                        styles={{ root: { width: 130 } }}
                    />
                </Stack>

                <TextField
                    label="Contact Email"
                    value={email}
                    onChange={(_e, v) => setEmail(v ?? "")}
                    placeholder="your@email.com"
                    styles={{ root: { maxWidth: 350 } }}
                />
                <TextField
                    label="Support Plan ID"
                    value={supportPlanId}
                    onChange={(_e, v) => setSupportPlanId(v ?? "")}
                    placeholder="U291cmNlOk..."
                    styles={{ root: { maxWidth: 450 } }}
                />

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
