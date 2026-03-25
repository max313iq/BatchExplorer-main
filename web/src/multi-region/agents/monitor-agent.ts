import { Agent, AgentContext, AgentResult, MonitorInput } from "./agent-types";

export class MonitorAgent implements Agent {
    readonly name = "monitor" as const;
    private _cancelled = false;

    constructor(private readonly _ctx: AgentContext) {}

    cancel(): void {
        this._cancelled = true;
    }

    async execute(params: Record<string, unknown>): Promise<AgentResult> {
        const input = params as unknown as MonitorInput;
        const { store } = this._ctx;

        store.setAgentStatus("monitor", "running");
        store.addLog({
            agent: "monitor",
            level: "info",
            message: `Starting quota status monitoring (${input.mode} mode)`,
        });

        const intervalMs = (input.intervalSeconds ?? 60) * 1000;
        const maxMs = (input.maxPollingMinutes ?? 120) * 60 * 1000;
        const startTime = Date.now();

        let totalChecked = 0;
        let approved = 0;
        let denied = 0;
        let errors = 0;

        do {
            const result = await this._pollOnce();
            totalChecked += result.checked;
            approved += result.approved;
            denied += result.denied;
            errors += result.errors;

            if (input.mode === "one-shot") break;

            // Check if any pending remain
            const state = store.getState();
            const pendingCount = state.quotaRequests.filter(
                (r) => r.status === "pending" || r.status === "submitted"
            ).length;

            if (pendingCount === 0) {
                store.addLog({
                    agent: "monitor",
                    level: "info",
                    message: "All quota requests resolved",
                });
                break;
            }

            if (Date.now() - startTime >= maxMs) {
                store.addLog({
                    agent: "monitor",
                    level: "warn",
                    message: `Max polling time (${input.maxPollingMinutes}m) reached`,
                });
                break;
            }

            if (this._cancelled) break;

            // Wait before next poll
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, intervalMs);
                // Allow cancel to wake us up
                const checkCancel = setInterval(() => {
                    if (this._cancelled) {
                        clearTimeout(timer);
                        clearInterval(checkCancel);
                        resolve();
                    }
                }, 1000);
                setTimeout(() => {
                    clearInterval(checkCancel);
                }, intervalMs + 100);
            });
        } while (!this._cancelled);

        const stillPending = store
            .getState()
            .quotaRequests.filter(
                (r) => r.status === "pending" || r.status === "submitted"
            ).length;

        store.setAgentStatus("monitor", "completed");

        return {
            status: "completed",
            summary: {
                checked: totalChecked,
                approved,
                denied,
                stillPending,
                errors,
            },
        };
    }

    private async _pollOnce(): Promise<{
        checked: number;
        approved: number;
        denied: number;
        errors: number;
    }> {
        const { store, scheduler, armUrl, getAccessToken } = this._ctx;
        const state = store.getState();
        const pendingRequests = state.quotaRequests.filter(
            (r) => r.status === "pending" || r.status === "submitted"
        );

        let checked = 0;
        let approved = 0;
        let denied = 0;
        let errors = 0;

        for (const req of pendingRequests) {
            if (this._cancelled) break;

            try {
                await scheduler.run(req.subscriptionId, async () => {
                    const token = await getAccessToken();
                    const url = `${armUrl}/subscriptions/${req.subscriptionId}/providers/Microsoft.Support/supportTickets/${req.ticketId}?api-version=2025-06-01-preview`;

                    const response = await fetch(url, {
                        method: "GET",
                        headers: {
                            Authorization: `Bearer ${token}`,
                            Accept: "application/json",
                        },
                    });

                    if (!response.ok) {
                        throw {
                            status: response.status,
                            message: `Status check failed: ${response.status}`,
                            headers: response.headers,
                        };
                    }

                    const data = await response.json();
                    const ticketStatus =
                        data?.properties?.status?.toLowerCase() ?? "";
                    const severity =
                        data?.properties?.severity?.toLowerCase() ?? "";

                    const now = new Date().toISOString();

                    if (
                        ticketStatus === "resolved" ||
                        ticketStatus === "closed" ||
                        ticketStatus === "approved"
                    ) {
                        // Check if it was approved or denied
                        const resolution = data?.properties?.resolution ?? "";
                        const resolutionLower = resolution.toLowerCase();

                        if (
                            resolutionLower.includes("denied") ||
                            resolutionLower.includes("rejected") ||
                            resolutionLower.includes("not approved")
                        ) {
                            store.updateQuotaRequest(req.id, {
                                status: "denied",
                                resolvedAt: now,
                                lastCheckedAt: now,
                            });
                            store.addLog({
                                agent: "monitor",
                                level: "warn",
                                message: `Ticket ${req.ticketId} DENIED: ${resolution}`,
                            });
                            denied++;
                        } else {
                            store.updateQuotaRequest(req.id, {
                                status: "approved",
                                resolvedAt: now,
                                lastCheckedAt: now,
                            });
                            store.addLog({
                                agent: "monitor",
                                level: "info",
                                message: `Ticket ${req.ticketId} APPROVED`,
                            });
                            approved++;
                        }
                    } else if (
                        ticketStatus === "open" &&
                        severity === "critical"
                    ) {
                        // Escalated tickets — log but keep polling
                        store.updateQuotaRequest(req.id, {
                            lastCheckedAt: now,
                        });
                        store.addLog({
                            agent: "monitor",
                            level: "warn",
                            message: `Ticket ${req.ticketId} escalated (critical severity), still pending`,
                        });
                    } else {
                        store.updateQuotaRequest(req.id, {
                            lastCheckedAt: now,
                        });
                    }

                    checked++;
                });
            } catch (error: any) {
                store.addLog({
                    agent: "monitor",
                    level: "error",
                    message: `Error checking ticket ${req.ticketId}: ${error?.message ?? error}`,
                });
                errors++;
                checked++;
            }
        }

        store.addLog({
            agent: "monitor",
            level: "info",
            message: `Poll complete: ${checked} checked, ${approved} approved, ${denied} denied`,
        });

        return { checked, approved, denied, errors };
    }
}
