import * as React from "react";
import { Stack } from "@fluentui/react/lib/Stack";
import { Text } from "@fluentui/react/lib/Text";
import {
    PrimaryButton,
    DefaultButton,
    IconButton,
} from "@fluentui/react/lib/Button";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { Icon } from "@fluentui/react/lib/Icon";
import { MessageBar, MessageBarType } from "@fluentui/react/lib/MessageBar";
import { SearchBox } from "@fluentui/react/lib/SearchBox";
import {
    AzureLoginAccount,
    AzureLoginSubscription,
} from "../../store/store-types";
import {
    useMultiRegionState,
    useMultiRegionStore,
} from "../../store/store-context";
import {
    loginAccount,
    logoutAccount,
    listSubscriptionsForAccount,
    getAllLoggedInAccounts,
} from "../../auth/msal-auth";

/* ------------------------------------------------------------------ */
/*  Summary stat item (reused from account-info-page style)           */
/* ------------------------------------------------------------------ */

const SummaryStatItem: React.FC<{
    icon: string;
    label: string;
    value: number;
    color: string;
}> = ({ icon, label, value, color }) => (
    <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 8 }}>
        <Icon iconName={icon} styles={{ root: { color, fontSize: 16 } }} />
        <div>
            <Text
                variant="tiny"
                styles={{
                    root: { color: "#888", display: "block", fontSize: 11 },
                }}
            >
                {label}
            </Text>
            <Text variant="large" styles={{ root: { fontWeight: 700, color } }}>
                {value}
            </Text>
        </div>
    </Stack>
);

/* ------------------------------------------------------------------ */
/*  Empty state                                                       */
/* ------------------------------------------------------------------ */

const EmptyState: React.FC = () => (
    <Stack
        horizontalAlign="center"
        tokens={{ childrenGap: 12 }}
        styles={{
            root: {
                padding: "48px 16px",
                background: "#1e1e1e",
                borderRadius: 6,
            },
        }}
    >
        <Icon
            iconName="Contact"
            styles={{ root: { fontSize: 40, color: "#444" } }}
        />
        <Text
            variant="large"
            styles={{ root: { color: "#888", fontWeight: 600 } }}
        >
            No Azure accounts
        </Text>
        <Text styles={{ root: { color: "#666", fontSize: 13 } }}>
            Click &quot;Add Account&quot; to sign in with an Azure AD account.
        </Text>
    </Stack>
);

/* ------------------------------------------------------------------ */
/*  AccountCard                                                       */
/* ------------------------------------------------------------------ */

interface AccountCardProps {
    account: AzureLoginAccount;
    onRemove: (homeAccountId: string) => void;
}

const AccountCard: React.FC<AccountCardProps> = ({ account, onRemove }) => {
    const [expanded, setExpanded] = React.useState(false);
    const [subSearch, setSubSearch] = React.useState("");

    const filteredSubs = React.useMemo(() => {
        if (!subSearch) return account.subscriptions;
        const term = subSearch.toLowerCase();
        return account.subscriptions.filter(
            (sub) =>
                sub.displayName.toLowerCase().includes(term) ||
                sub.subscriptionId.toLowerCase().includes(term)
        );
    }, [account.subscriptions, subSearch]);

    return (
        <div
            style={{
                background: "#1e1e1e",
                borderRadius: 6,
                marginBottom: 8,
                overflow: "hidden",
            }}
        >
            {/* Card header row */}
            <button
                onClick={() => setExpanded((prev) => !prev)}
                style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    padding: "12px 16px",
                    cursor: "pointer",
                    textAlign: "left",
                }}
            >
                <Stack
                    horizontal
                    verticalAlign="center"
                    tokens={{ childrenGap: 12 }}
                >
                    <Icon
                        iconName="Contact"
                        styles={{
                            root: { fontSize: 20, color: "#0078d4" },
                        }}
                    />
                    <div style={{ flex: 1, textAlign: "left" }}>
                        <Text
                            styles={{
                                root: { color: "#eee", fontWeight: 600 },
                            }}
                        >
                            {account.name || account.username}
                        </Text>
                        <Text
                            styles={{
                                root: {
                                    color: "#888",
                                    fontSize: 12,
                                    display: "block",
                                },
                            }}
                        >
                            {account.username}
                        </Text>
                        <Text
                            styles={{
                                root: {
                                    color: "#666",
                                    fontSize: 11,
                                    display: "block",
                                },
                            }}
                        >
                            Tenant: {account.tenantId}
                        </Text>
                    </div>

                    {/* Status indicator */}
                    {account.status === "loading" && (
                        <Spinner size={SpinnerSize.small} />
                    )}
                    {account.status === "error" && (
                        <Icon
                            iconName="Error"
                            styles={{ root: { color: "#d13438" } }}
                        />
                    )}

                    {/* Subscription count badge */}
                    <span
                        style={{
                            background: "#0078d4",
                            color: "#fff",
                            borderRadius: 10,
                            padding: "2px 10px",
                            fontSize: 12,
                            fontWeight: 700,
                        }}
                    >
                        {account.subscriptionCount} subs
                    </span>

                    {/* Remove button */}
                    <IconButton
                        iconProps={{ iconName: "Delete" }}
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemove(account.homeAccountId);
                        }}
                        styles={{
                            root: { color: "#d13438" },
                            icon: { color: "#d13438" },
                        }}
                    />

                    {/* Expand chevron */}
                    <Icon
                        iconName={expanded ? "ChevronUp" : "ChevronDown"}
                        styles={{ root: { color: "#666" } }}
                    />
                </Stack>
            </button>

            {/* Expanded: subscription list */}
            {expanded && (
                <div
                    style={{
                        borderTop: "1px solid #333",
                        padding: "8px 16px 12px",
                    }}
                >
                    {account.status === "loading" ? (
                        <Spinner label="Loading subscriptions..." />
                    ) : account.status === "error" ? (
                        <MessageBar messageBarType={MessageBarType.error}>
                            {account.error}
                        </MessageBar>
                    ) : account.subscriptions.length === 0 ? (
                        <Text styles={{ root: { color: "#666" } }}>
                            No subscriptions found
                        </Text>
                    ) : (
                        <div>
                            <SearchBox
                                placeholder="Filter subscriptions..."
                                value={subSearch}
                                onChange={(
                                    _:
                                        | React.ChangeEvent<HTMLInputElement>
                                        | undefined,
                                    v?: string
                                ) => setSubSearch(v ?? "")}
                                styles={{
                                    root: { marginBottom: 8, maxWidth: 300 },
                                }}
                            />
                            {filteredSubs.map((sub: AzureLoginSubscription) => (
                                <div
                                    key={sub.subscriptionId}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 12,
                                        padding: "6px 0",
                                        borderBottom: "1px solid #2a2a2a",
                                    }}
                                >
                                    <Icon
                                        iconName="Subscription"
                                        styles={{
                                            root: {
                                                color: "#0078d4",
                                                fontSize: 14,
                                            },
                                        }}
                                    />
                                    <div style={{ flex: 1 }}>
                                        <Text
                                            styles={{
                                                root: {
                                                    color: "#ccc",
                                                    fontSize: 13,
                                                },
                                            }}
                                        >
                                            {sub.displayName}
                                        </Text>
                                        <Text
                                            styles={{
                                                root: {
                                                    color: "#666",
                                                    fontSize: 11,
                                                    display: "block",
                                                },
                                            }}
                                        >
                                            {sub.subscriptionId}
                                        </Text>
                                    </div>
                                    <span
                                        style={{
                                            background:
                                                sub.state === "Enabled"
                                                    ? "#0a3a0a"
                                                    : "#3a1a1a",
                                            color:
                                                sub.state === "Enabled"
                                                    ? "#107c10"
                                                    : "#d13438",
                                            borderRadius: 4,
                                            padding: "2px 8px",
                                            fontSize: 11,
                                        }}
                                    >
                                        {sub.state}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  Main page component                                               */
/* ------------------------------------------------------------------ */

export const AzureAccountsPage: React.FC = () => {
    const state = useMultiRegionState();
    const store = useMultiRegionStore();
    const [adding, setAdding] = React.useState(false);

    const accounts: AzureLoginAccount[] = React.useMemo(
        () => state.azureAccounts ?? [],
        [state.azureAccounts]
    );

    const totalSubCount = React.useMemo(
        () => accounts.reduce((sum, a) => sum + a.subscriptionCount, 0),
        [accounts]
    );

    /* ---- Load accounts on mount ---- */
    const loadAllAccounts = React.useCallback(async () => {
        try {
            const msalAccounts = await getAllLoggedInAccounts();
            if (!msalAccounts || msalAccounts.length === 0) {
                store.setAzureAccounts([]);
                return;
            }

            const initial: AzureLoginAccount[] = msalAccounts.map((acct) => ({
                homeAccountId: acct.homeAccountId,
                username: acct.username,
                name: acct.name ?? "",
                tenantId: acct.tenantId,
                environment: acct.environment,
                subscriptions: [],
                subscriptionCount: 0,
                status: "loading" as const,
                error: null,
                addedAt: new Date().toISOString(),
            }));

            store.setAzureAccounts(initial);

            // Load subscriptions for each account in parallel
            await Promise.allSettled(
                initial.map(async (acct) => {
                    try {
                        const subs = await listSubscriptionsForAccount(
                            acct.homeAccountId
                        );
                        store.updateAzureAccount(acct.homeAccountId, {
                            subscriptions: subs,
                            subscriptionCount: subs.length,
                            status: "active",
                            error: null,
                        });
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e);
                        store.updateAzureAccount(acct.homeAccountId, {
                            status: "error",
                            error: msg,
                        });
                    }
                })
            );
        } catch {
            // If getAllLoggedInAccounts itself fails, set empty
            store.setAzureAccounts([]);
        }
    }, [store]);

    React.useEffect(() => {
        loadAllAccounts();
    }, [loadAllAccounts]);

    /* ---- Add account ---- */
    const handleAddAccount = React.useCallback(async () => {
        setAdding(true);
        try {
            const result = await loginAccount();
            if (!result) {
                // User cancelled
                return;
            }

            const newAccount: AzureLoginAccount = {
                homeAccountId: result.homeAccountId,
                username: result.username,
                name: result.name ?? "",
                tenantId: result.tenantId,
                environment: result.environment,
                subscriptions: [],
                subscriptionCount: 0,
                status: "loading",
                error: null,
                addedAt: new Date().toISOString(),
            };

            store.upsertAzureAccount(newAccount);

            try {
                const subs = await listSubscriptionsForAccount(
                    result.homeAccountId
                );
                store.updateAzureAccount(result.homeAccountId, {
                    subscriptions: subs,
                    subscriptionCount: subs.length,
                    status: "active",
                    error: null,
                });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                store.updateAzureAccount(result.homeAccountId, {
                    status: "error",
                    error: msg,
                });
            }
        } catch {
            // Login failed or was cancelled — nothing to do
        } finally {
            setAdding(false);
        }
    }, [store]);

    /* ---- Remove account ---- */
    const handleRemove = React.useCallback(
        async (homeAccountId: string) => {
            try {
                await logoutAccount(homeAccountId);
            } catch {
                // Best-effort logout
            }
            store.removeAzureAccount(homeAccountId);
        },
        [store]
    );

    /* ---- Refresh all ---- */
    const handleRefreshAll = React.useCallback(() => {
        loadAllAccounts();
    }, [loadAllAccounts]);

    return (
        <div style={{ padding: "16px 0" }}>
            {/* Header bar */}
            <Stack
                horizontal
                verticalAlign="center"
                tokens={{ childrenGap: 12 }}
                styles={{ root: { marginBottom: 16 } }}
            >
                <Text
                    variant="xLarge"
                    styles={{
                        root: { fontWeight: 600, color: "#eee" },
                    }}
                >
                    Azure Accounts
                </Text>
                <PrimaryButton
                    text="Add Account"
                    iconProps={{ iconName: "AddFriend" }}
                    onClick={handleAddAccount}
                    disabled={adding}
                />
                {adding && <Spinner size={SpinnerSize.small} />}
                <DefaultButton
                    text="Refresh All"
                    iconProps={{ iconName: "Refresh" }}
                    onClick={handleRefreshAll}
                />
            </Stack>

            {/* Summary stats */}
            <Stack
                horizontal
                tokens={{ childrenGap: 24 }}
                styles={{
                    root: {
                        padding: "12px 16px",
                        background: "#1e1e1e",
                        borderRadius: 6,
                        marginBottom: 16,
                    },
                }}
            >
                <SummaryStatItem
                    icon="Contact"
                    label="Accounts"
                    value={accounts.length}
                    color="#0078d4"
                />
                <SummaryStatItem
                    icon="ViewList"
                    label="Subscriptions"
                    value={totalSubCount}
                    color="#8764b8"
                />
            </Stack>

            {/* Account cards */}
            {accounts.length === 0 ? (
                <EmptyState />
            ) : (
                accounts.map((account) => (
                    <AccountCard
                        key={account.homeAccountId}
                        account={account}
                        onRemove={handleRemove}
                    />
                ))
            )}
        </div>
    );
};
