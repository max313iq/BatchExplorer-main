import * as React from "react";
import {
    DetailsList,
    IColumn,
    SelectionMode,
    Selection,
    DetailsListLayoutMode,
    CheckboxVisibility,
} from "@fluentui/react/lib/DetailsList";
import { PrimaryButton, DefaultButton } from "@fluentui/react/lib/Button";
import { Stack, IStackTokens } from "@fluentui/react/lib/Stack";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { ProgressIndicator } from "@fluentui/react/lib/ProgressIndicator";
import { Checkbox } from "@fluentui/react/lib/Checkbox";
import { useMultiRegionState } from "../../store/store-context";
import { OrchestratorAgent } from "../../agents/orchestrator-agent";
import { StatusBadge } from "../shared/status-badge";
import { ManagedNode } from "../../store/store-types";

interface NodesPageProps {
    orchestrator: OrchestratorAgent;
}

const stackTokens: IStackTokens = { childrenGap: 12 };

const NON_WORKING_STATES = new Set([
    "unusable",
    "starttaskfailed",
    "offline",
    "preempted",
    "unknown",
]);

export const NodesPage: React.FC<NodesPageProps> = ({ orchestrator }) => {
    const state = useMultiRegionState();
    const [isLoading, setIsLoading] = React.useState(false);
    const [isActing, setIsActing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [selectedNodeIds, setSelectedNodeIds] = React.useState<Set<string>>(
        new Set()
    );
    const [selectAll, setSelectAll] = React.useState(false);
    const [filterNonWorking, setFilterNonWorking] = React.useState(false);

    const createdAccounts = state.accounts.filter(
        (a) => a.provisioningState === "created"
    );

    // Auto-load nodes on mount if there are created accounts and no nodes loaded yet
    const autoLoadedRef = React.useRef(false);
    React.useEffect(() => {
        if (autoLoadedRef.current) return;
        if (createdAccounts.length > 0 && state.nodes.length === 0) {
            autoLoadedRef.current = true;
            (async () => {
                setIsLoading(true);
                setError(null);
                try {
                    await orchestrator.execute({
                        action: "list_nodes",
                        payload: {
                            accountIds: createdAccounts.map((a) => a.id),
                        },
                    });
                } catch (err: any) {
                    setError(err?.message ?? String(err));
                } finally {
                    setIsLoading(false);
                }
            })();
        }
    }, [createdAccounts.length, state.nodes.length, orchestrator]);

    const displayNodes = React.useMemo(() => {
        let nodes = state.nodes;
        if (filterNonWorking) {
            nodes = nodes.filter((n) => NON_WORKING_STATES.has(n.state));
        }
        return nodes;
    }, [state.nodes, filterNonWorking]);

    const selection = React.useMemo(() => {
        const sel = new Selection({
            onSelectionChanged: () => {
                const items = sel.getSelection() as ManagedNode[];
                setSelectedNodeIds(new Set(items.map((n) => n.id)));
            },
        });
        return sel;
    }, []);

    const handleRefreshNodes = React.useCallback(async () => {
        if (createdAccounts.length === 0) return;
        setIsLoading(true);
        setError(null);
        try {
            await orchestrator.execute({
                action: "list_nodes",
                payload: {
                    accountIds: createdAccounts.map((a) => a.id),
                },
            });
        } catch (err: any) {
            setError(err?.message ?? String(err));
        } finally {
            setIsLoading(false);
        }
    }, [orchestrator, createdAccounts]);

    const handleNodeAction = React.useCallback(
        async (action: "reboot" | "delete") => {
            const ids = selectAll
                ? displayNodes.map((n) => n.id)
                : Array.from(selectedNodeIds);
            if (ids.length === 0) return;

            // Show confirmation dialog before delete operations
            if (action === "delete") {
                const confirmed = window.confirm(
                    `Are you sure you want to delete ${ids.length} node(s)? This action cannot be undone.`
                );
                if (!confirmed) return;
            }

            setIsActing(true);
            setError(null);
            try {
                await orchestrator.execute({
                    action: "node_action",
                    payload: {
                        actionType: action,
                        nodeIds: ids,
                    },
                });
            } catch (err: any) {
                setError(err?.message ?? String(err));
            } finally {
                setIsActing(false);
            }
        },
        [orchestrator, selectedNodeIds, selectAll, displayNodes]
    );

    const columns: IColumn[] = [
        {
            key: "nodeId",
            name: "Node ID",
            fieldName: "nodeId",
            minWidth: 160,
            maxWidth: 240,
            isResizable: true,
        },
        {
            key: "state",
            name: "State",
            fieldName: "state",
            minWidth: 100,
            maxWidth: 140,
            onRender: (item: ManagedNode) => (
                <StatusBadge status={item.state} />
            ),
        },
        {
            key: "accountName",
            name: "Batch Account",
            fieldName: "accountName",
            minWidth: 140,
            maxWidth: 200,
            isResizable: true,
        },
        {
            key: "region",
            name: "Region",
            fieldName: "region",
            minWidth: 100,
            maxWidth: 150,
            isResizable: true,
        },
        {
            key: "poolId",
            name: "Pool",
            fieldName: "poolId",
            minWidth: 80,
            maxWidth: 140,
            isResizable: true,
        },
        {
            key: "vmSize",
            name: "VM Size",
            fieldName: "vmSize",
            minWidth: 140,
            maxWidth: 200,
            isResizable: true,
        },
        {
            key: "ipAddress",
            name: "IP Address",
            fieldName: "ipAddress",
            minWidth: 100,
            maxWidth: 140,
            isResizable: true,
        },
        {
            key: "error",
            name: "Error",
            fieldName: "error",
            minWidth: 150,
            maxWidth: 300,
            isResizable: true,
            onRender: (item: ManagedNode) => (
                <span
                    style={{
                        color: item.error ? "#a80000" : "#605e5c",
                        fontSize: 12,
                    }}
                >
                    {item.error ?? "\u2014"}
                </span>
            ),
        },
    ];

    const actionCount = selectAll ? displayNodes.length : selectedNodeIds.size;

    return (
        <div style={{ padding: "16px" }}>
            <Stack tokens={stackTokens}>
                <h2 style={{ margin: 0 }}>Nodes</h2>

                {error && (
                    <MessageBar
                        messageBarType={MessageBarType.error}
                        onDismiss={() => setError(null)}
                    >
                        {error}
                    </MessageBar>
                )}

                <Stack
                    horizontal
                    tokens={{ childrenGap: 12 }}
                    verticalAlign="center"
                >
                    <PrimaryButton
                        text={
                            isLoading
                                ? "Loading..."
                                : `Refresh Nodes (${createdAccounts.length} accounts)`
                        }
                        onClick={handleRefreshNodes}
                        disabled={isLoading || createdAccounts.length === 0}
                        iconProps={{ iconName: "Refresh" }}
                    />
                    {isLoading && (
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
                    <Checkbox
                        label="Show only non-working nodes"
                        checked={filterNonWorking}
                        onChange={(_, checked) =>
                            setFilterNonWorking(!!checked)
                        }
                    />
                    <Checkbox
                        label={`Select all (${displayNodes.length})`}
                        checked={selectAll}
                        onChange={(_, checked) => {
                            setSelectAll(!!checked);
                            if (checked) {
                                setSelectedNodeIds(
                                    new Set(displayNodes.map((n) => n.id))
                                );
                            } else {
                                setSelectedNodeIds(new Set());
                            }
                        }}
                    />
                </Stack>

                <Stack horizontal tokens={{ childrenGap: 8 }}>
                    <DefaultButton
                        text={`Reboot (${actionCount})`}
                        onClick={() => handleNodeAction("reboot")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Refresh" }}
                    />
                    <DefaultButton
                        text={`Delete (${actionCount})`}
                        onClick={() => handleNodeAction("delete")}
                        disabled={isActing || actionCount === 0}
                        iconProps={{ iconName: "Delete" }}
                        styles={{
                            root: { borderColor: "#a80000", color: "#a80000" },
                        }}
                    />
                </Stack>

                {(isLoading || isActing) && (
                    <ProgressIndicator
                        label={
                            isLoading
                                ? "Loading nodes..."
                                : "Performing action..."
                        }
                    />
                )}

                <div style={{ fontSize: 13, color: "#605e5c" }}>
                    {displayNodes.length} nodes
                    {filterNonWorking ? " (non-working only)" : ""}
                    {" | "}
                    {actionCount} selected
                </div>

                {displayNodes.length > 0 ? (
                    <DetailsList
                        items={displayNodes}
                        columns={columns}
                        selectionMode={SelectionMode.multiple}
                        selection={selection}
                        checkboxVisibility={CheckboxVisibility.always}
                        layoutMode={DetailsListLayoutMode.fixedColumns}
                        getKey={(item: any) => item.id}
                    />
                ) : (
                    <MessageBar messageBarType={MessageBarType.info}>
                        {state.nodes.length === 0
                            ? 'No nodes loaded. Click "Refresh Nodes" to fetch nodes from all accounts with pools.'
                            : "No nodes match the current filter."}
                    </MessageBar>
                )}
            </Stack>
        </div>
    );
};
