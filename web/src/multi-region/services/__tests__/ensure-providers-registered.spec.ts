/**
 * Tests for `ensureProvidersRegistered` — the best-effort resource-provider
 * registration step that runs before Batch account creation.
 *
 * The behaviour under test: a 403 on the register POST (operator lacks the
 * subscription-scoped `<ns>/register/action` permission, or an Azure Policy
 * blocks registration) must be COLLECTED in `result.failed`, never thrown,
 * so a single forbidden namespace can't abort registration of the others —
 * nor the whole provisioning run. Previously this threw and the
 * provisioner-agent treated it as a hard abort, blocking account creation
 * even on subscriptions where the providers were already registered.
 *
 * `arm-service.test.ts` is intentionally NOT extended for this — the jest
 * runner only matches `*.spec.ts` (see util/common-config/jest-common.js
 * `testMatch`), so `.test.ts` files are dead. This file uses `.spec.ts`.
 */

// Mock guardedFetch so the service hits our fake instead of the network.
jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(),
}));

import * as armService from "../arm-service";
import { guardedFetch } from "../../scheduling/request-governance";

const guardedFetchMock = guardedFetch as jest.MockedFunction<
  typeof guardedFetch
>;

const VALID_SUB_ID = "11111111-2222-3333-4444-555555555555";

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headersMap = new Map<string, string>(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const headers = {
    get: (name: string): string | null =>
      headersMap.get(name.toLowerCase()) ?? null,
  } as unknown as Headers;
  const text = init.body !== undefined ? JSON.stringify(init.body) : "";
  return {
    status,
    statusText: init.statusText ?? "",
    ok: status >= 200 && status < 300,
    url: init.url ?? "https://management.azure.com/",
    headers,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(init.body as unknown),
    clone: () => makeResponse(init),
  } as unknown as Response;
}

interface ProviderPlan {
  /** registrationState returned by successive GETs (clamped to the last). */
  getStates: string[];
  /** false ⇒ the POST /register returns 403 AuthorizationFailed. */
  canRegister: boolean;
}

/**
 * Route guardedFetch by URL so the parallel per-namespace calls stay
 * deterministic regardless of completion order. Each namespace keeps an
 * independent GET cursor.
 */
function routeProviders(plans: Record<string, ProviderPlan>): void {
  const getCursor: Record<string, number> = {};
  guardedFetchMock.mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const ns = /\/providers\/([^/?]+)/.exec(u)?.[1] ?? "";
    const plan = plans[ns];

    if (method === "POST" && /\/register(\?|$)/.test(u)) {
      if (!plan || plan.canRegister) {
        return makeResponse({
          status: 200,
          body: { namespace: ns, registrationState: "Registering" },
          url: u,
        });
      }
      return makeResponse({
        status: 403,
        statusText: "Forbidden",
        body: {
          error: {
            code: "AuthorizationFailed",
            message: `no register permission for ${ns}`,
          },
        },
        url: u,
      });
    }

    const seq = plan?.getStates ?? ["Registered"];
    const idx = Math.min(getCursor[ns] ?? 0, seq.length - 1);
    getCursor[ns] = (getCursor[ns] ?? 0) + 1;
    return makeResponse({
      status: 200,
      body: { namespace: ns, registrationState: seq[idx] },
      url: u,
    });
  }) as unknown as typeof guardedFetch);
}

describe("ensureProvidersRegistered", () => {
  beforeEach(() => {
    guardedFetchMock.mockReset();
    // The Registered-namespace cache is module-level; clear it so cases
    // don't leak registration state into one another.
    armService._resetProviderRegistrationCacheForTest();
    // Make the inter-poll setTimeout resolve synchronously so the poll loop
    // doesn't add real wall-time to the suite.
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reports already-Registered namespaces without writing", async () => {
    routeProviders({
      "Microsoft.Batch": { getStates: ["Registered"], canRegister: true },
      "Microsoft.Storage": { getStates: ["Registered"], canRegister: true },
    });

    const result = await armService.ensureProvidersRegistered(
      VALID_SUB_ID,
      ["Microsoft.Batch", "Microsoft.Storage"],
      "tok",
    );

    expect(result.alreadyRegistered.sort()).toEqual([
      "Microsoft.Batch",
      "Microsoft.Storage",
    ]);
    expect(result.newlyRegistered).toEqual([]);
    expect(result.failed).toEqual([]);
    // No POST /register should have fired.
    const posts = guardedFetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(0);
  });

  it("registers a not-registered namespace and reports newlyRegistered", async () => {
    routeProviders({
      "Microsoft.Batch": {
        getStates: ["NotRegistered", "Registered"],
        canRegister: true,
      },
    });

    const result = await armService.ensureProvidersRegistered(
      VALID_SUB_ID,
      ["Microsoft.Batch"],
      "tok",
    );

    expect(result.newlyRegistered).toEqual(["Microsoft.Batch"]);
    expect(result.alreadyRegistered).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("collects a 403 register failure without aborting other namespaces", async () => {
    routeProviders({
      // Batch is unregistered and the operator can't register it.
      "Microsoft.Batch": {
        getStates: ["NotRegistered", "NotRegistered"],
        canRegister: false,
      },
      // Storage is already registered — must still be reported as such.
      "Microsoft.Storage": { getStates: ["Registered"], canRegister: true },
    });

    const result = await armService.ensureProvidersRegistered(
      VALID_SUB_ID,
      ["Microsoft.Batch", "Microsoft.Storage"],
      "tok",
    );

    expect(result.alreadyRegistered).toEqual(["Microsoft.Storage"]);
    expect(result.newlyRegistered).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.namespace).toBe("Microsoft.Batch");
    expect(result.failed[0]?.status).toBe(403);
    expect(result.failed[0]?.code).toBe("AuthorizationFailed");
  });

  it("recovers from a 403 when the re-check shows the provider Registered", async () => {
    routeProviders({
      // Register POST 403s, but a re-GET shows it became Registered
      // (another principal / an Azure Policy registered it concurrently).
      "Microsoft.Batch": {
        getStates: ["NotRegistered", "Registered"],
        canRegister: false,
      },
    });

    const result = await armService.ensureProvidersRegistered(
      VALID_SUB_ID,
      ["Microsoft.Batch"],
      "tok",
    );

    expect(result.alreadyRegistered).toEqual(["Microsoft.Batch"]);
    expect(result.failed).toEqual([]);
    expect(result.newlyRegistered).toEqual([]);
  });

  it("validates the subscription id before any fetch", async () => {
    await expect(
      armService.ensureProvidersRegistered("not-a-uuid", ["Microsoft.Batch"], "tok"),
    ).rejects.toThrow(/Invalid subscriptionId/);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });
});
