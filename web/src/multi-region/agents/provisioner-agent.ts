import {
    Agent,
    AgentContext,
    AgentResult,
    ProvisionerInput,
} from "./agent-types";
import { ManagedAccount } from "../store/store-types";
import {
    createResourceGroup,
    createBatchAccount,
} from "../services/arm-service";
import { AzureRequestError } from "../services/types";

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
    // Batch account names must be 3-24 chars, lowercase alphanumeric
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

/** Minimum delay between write operations (ms) to avoid throttling */
const WRITE_RATE_LIMIT_MS = 500;

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

        // SAFETY: Validate that the subscription is enabled before creating accounts
        const subscriptionOk = await this._validateSubscription(
            input.subscriptionId,
            armUrl,
            getAccessToken
        );
        if (!subscriptionOk.valid) {
            store.setAgentStatus("provisioner", "error");
            store.addLog({
                agent: "provisioner",
                level: "error",
                message: `Subscription ${input.subscriptionId} is not in a valid state: ${subscriptionOk.reason}. Aborting to prevent creating accounts that could be disabled.`,
            });
            return {
                status: "failed",
                summary: {
                    total: input.regions.length,
                    created: 0,
                    failed: input.regions.length,
                    failures: [
                        {
                            region: "*",
                            error: `Subscription not valid: ${subscriptionOk.reason}`,
                        },
                    ],
                },
            };
        }

        let created = 0;
        let failed = 0;
        const failures: Array<{ region: string; error: string }> = [];
        let lastWriteTime = 0;

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

            // Rate limit writes: enforce minimum delay between create operations
            const now = Date.now();
            const elapsed = now - lastWriteTime;
            if (elapsed < WRITE_RATE_LIMIT_MS && lastWriteTime > 0) {
                await new Promise((r) =>
                    setTimeout(r, WRITE_RATE_LIMIT_MS - elapsed)
                );
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
                    await createResourceGroup(
                        input.subscriptionId,
                        resourceGroup,
                        region,
                        token
                    );
                });

                // Step 2: Create Batch account
                await scheduler.run(input.subscriptionId, async () => {
                    const token = await getAccessToken();
                    await createBatchAccount(
                        input.subscriptionId,
                        resourceGroup,
                        accountName,
                        region,
                        token
                    );
                });

                lastWriteTime = Date.now();

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
                const errorMsg =
                    error instanceof AzureRequestError
                        ? error.message
                        : error?.message ?? String(error);
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
                lastWriteTime = Date.now();
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

    /**
     * SAFETY: Validate that the subscription is in an active/enabled state.
     * Never create accounts under disabled/warned/deleted subscriptions
     * as they will be immediately disabled.
     */
    private async _validateSubscription(
        subscriptionId: string,
        armUrl: string,
        getAccessToken: () => Promise<string>
    ): Promise<{ valid: boolean; reason?: string }> {
        try {
            const token = await getAccessToken();
            const url = `${armUrl}/subscriptions/${subscriptionId}?api-version=2022-12-01`;
            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
            });

            if (!response.ok) {
                return {
                    valid: false,
                    reason: `Cannot verify subscription: HTTP ${response.status}`,
                };
            }

            const data = await response.json();
            const state = data?.subscriptionPolicies?.spendingLimit;
            const subscriptionState = (data?.state ?? "").toLowerCase();

            // Only allow Enabled subscriptions
            if (subscriptionState !== "enabled" && subscriptionState !== "") {
                return {
                    valid: false,
                    reason: `Subscription state is "${data?.state}" (expected "Enabled")`,
                };
            }

            // Warn if spending limit is on (pay-as-you-go with spending limit = risk of disable)
            if (state === "On") {
                this._ctx.store.addLog({
                    agent: "provisioner",
                    level: "warn",
                    message: `Subscription ${subscriptionId} has spending limit ON — accounts may be disabled if limit is reached`,
                });
            }

            return { valid: true };
        } catch (error: any) {
            // If we cannot validate, proceed with caution but log a warning
            this._ctx.store.addLog({
                agent: "provisioner",
                level: "warn",
                message: `Could not validate subscription state: ${error?.message ?? error}. Proceeding with caution.`,
            });
            return { valid: true };
        }
    }
}
