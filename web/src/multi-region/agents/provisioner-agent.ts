import {
    Agent,
    AgentContext,
    AgentResult,
    ProvisionerInput,
} from "./agent-types";
import { ManagedAccount } from "../store/store-types";

function randomAlphanumeric(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function regionShort(region: string): string {
    return region
        .replace(/[^a-z0-9]/gi, "")
        .substring(0, 8)
        .toLowerCase();
}

function generateAccountName(region: string): string {
    const short = regionShort(region);
    const rand = randomAlphanumeric(4);
    const name = `batch${short}${rand}`;
    // Batch account names must be 3–24 chars, lowercase alphanumeric
    return name.substring(0, 24);
}

function generateResourceGroup(region: string): string {
    const now = new Date();
    const ts = now
        .toISOString()
        .replace(/[-:T.Z]/g, "")
        .substring(0, 14);
    return `rg-batch-${region}-${ts}`;
}

export class ProvisionerAgent implements Agent {
    readonly name = "provisioner" as const;
    private _cancelled = false;

    constructor(private readonly _ctx: AgentContext) {}

    cancel(): void {
        this._cancelled = true;
    }

    async execute(params: Record<string, unknown>): Promise<AgentResult> {
        const input = params as unknown as ProvisionerInput;
        const { store, scheduler, armUrl, getAccessToken } = this._ctx;
        this._cancelled = false;

        store.setAgentStatus("provisioner", "running");
        store.addLog({
            agent: "provisioner",
            level: "info",
            message: `Starting account provisioning for ${input.regions.length} regions`,
        });

        let created = 0;
        let failed = 0;
        const failures: Array<{ region: string; error: string }> = [];

        for (const region of input.regions) {
            if (this._cancelled) break;

            // Skip regions that already have a created account for this subscription
            const existing = store
                .getState()
                .accounts.find(
                    (a) =>
                        a.region === region &&
                        a.subscriptionId === input.subscriptionId &&
                        a.provisioningState === "created"
                );
            if (existing) {
                store.addLog({
                    agent: "provisioner",
                    level: "warn",
                    message: `Account already exists for ${region} (${existing.accountName}), skipping`,
                });
                continue;
            }

            const accountName = generateAccountName(region);
            const resourceGroup = generateResourceGroup(region);
            const accountId = `/subscriptions/${input.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Batch/batchAccounts/${accountName}`;

            const account: ManagedAccount = {
                id: accountId,
                accountName,
                resourceGroup,
                subscriptionId: input.subscriptionId,
                region,
                provisioningState: "pending",
                createdAt: new Date().toISOString(),
                error: null,
            };
            store.addAccount(account);

            try {
                store.updateAccount(accountId, {
                    provisioningState: "creating",
                });

                // Step 1: Create resource group
                await scheduler.run(input.subscriptionId, async () => {
                    const token = await getAccessToken();
                    const rgUrl = `${armUrl}/subscriptions/${input.subscriptionId}/resourcegroups/${resourceGroup}?api-version=2021-04-01`;
                    const response = await fetch(rgUrl, {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${token}`,
                        },
                        body: JSON.stringify({ location: region }),
                    });
                    if (!response.ok) {
                        const err = await response.json().catch(() => ({}));
                        throw {
                            status: response.status,
                            message:
                                err?.error?.message ??
                                `RG creation failed: ${response.status}`,
                            headers: response.headers,
                        };
                    }
                });

                // Step 2: Create Batch account
                await scheduler.run(input.subscriptionId, async () => {
                    const token = await getAccessToken();
                    const accountUrl = `${armUrl}/subscriptions/${input.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Batch/batchAccounts/${accountName}?api-version=2024-02-01`;
                    const response = await fetch(accountUrl, {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${token}`,
                        },
                        body: JSON.stringify({
                            location: region,
                            properties: { autoStorage: null },
                        }),
                    });
                    if (!response.ok) {
                        const err = await response.json().catch(() => ({}));
                        throw {
                            status: response.status,
                            message:
                                err?.error?.message ??
                                `Account creation failed: ${response.status}`,
                            headers: response.headers,
                        };
                    }
                });

                store.updateAccount(accountId, {
                    provisioningState: "created",
                });
                store.addLog({
                    agent: "provisioner",
                    level: "info",
                    message: `Created account ${accountName} in ${region}`,
                });
                created++;
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.updateAccount(accountId, {
                    provisioningState: "failed",
                    error: errorMsg,
                });
                store.addLog({
                    agent: "provisioner",
                    level: "error",
                    message: `Failed to create account in ${region}: ${errorMsg}`,
                });
                failures.push({ region, error: errorMsg });
                failed++;
            }
        }

        const status =
            failed === 0 ? "completed" : created === 0 ? "failed" : "partial";
        store.setAgentStatus(
            "provisioner",
            status === "failed" ? "error" : "completed"
        );
        store.addLog({
            agent: "provisioner",
            level: "info",
            message: `Provisioning complete: ${created} created, ${failed} failed out of ${input.regions.length}`,
        });

        return {
            status,
            summary: {
                total: input.regions.length,
                created,
                failed,
                failures,
            },
        };
    }
}
