import { Agent, AgentContext, AgentResult, QuotaInput } from "./agent-types";
import { QuotaRequest } from "../store/store-types";

// Realistic name pools — diverse, common names that don't look generated
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
    "Pedro",
    "Susan",
    "John",
    "Anna",
    "Robert",
    "Elena",
    "William",
    "Sarah",
    "Michael",
    "Laura",
    "Thomas",
    "Julia",
];

const LAST_NAMES = [
    "Garcia",
    "Smith",
    "Johnson",
    "Kim",
    "Zhang",
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
    "Mita",
    "Velazquez",
    "Wilson",
    "Taylor",
    "Lee",
    "Walker",
    "Harris",
    "Clark",
    "Lewis",
    "Robinson",
    "Hall",
    "Young",
];

// Country codes that are commonly used for Azure support
const COUNTRIES = [
    "USA",
    "MEX",
    "GBR",
    "DEU",
    "FRA",
    "CAN",
    "AUS",
    "JPN",
    "IND",
    "BRA",
    "WLF",
];

// Timezones commonly seen in Azure portal
const TIMEZONES = [
    "Pacific Standard Time",
    "Eastern Standard Time",
    "Central Standard Time",
    "Mountain Standard Time",
    "GMT Standard Time",
    "Romance Standard Time",
    "Russian Standard Time",
    "Tokyo Standard Time",
    "India Standard Time",
    "AUS Eastern Standard Time",
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

// Cache support plan IDs per subscription
const supportPlanCache = new Map<string, string>();

async function fetchSupportPlanId(
    armUrl: string,
    subscriptionId: string,
    token: string
): Promise<string> {
    const cached = supportPlanCache.get(subscriptionId);
    if (cached) return cached;

    // Try to get the support plan type from the subscription
    try {
        const url = `${armUrl}/subscriptions/${subscriptionId}/providers/Microsoft.Support/supportPlanTypes?api-version=2025-06-01-preview`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (response.ok) {
            const data = await response.json();
            const plans = data.value ?? [];
            // Prefer paid plans, fall back to free
            const paid = plans.find(
                (p: any) =>
                    p.properties?.state === "Active" && p.name !== "Free"
            );
            const active =
                paid ??
                plans.find((p: any) => p.properties?.state === "Active");

            if (active?.id) {
                // Convert the ARM resource ID to the base64-encoded supportPlanId format
                // Format: Source:{PlanName},{PlanName}Id:{planGuid}
                const planName = active.name ?? "Free";
                const planId =
                    active.properties?.supportPlanId ??
                    "00000000-0000-0000-0000-000000000009";
                const raw = `Source:${planName},${planName}Id:${planId},`;
                const encoded = btoa(raw).replace(/=/g, "%3d");
                supportPlanCache.set(subscriptionId, encoded);
                return encoded;
            }
        }
    } catch {
        // Fall through to default
    }

    // Default Free plan ID (URL-encoded base64)
    const defaultPlan =
        "U291cmNlOkZyZWUsRnJlZUlkOjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwOSw%3d";
    supportPlanCache.set(subscriptionId, defaultPlan);
    return defaultPlan;
}

export class QuotaAgent implements Agent {
    readonly name = "quota" as const;
    private _cancelled = false;

    constructor(private readonly _ctx: AgentContext) {}

    cancel(): void {
        this._cancelled = true;
    }

    async execute(params: Record<string, unknown>): Promise<AgentResult> {
        const input = params as unknown as QuotaInput & {
            customToken?: string;
            ticketSubscriptionId?: string;
        };
        const { store, scheduler, armUrl, getAccessToken } = this._ctx;
        const resolveToken = input.customToken
            ? () => Promise.resolve(input.customToken!)
            : getAccessToken;
        this._cancelled = false;

        store.setAgentStatus("quota", "running");
        store.addLog({
            agent: "quota",
            level: "info",
            message: `Starting quota requests for ${input.accountIds.length} accounts (${input.quotaType}, limit: ${input.newLimit})`,
        });

        // Each ticket uses the Batch account's own subscription automatically

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

            // Ticket ID format: serviceId-problemClassId-uuid (matches Azure portal)
            const ticketGuid = `06bfd9d3-831b2fb3-${uuidV4()}`;
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
                    const token = await resolveToken();

                    // Randomize identity per request
                    const firstName = randomFrom(FIRST_NAMES);
                    const lastName = randomFrom(LAST_NAMES);
                    const country = randomFrom(COUNTRIES);
                    const timezone = randomFrom(TIMEZONES);

                    // Use the Batch account's own subscription
                    const url = `${armUrl}/subscriptions/${account.subscriptionId}/providers/Microsoft.Support/supportTickets/${ticketGuid}?api-version=2025-06-01-preview`;

                    // Auto-detect support plan for this account's subscription
                    const detectedPlan = await fetchSupportPlanId(
                        armUrl,
                        account.subscriptionId,
                        token
                    );
                    // Use auto-detected plan, or fall back to user-provided
                    const rawPlan = detectedPlan || input.supportPlanId;
                    const encodedPlan = rawPlan.includes("%3d")
                        ? rawPlan
                        : rawPlan.replace(/=/g, "%3d");

                    // Format payload with spaces (portal format)
                    const payloadStr = `{"AccountName": "${account.accountName}", "NewLimit": ${input.newLimit}, "Type": "${input.quotaType}"}`;

                    // Description matching Azure portal exactly
                    const quotaLabel =
                        input.quotaType === "LowPriority"
                            ? "Spot/low-priority"
                            : input.quotaType === "Spot"
                              ? "Spot/low-priority"
                              : input.quotaType;

                    const body = {
                        properties: {
                            contactDetails: {
                                firstName,
                                lastName,
                                preferredContactMethod: "email",
                                primaryEmailAddress: input.contactConfig.email,
                                preferredTimeZone: timezone,
                                country,
                                preferredSupportLanguage: "en-us",
                                additionalEmailAddresses: [],
                            },
                            description: `Request Summary / New Limit: \n${quotaLabel} vCPUs (all Series), ${account.region} / ${input.newLimit}\n`,
                            problemClassificationId:
                                "/providers/microsoft.support/services/06bfd9d3-516b-d5c6-5802-169c800dec89/problemclassifications/831b2fb3-4db3-3d32-af35-bbb3d3eaeba2",
                            serviceId:
                                "/providers/microsoft.support/services/06bfd9d3-516b-d5c6-5802-169c800dec89",
                            severity: "minimal",
                            title: "Quota request for Batch",
                            advancedDiagnosticConsent: "Yes",
                            require24X7Response: false,
                            supportPlanId: encodedPlan,
                            quotaTicketDetails: {
                                quotaChangeRequestVersion: "1.0",
                                quotaChangeRequestSubType: "Account",
                                quotaChangeRequests: [
                                    {
                                        region: account.region,
                                        payload: payloadStr,
                                    },
                                ],
                            },
                        },
                    };

                    // Build headers matching Azure portal exactly
                    const clientRequestId = uuidV4();
                    const correlationId = uuidV4();
                    const sessionId = randomHex(32);

                    const requestHeaders: Record<string, string> = {
                        accept: "text/plain, */*; q=0.01",
                        "accept-language": "en",
                        "content-type": "application/json",
                        Authorization: `Bearer ${token}`,
                        "x-ms-client-request-id": clientRequestId,
                        "x-ms-correlation-request-id": correlationId,
                        "x-ms-request-id": clientRequestId,
                        "x-ms-tracking-id": correlationId,
                        "x-ms-client-session-id": sessionId,
                        "x-ms-command-name": "Microsoft_Azure_Support.",
                        "x-ms-effective-locale": "en.en-us",
                        "x-ms-supportextension-caller-identifier":
                            "Microsoft_Azure_Batch",
                    };

                    const response = await fetch(url, {
                        method: "PUT",
                        headers: requestHeaders,
                        body: JSON.stringify(body),
                    });

                    const responseBody = await response
                        .json()
                        .catch(() => ({}));

                    // Log response for debugging
                    const locationHeader =
                        response.headers.get("Location") ??
                        response.headers.get("Azure-AsyncOperation");

                    store.addLog({
                        agent: "quota",
                        level: response.ok ? "info" : "error",
                        message: `[${account.accountName}] ${response.status} | ${JSON.stringify(responseBody).substring(0, 200)}`,
                    });

                    if (!response.ok) {
                        throw {
                            status: response.status,
                            message:
                                responseBody?.error?.message ??
                                `Quota request failed: ${response.status}`,
                        };
                    }

                    // If 202, poll to confirm ticket creation
                    if (response.status === 202) {
                        if (locationHeader) {
                            await this._pollAsyncOp(
                                locationHeader,
                                resolveToken,
                                account.accountName,
                                store
                            );
                        } else {
                            // No location header — verify by GET after delay
                            await new Promise((r) => setTimeout(r, 5000));
                            const vToken = await resolveToken();
                            const vRes = await fetch(url, {
                                headers: {
                                    Authorization: `Bearer ${vToken}`,
                                },
                            });
                            const vBody = await vRes.json().catch(() => ({}));
                            store.addLog({
                                agent: "quota",
                                level: vRes.status === 200 ? "info" : "warn",
                                message: `[${account.accountName}] Verify: ${vRes.status} | ${JSON.stringify(vBody).substring(0, 150)}`,
                            });

                            if (vRes.status !== 200) {
                                throw {
                                    status: vRes.status,
                                    message: `Ticket not confirmed after 202. GET returned ${vRes.status}`,
                                };
                            }
                        }
                    }

                    // Check for hidden failures in response body
                    const props = responseBody?.properties;
                    if (
                        props?.status === "Failed" ||
                        props?.serviceErrorMessage
                    ) {
                        throw {
                            status: response.status,
                            message:
                                props.serviceErrorMessage ??
                                "Ticket creation failed",
                        };
                    }
                });

                store.updateQuotaRequest(requestId, {
                    status: "submitted",
                });
                store.addLog({
                    agent: "quota",
                    level: "info",
                    message: `Submitted quota ticket ${ticketGuid} for ${account.accountName} (${account.region})`,
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
                    message: `Failed: ${account.accountName}: ${errorMsg}`,
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

    private async _pollAsyncOp(
        locationUrl: string,
        resolveToken: () => Promise<string>,
        accountName: string,
        store: AgentContext["store"]
    ): Promise<void> {
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const token = await resolveToken();
            const res = await fetch(locationUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const body = await res.json().catch(() => ({}));

            store.addLog({
                agent: "quota",
                level: "info",
                message: `[${accountName}] Poll #${i + 1}: ${res.status} | ${JSON.stringify(body).substring(0, 150)}`,
            });

            if (res.status === 200) return;
            if (body?.error || body?.properties?.status === "Failed") {
                throw new Error(
                    body?.error?.message ??
                        body?.properties?.serviceErrorMessage ??
                        "Async operation failed"
                );
            }
            if (res.status !== 202) return;
        }
    }
}
