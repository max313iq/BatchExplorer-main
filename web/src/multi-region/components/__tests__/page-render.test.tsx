/**
 * Smoke-render tests for every page mounted by the dashboard `<PageRouter>`.
 *
 * Each test mounts the router at one of the canonical paths (e.g. `/overview`,
 * `/pools`, `/audit-log`) under a `<MemoryRouter>` + `<MultiRegionStoreProvider>`
 * with a heavily mocked orchestrator and stubbed-out service / auth modules so
 * the pages don't touch the network or MSAL.
 *
 * The assertions are deliberately minimal — render must not throw, and the
 * page's heading text (rendered via the shared `<PageHeader title=...>` or an
 * inline `<h1>`) must appear in the DOM. This is enough to guarantee the route
 * wiring matches `page-router.tsx` for all 15 paths and that the page modules
 * import-load cleanly under the test environment.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { MultiRegionStoreProvider } from "../../store/store-context";
import { MultiRegionStore } from "../../store/multi-region-store";
import { PageRouter } from "../page-router";

// ---------------------------------------------------------------------------
// Module mocks — keep the dependency graph small so a smoke render of any
// page returns synchronously and never queues a real network call.
// ---------------------------------------------------------------------------

// Bonito theme deps used by some leaf editors (e.g. MonacoEditor in pool-creation).
// We replace with a plain stub so requiring the page doesn't pull in monaco.
jest.mock("@azure/bonito-ui", () => ({}), { virtual: true });
jest.mock("@azure/bonito-core", () => ({}), { virtual: true });
jest.mock(
    "@azure/bonito-ui/lib/components",
    () => ({
        MonacoEditor: () => null,
    }),
    { virtual: true },
);

// OrchestratorAgent — pages only need a constructable object with cancel/execute.
jest.mock("../../agents/orchestrator-agent", () => {
    return {
        OrchestratorAgent: jest.fn().mockImplementation(() => ({
            execute: jest.fn().mockResolvedValue({ status: "completed", summary: {} }),
            cancel: jest.fn(),
            requestCancel: jest.fn(),
            isRunning: jest.fn().mockReturnValue(false),
        })),
    };
});

// MSAL — every page imports something from this module. Return safe defaults
// (empty arrays / null) so the discovery effects exit immediately.
jest.mock("../../auth/msal-auth", () => ({
    getActiveTenant: jest.fn().mockReturnValue(null),
    setActiveTenant: jest.fn(),
    clearActiveTenant: jest.fn(),
    getAllLoggedInAccounts: jest.fn().mockResolvedValue([]),
    getArmTokenForAccount: jest.fn().mockResolvedValue(""),
    getBatchTokenForAccount: jest.fn().mockResolvedValue(""),
    getGraphTokenForAccount: jest.fn().mockResolvedValue(""),
    listAccessibleTenants: jest.fn().mockResolvedValue([]),
    listSubscriptionsForAccount: jest.fn().mockResolvedValue([]),
    login: jest.fn().mockResolvedValue(null),
    loginAccount: jest.fn().mockResolvedValue(null),
    logoutAccount: jest.fn().mockResolvedValue(undefined),
    listSubscriptions: jest.fn().mockResolvedValue([]),
    getAuthMode: jest.fn().mockResolvedValue("msal"),
    getArmToken: jest.fn().mockResolvedValue(""),
    getBatchToken: jest.fn().mockResolvedValue(""),
    getGraphToken: jest.fn().mockResolvedValue(""),
    isAuthenticated: jest.fn().mockResolvedValue(false),
    getCurrentUser: jest.fn().mockResolvedValue(null),
    purgeMsalCache: jest.fn(),
    handlePopupIfNeeded: jest.fn().mockReturnValue(false),
    setTokenProvider: jest.fn(),
    msalAuth: {},
}));

// Services barrel — pages import named functions that hit ARM / Batch APIs.
// Provide a permissive proxy that returns sensible defaults for any property.
jest.mock("../../services", () => ({
    AzureRequestError: class AzureRequestError extends Error {},
    listSubscriptions: jest.fn().mockResolvedValue([]),
    listBatchAccounts: jest.fn().mockResolvedValue([]),
    getBatchAccount: jest.fn().mockResolvedValue(null),
    listPools: jest.fn().mockResolvedValue([]),
    createPool: jest.fn().mockResolvedValue(undefined),
    patchPool: jest.fn().mockResolvedValue(undefined),
    removeNodes: jest.fn().mockResolvedValue(undefined),
    deletePool: jest.fn().mockResolvedValue(undefined),
    listNodes: jest.fn().mockResolvedValue([]),
    performNodeAction: jest.fn().mockResolvedValue(undefined),
    listOrgUsers: jest.fn().mockResolvedValue([]),
    getMyDirectoryRoles: jest.fn().mockResolvedValue([]),
    resetUserPassword: jest.fn().mockResolvedValue(undefined),
    canResetPasswords: jest.fn().mockReturnValue(false),
    canCreateUsers: jest.fn().mockReturnValue(false),
    createUser: jest.fn().mockResolvedValue(null),
    listVerifiedDomains: jest.fn().mockResolvedValue([]),
    listOrgSubscriptions: jest.fn().mockResolvedValue([]),
    listEaBillingAccounts: jest.fn().mockResolvedValue([]),
    listBillingProfiles: jest.fn().mockResolvedValue([]),
    createEaSubscription: jest.fn().mockResolvedValue(null),
    createResourceGroup: jest.fn().mockResolvedValue(undefined),
    createBatchAccount: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/graph-service", () => ({
    listOrgUsers: jest.fn().mockResolvedValue([]),
    getMyDirectoryRoles: jest.fn().mockResolvedValue([]),
    getUserDirectoryRoles: jest.fn().mockResolvedValue([]),
    resetUserPassword: jest.fn().mockResolvedValue(undefined),
    canResetPasswords: jest.fn().mockReturnValue(false),
    canCreateUsers: jest.fn().mockReturnValue(false),
    createUser: jest.fn().mockResolvedValue(null),
    listVerifiedDomains: jest.fn().mockResolvedValue([]),
    listOrgSubscriptions: jest.fn().mockResolvedValue([]),
    ROLE_GLOBAL_ADMIN: "62e90394-69f5-4237-9190-012177145e10",
    ROLE_USER_ADMIN: "fe930be7-5e62-47db-91af-98c3a49a38b1",
    ROLE_HELPDESK_ADMIN: "729827e3-9c14-49f7-bb1b-9608f156bbb8",
    ROLE_AUTHENTICATION_ADMIN: "c4e39bd9-1100-46d3-8c65-fb160da0071f",
    ROLE_PRIVILEGED_AUTH_ADMIN: "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
}));

jest.mock("../../services/audit-log", () => {
    const listeners = new Set<() => void>();
    return {
        auditLog: {
            record: jest.fn(),
            getEntries: jest.fn().mockReturnValue([]),
            onChange: jest.fn().mockImplementation((cb: () => void) => {
                listeners.add(cb);
                return () => listeners.delete(cb);
            }),
            clear: jest.fn(),
        },
        bindAuditLogToStore: jest.fn(),
    };
});

// ---------------------------------------------------------------------------
// Helper — mount the router at a canonical path with a fresh store.
// ---------------------------------------------------------------------------

function renderAt(path: string): void {
    // Re-construct the orchestrator each render so jest.fn() state is fresh.
    const { OrchestratorAgent } = jest.requireMock(
        "../../agents/orchestrator-agent",
    ) as { OrchestratorAgent: jest.Mock };
    const orchestrator = new OrchestratorAgent({} as never);
    const store = new MultiRegionStore();
    render(
        <MemoryRouter initialEntries={[path]}>
            <MultiRegionStoreProvider store={store}>
                <PageRouter
                    orchestrator={orchestrator as never}
                    store={store}
                />
            </MultiRegionStoreProvider>
        </MemoryRouter>,
    );
}

/**
 * Heading lookup. Most pages render their title via the shared `<PageHeader>`
 * (renders an `<h1>`); the `<OverviewPage>` uses its own inline `<h1>`. The
 * `/audit-log` route is currently served by the in-router placeholder which
 * also renders an `<h1>` reading "Audit Log".
 */
function expectHeading(pattern: RegExp): void {
    const heading = screen.getByRole("heading", { level: 1, name: pattern });
    expect(heading).toBeInTheDocument();
}

// ---------------------------------------------------------------------------
// Tests — one per canonical route. Names mirror the path so failures are
// easy to map back to the router table in `page-router.tsx`.
// ---------------------------------------------------------------------------

describe("PageRouter — smoke render every page", () => {
    it("/azure-accounts mounts with heading", () => {
        renderAt("/azure-accounts");
        expectHeading(/Azure Accounts/i);
    });

    it("/overview mounts with heading", () => {
        renderAt("/overview");
        expectHeading(/Multi-Region Manager/i);
    });

    it("/accounts mounts with heading", () => {
        renderAt("/accounts");
        expectHeading(/Account Provisioning/i);
    });

    it("/pools mounts with heading", () => {
        renderAt("/pools");
        expectHeading(/Pool Creation/i);
    });

    it("/pool-defaults mounts with heading", () => {
        renderAt("/pool-defaults");
        expectHeading(/Pool Default Settings/i);
    });

    it("/pool-info mounts with heading", () => {
        renderAt("/pool-info");
        expectHeading(/Pool Info/i);
    });

    it("/account-info mounts with heading", () => {
        renderAt("/account-info");
        expectHeading(/Account Info/i);
    });

    it("/unused-quota mounts with heading", () => {
        renderAt("/unused-quota");
        expectHeading(/Unused Quota/i);
    });

    it("/monitoring mounts with heading", () => {
        renderAt("/monitoring");
        expectHeading(/Monitoring/i);
    });

    it("/nodes mounts with heading", () => {
        renderAt("/nodes");
        expectHeading(/Nodes/i);
    });

    it("/gpu-calculator mounts with heading", () => {
        renderAt("/gpu-calculator");
        expectHeading(/GPU Calculator/i);
    });

    it("/audit-log mounts with heading", () => {
        // The router currently serves an in-router placeholder for this
        // route while the standalone audit-log page is being extracted from
        // the legacy mega-file (see page-router.tsx note). The placeholder
        // still renders an h1 reading "Audit Log".
        renderAt("/audit-log");
        expectHeading(/Audit Log/i);
    });

    it("/tenant-users mounts with heading", () => {
        renderAt("/tenant-users");
        expectHeading(/Tenant Users/i);
    });

    it("/user-creator mounts with heading", () => {
        renderAt("/user-creator");
        expectHeading(/Create AD User/i);
    });

    it("/ea-subscription mounts with heading", () => {
        renderAt("/ea-subscription");
        expectHeading(/Create EA Subscription/i);
    });
});
