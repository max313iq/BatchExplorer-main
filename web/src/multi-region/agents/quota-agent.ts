import { Agent, AgentContext, AgentResult, QuotaInput } from "./agent-types";
import { QuotaRequest } from "../store/store-types";

const FIRST_NAMES = [
    "James",
    "Maria",
    "David",
    "Sofia",
    "Carlos",
    "Emily",
    "Ahmed",
    "Yuki",
    "Lars",
    "Priya",
    "Chen",
    "Fatima",
    "Oliver",
    "Aisha",
    "Ivan",
    "Sakura",
    "Miguel",
    "Noor",
];

const LAST_NAMES = [
    "Garcia",
    "Smith",
    "Johnson",
    "Kim",
    "Zhang",
    "Müller",
    "Anderson",
    "Tanaka",
    "Rodriguez",
    "Patel",
    "Brown",
    "Nakamura",
    "Martinez",
    "Ibrahim",
    "Johansson",
    "Singh",
];

function randomFrom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function uuidV4(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function randomHex(length: number): string {
    let result = "";
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 16).toString(16);
    }
    return result;
}

export class QuotaAgent implements Agent {
    readonly name = "quota" as const;
    private _cancelled = false;

    constructor(private readonly _ctx: AgentContext) {}

    cancel(): void {
        this._cancelled = true;
    }

    async execute(params: Record<string, unknown>): Promise<AgentResult> {
        const input = params as unknown as QuotaInput;
        const { store, scheduler, armUrl, getAccessToken } = this._ctx;
        this._cancelled = false;

        store.setAgentStatus("quota", "running");
        store.addLog({
            agent: "quota",
            level: "info",
            message: `Starting quota requests for ${input.accountIds.length} accounts (${input.quotaType}, limit: ${input.newLimit})`,
        });

        let submitted = 0;
        let failed = 0;
        const ticketIds: string[] = [];
        const failures: Array<{ accountId: string; error: string }> = [];

        for (const accountId of input.accountIds) {
            if (this._cancelled) break;

            const state = store.getState();
            const account = state.accounts.find((a) => a.id === accountId);
            if (!account) {
                store.addLog({
                    agent: "quota",
                    level: "warn",
                    message: `Account ${accountId} not found in store, skipping`,
                });
                continue;
            }

            const ticketGuid = uuidV4();
            const requestId = uuidV4();

            const quotaRequest: QuotaRequest = {
                id: requestId,
                accountId,
                ticketId: ticketGuid,
                subscriptionId: account.subscriptionId,
                region: account.region,
                quotaType: input.quotaType,
                requestedLimit: input.newLimit,
                status: "pending",
                submittedAt: new Date().toISOString(),
                error: null,
            };
            store.addQuotaRequest(quotaRequest);

            try {
                await scheduler.run(account.subscriptionId, async () => {
                    const token = await getAccessToken();
                    const firstName = randomFrom(FIRST_NAMES);
                    const lastName = randomFrom(LAST_NAMES);
                    const fingerprint = `fp-${randomHex(8)}`;

                    const url = `${armUrl}/subscriptions/${account.subscriptionId}/providers/Microsoft.Support/supportTickets/${ticketGuid}?api-version=2025-06-01-preview`;

                    const body = {
                        properties: {
                            contactDetails: {
                                firstName,
                                lastName,
                                preferredContactMethod: "email",
                                primaryEmailAddress: input.contactConfig.email,
                                preferredTimeZone: input.contactConfig.timezone,
                                country: input.contactConfig.country,
                                preferredSupportLanguage:
                                    input.contactConfig.language,
                                additionalEmailAddresses: [],
                            },
                            description: `Request Summary / New Limit:\n${input.quotaType} vCPUs (all Series), ${account.region} / ${input.newLimit}\n`,
                            problemClassificationId:
                                "/providers/microsoft.support/services/06bfd9d3-516b-d5c6-5802-169c800dec89/problemclassifications/831b2fb3-4db3-3d32-af35-bbb3d3eaeba2",
                            serviceId:
                                "/providers/microsoft.support/services/06bfd9d3-516b-d5c6-5802-169c800dec89",
                            severity: "minimal",
                            title: "Quota request for Batch",
                            advancedDiagnosticConsent: "Yes",
                            require24X7Response: false,
                            supportPlanId: input.supportPlanId,
                            quotaTicketDetails: {
                                quotaChangeRequestVersion: "1.0",
                                quotaChangeRequestSubType: "Account",
                                quotaChangeRequests: [
                                    {
                                        region: account.region,
                                        payload: JSON.stringify({
                                            AccountName: account.accountName,
                                            NewLimit: input.newLimit,
                                            Type: input.quotaType,
                                        }),
                                    },
                                ],
                            },
                        },
                    };

                    const response = await fetch(url, {
                        method: "PUT",
                        headers: {
                            Accept: "*/*",
                            "Accept-Language": "en",
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${token}`,
                            "User-Agent": `AzureQuotaBot/1.0 ${fingerprint}`,
                            "x-ms-client-request-id": uuidV4(),
                            "x-ms-correlation-request-id": uuidV4(),
                        },
                        body: JSON.stringify(body),
                    });

                    if (!response.ok) {
                        const err = await response.json().catch(() => ({}));
                        throw {
                            status: response.status,
                            message:
                                err?.error?.message ??
                                `Quota request failed: ${response.status}`,
                            headers: response.headers,
                        };
                    }
                });

                store.updateQuotaRequest(requestId, {
                    status: "submitted",
                });
                store.addLog({
                    agent: "quota",
                    level: "info",
                    message: `Submitted quota ticket ${ticketGuid} for ${account.accountName} in ${account.region}`,
                });
                ticketIds.push(ticketGuid);
                submitted++;
            } catch (error: any) {
                const errorMsg = error?.message ?? String(error);
                store.updateQuotaRequest(requestId, {
                    status: "failed",
                    error: errorMsg,
                });
                store.addLog({
                    agent: "quota",
                    level: "error",
                    message: `Failed quota request for ${account.accountName}: ${errorMsg}`,
                });
                failures.push({ accountId, error: errorMsg });
                failed++;
            }
        }

        const status =
            failed === 0 ? "completed" : submitted === 0 ? "failed" : "partial";
        store.setAgentStatus(
            "quota",
            status === "failed" ? "error" : "completed"
        );

        return {
            status,
            summary: {
                total: input.accountIds.length,
                submitted,
                failed,
                ticketIds,
                failures,
            },
        };
    }
}
