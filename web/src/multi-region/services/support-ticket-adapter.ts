/**
 * Azure Support Ticket REST Adapter
 *
 * Isolates all Azure Support ticket API calls behind a single adapter.
 *
 * **Verified SDK gap**: As of 2025, there is NO official JavaScript/TypeScript
 * SDK for the Azure Support API (Microsoft.Support resource provider).
 * The REST API must be called directly. This adapter centralizes those calls
 * so the rest of the codebase does not scatter raw fetch() calls to the
 * Support endpoints.
 *
 * API reference:
 *   https://learn.microsoft.com/en-us/rest/api/support/
 *
 * Endpoints used:
 *   PUT  /subscriptions/{sub}/providers/Microsoft.Support/supportTickets/{id}
 *   GET  /subscriptions/{sub}/providers/Microsoft.Support/supportTickets/{id}
 *   GET  /subscriptions/{sub}/providers/Microsoft.Support/supportPlanTypes
 */

const API_VERSION = "2025-06-01-preview";

/** Parameters for creating a quota support ticket. */
export interface SubmitQuotaTicketParams {
    armUrl: string;
    subscriptionId: string;
    ticketId: string;
    token: string;
    body: Record<string, unknown>;
    /** Optional extra headers (correlation IDs, session IDs, etc.) */
    extraHeaders?: Record<string, string>;
}

/** Response shape returned by the Support Ticket PUT/GET calls. */
export interface SupportTicketResponse {
    ok: boolean;
    status: number;
    body: Record<string, unknown>;
    locationHeader?: string | null;
}

/** Describes a support plan returned by the supportPlanTypes list API. */
export interface SupportPlan {
    id: string;
    name: string;
    state: string;
    supportPlanId?: string;
}

/**
 * Adapter for the Azure Support REST API.
 *
 * There is NO JavaScript SDK for Microsoft.Support — this is by design.
 * All methods perform direct REST calls and return normalized responses.
 */
export class SupportTicketAdapter {
    /**
     * Create (PUT) a support ticket for a quota increase request.
     *
     * Maps to:
     *   PUT /subscriptions/{sub}/providers/Microsoft.Support/supportTickets/{id}?api-version=...
     */
    async submitQuotaTicket(
        params: SubmitQuotaTicketParams
    ): Promise<SupportTicketResponse> {
        const { armUrl, subscriptionId, ticketId, token, body, extraHeaders } =
            params;
        const url = `${armUrl}/subscriptions/${subscriptionId}/providers/Microsoft.Support/supportTickets/${ticketId}?api-version=${API_VERSION}`;

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...extraHeaders,
        };

        const response = await fetch(url, {
            method: "PUT",
            headers,
            body: JSON.stringify(body),
        });

        const responseBody = await response.json().catch(() => ({}));
        const locationHeader =
            response.headers.get("Location") ??
            response.headers.get("Azure-AsyncOperation");

        return {
            ok: response.ok,
            status: response.status,
            body: responseBody,
            locationHeader,
        };
    }

    /**
     * Check the status of an existing support ticket.
     *
     * Maps to:
     *   GET /subscriptions/{sub}/providers/Microsoft.Support/supportTickets/{id}?api-version=...
     */
    async getTicketStatus(
        subscriptionId: string,
        ticketId: string,
        token: string,
        armUrl = "https://management.azure.com"
    ): Promise<SupportTicketResponse> {
        const url = `${armUrl}/subscriptions/${subscriptionId}/providers/Microsoft.Support/supportTickets/${ticketId}?api-version=${API_VERSION}`;

        const response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
            },
        });

        const responseBody = await response.json().catch(() => ({}));

        return {
            ok: response.ok,
            status: response.status,
            body: responseBody,
        };
    }

    /**
     * Fetch available support plans for a subscription.
     * Used to determine the correct supportPlanId when submitting tickets.
     *
     * Maps to:
     *   GET /subscriptions/{sub}/providers/Microsoft.Support/supportPlanTypes?api-version=...
     */
    async fetchSupportPlanId(
        armUrl: string,
        subscriptionId: string,
        token: string
    ): Promise<SupportPlan[]> {
        const url = `${armUrl}/subscriptions/${subscriptionId}/providers/Microsoft.Support/supportPlanTypes?api-version=${API_VERSION}`;

        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        const plans = data.value ?? [];

        return plans.map((p: any) => ({
            id: p.id ?? "",
            name: p.name ?? "",
            state: p.properties?.state ?? "",
            supportPlanId: p.properties?.supportPlanId,
        }));
    }
}
