import * as armService from "../arm-service";
import {
  AuthError,
  RateLimitError,
  NotFoundError,
  TransientError,
  ValidationError,
  AzureRequestError,
} from "../types";

// Mock guardedFetch so the service hits our fake instead of network.
// (Matches the convention used by graph-service.test.ts.)
jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(),
}));

import { guardedFetch } from "../../scheduling/request-governance";

const guardedFetchMock = guardedFetch as jest.MockedFunction<
  typeof guardedFetch
>;

// ---------------------------------------------------------------------------
// Response factory
// ---------------------------------------------------------------------------

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  url?: string;
  body?: unknown;
  rawText?: string;
  headers?: Record<string, string>;
}

/**
 * Build a Response-like object compatible with everything `arm-service`
 * touches: `.ok`, `.status`, `.statusText`, `.url`, `.headers.get(...)`,
 * `.text()`, `.json()`, and `.clone()` for retry-after sniffing.
 */
function makeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const statusText = init.statusText ?? "";
  const url = init.url ?? "https://management.azure.com/";
  const headersMap = new Map<string, string>(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const headers = {
    get: (name: string): string | null =>
      headersMap.get(name.toLowerCase()) ?? null,
  } as unknown as Headers;

  const text =
    init.rawText !== undefined
      ? init.rawText
      : init.body !== undefined
        ? JSON.stringify(init.body)
        : "";

  const response = {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    url,
    headers,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(init.body as unknown),
    clone: () => makeResponse(init),
  };

  return response as unknown as Response;
}

function queueResponses(responses: Response[]): void {
  for (const r of responses) {
    guardedFetchMock.mockResolvedValueOnce(r);
  }
}

const VALID_SUB_ID = "11111111-2222-3333-4444-555555555555";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("arm-service", () => {
  beforeEach(() => {
    guardedFetchMock.mockReset();
    // Avoid real timer waits in pollAsyncOperation paths (5 s default).
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

  // -------------------------------------------------------------------------
  // listSubscriptions
  // -------------------------------------------------------------------------
  describe("listSubscriptions", () => {
    it("returns subscriptions on 200, following nextLink pagination", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                subscriptionId: "sub-1",
                displayName: "First",
                state: "Enabled",
                tenantId: "t-1",
              },
            ],
            nextLink: "https://management.azure.com/subscriptions?next=2",
          },
        }),
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                subscriptionId: "sub-2",
                displayName: "Second",
                state: "Enabled",
                tenantId: "t-1",
              },
            ],
          },
        }),
      ]);

      const subs = await armService.listSubscriptions("token");
      expect(subs).toHaveLength(2);
      expect(subs[0]?.subscriptionId).toBe("sub-1");
      expect(subs[1]?.subscriptionId).toBe("sub-2");
      expect(guardedFetchMock).toHaveBeenCalledTimes(2);

      // Verify Authorization header on first call.
      const firstCall = guardedFetchMock.mock.calls[0];
      const init = firstCall?.[1];
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe("Bearer token");
    });

    it("throws AzureRequestError on 401 (Auth failure)", async () => {
      queueResponses([
        makeResponse({
          status: 401,
          statusText: "Unauthorized",
          body: { error: { code: "InvalidAuthentication", message: "bad token" } },
        }),
      ]);

      try {
        await armService.listSubscriptions("bad");
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err).toBeInstanceOf(AzureRequestError);
        expect(err.status).toBe(401);
        expect(err.message).toContain("bad token");
      }
    });

    it("surfaces 5xx errors with parsed message", async () => {
      queueResponses([
        makeResponse({
          status: 503,
          statusText: "Service Unavailable",
          body: { error: { code: "ServiceUnavailable", message: "Try later" } },
        }),
      ]);

      await expect(armService.listSubscriptions("t")).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  // -------------------------------------------------------------------------
  // listBatchAccounts
  // -------------------------------------------------------------------------
  describe("listBatchAccounts", () => {
    it("returns accounts when subscription is valid", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                id: "/subscriptions/x/y/accountA",
                name: "accountA",
                type: "Microsoft.Batch/batchAccounts",
                location: "eastus",
                properties: {},
              },
            ],
          },
        }),
      ]);

      const accounts = await armService.listBatchAccounts(VALID_SUB_ID, "tok");
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.name).toBe("accountA");
    });

    it("throws on invalid subscription ID format before any fetch", async () => {
      await expect(
        armService.listBatchAccounts("not-a-uuid", "tok"),
      ).rejects.toThrow(/Invalid subscriptionId/);
      expect(guardedFetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getBatchAccount
  // -------------------------------------------------------------------------
  describe("getBatchAccount", () => {
    it("returns an account on 200", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            id: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Batch/batchAccounts/foo",
            name: "foo",
            type: "Microsoft.Batch/batchAccounts",
            location: "eastus",
            properties: { provisioningState: "Succeeded" },
          },
        }),
      ]);

      const acct = await armService.getBatchAccount(
        VALID_SUB_ID,
        "rg",
        "foobar",
        "tok",
      );
      expect(acct.name).toBe("foo");
    });

    it("throws on invalid account name", async () => {
      await expect(
        armService.getBatchAccount(VALID_SUB_ID, "rg", "BAD_NAME!", "tok"),
      ).rejects.toThrow(/Invalid accountName/);
    });

    it("translates 404 to AzureRequestError with status 404", async () => {
      queueResponses([
        makeResponse({
          status: 404,
          statusText: "Not Found",
          body: { error: { code: "ResourceNotFound", message: "no such" } },
        }),
      ]);

      await expect(
        armService.getBatchAccount(VALID_SUB_ID, "rg", "missing", "tok"),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("translates 429 with retry-after into a rate-limit response", async () => {
      queueResponses([
        makeResponse({
          status: 429,
          statusText: "Too Many Requests",
          body: { error: { code: "TooManyRequests", message: "slow down" } },
          headers: { "retry-after": "30" },
        }),
      ]);

      await expect(
        armService.getBatchAccount(VALID_SUB_ID, "rg", "okay", "tok"),
      ).rejects.toMatchObject({ status: 429 });
    });

    it("falls back to raw text when error body is non-JSON", async () => {
      queueResponses([
        makeResponse({
          status: 400,
          statusText: "Bad Request",
          rawText: "<html>Bad request</html>",
        }),
      ]);

      try {
        await armService.getBatchAccount(VALID_SUB_ID, "rg", "okay", "tok");
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err.status).toBe(400);
        expect(err.message).toContain("400");
      }
    });
  });

  // -------------------------------------------------------------------------
  // createResourceGroup
  // -------------------------------------------------------------------------
  describe("createResourceGroup", () => {
    it("PUTs and returns the resource group", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            id: "/subscriptions/x/resourceGroups/rg",
            name: "rg",
            location: "eastus",
            properties: { provisioningState: "Succeeded" },
          },
        }),
      ]);

      const rg = await armService.createResourceGroup(
        VALID_SUB_ID,
        "rg",
        "eastus",
        "tok",
      );
      expect(rg.name).toBe("rg");
      const call = guardedFetchMock.mock.calls[0];
      const init = call?.[1] as RequestInit | undefined;
      expect(init?.method).toBe("PUT");
      // Body must include the location.
      const bodyStr = (init?.body ?? "") as string;
      expect(bodyStr).toContain("eastus");
    });

    it("throws on 400 from ARM", async () => {
      queueResponses([
        makeResponse({
          status: 400,
          statusText: "Bad Request",
          body: {
            error: { code: "InvalidLocation", message: "bad region" },
          },
        }),
      ]);

      await expect(
        armService.createResourceGroup(VALID_SUB_ID, "rg", "bogus", "tok"),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("validates subscription ID before calling fetch", async () => {
      await expect(
        armService.createResourceGroup("not-uuid", "rg", "eastus", "tok"),
      ).rejects.toThrow(/Invalid subscriptionId/);
      expect(guardedFetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // createBatchAccount
  // -------------------------------------------------------------------------
  describe("createBatchAccount", () => {
    it("returns immediately on 200 with provisioningState=Succeeded", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            id: "/subs/x/y/foobar",
            name: "foobar",
            type: "Microsoft.Batch/batchAccounts",
            location: "eastus",
            properties: { provisioningState: "Succeeded" },
          },
        }),
      ]);

      const acct = await armService.createBatchAccount(
        VALID_SUB_ID,
        "rg",
        "foobar",
        "eastus",
        "tok",
      );
      expect(acct.name).toBe("foobar");
    });

    it("rejects with status 400 when ARM returns bad request", async () => {
      queueResponses([
        makeResponse({
          status: 400,
          statusText: "Bad Request",
          body: {
            error: { code: "AccountNameInUse", message: "name already taken" },
          },
        }),
      ]);

      await expect(
        armService.createBatchAccount(
          VALID_SUB_ID,
          "rg",
          "foobar",
          "eastus",
          "tok",
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("validates subscription and account name before calling fetch", async () => {
      await expect(
        armService.createBatchAccount(
          "bad",
          "rg",
          "foobar",
          "eastus",
          "tok",
        ),
      ).rejects.toThrow(/Invalid subscriptionId/);
      await expect(
        armService.createBatchAccount(
          VALID_SUB_ID,
          "rg",
          "AB",
          "eastus",
          "tok",
        ),
      ).rejects.toThrow(/Invalid accountName/);
      expect(guardedFetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // listEaBillingAccounts
  // -------------------------------------------------------------------------
  describe("listEaBillingAccounts", () => {
    it("returns EA billing accounts when filter call succeeds", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                id: "/providers/Microsoft.Billing/billingAccounts/ea123",
                name: "ea123",
                properties: {
                  displayName: "EA 123",
                  agreementType: "EnterpriseAgreement",
                  accountStatus: "Active",
                  accountType: "Enterprise",
                },
              },
              // Non-EA — must be filtered out client-side.
              {
                id: "/providers/Microsoft.Billing/billingAccounts/mca456",
                name: "mca456",
                properties: {
                  displayName: "MCA 456",
                  agreementType: "MicrosoftCustomerAgreement",
                },
              },
            ],
          },
        }),
      ]);

      const list = await armService.listEaBillingAccounts("tok");
      expect(list).toHaveLength(1);
      expect(list[0]?.name).toBe("ea123");
    });

    it("falls back to unfiltered list when filtered call returns 400", async () => {
      queueResponses([
        // Filtered call returns 400 — service retries without filter.
        makeResponse({
          status: 400,
          statusText: "Bad Request",
          body: {
            error: {
              code: "BadRequest",
              message: "filter not supported",
            },
          },
        }),
        // Fallback call succeeds.
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                id: "/providers/Microsoft.Billing/billingAccounts/ea-fallback",
                name: "ea-fallback",
                properties: {
                  agreementType: "EnterpriseAgreement",
                  displayName: "EA Fallback",
                  accountStatus: "Active",
                  accountType: "Enterprise",
                },
              },
            ],
          },
        }),
      ]);

      const list = await armService.listEaBillingAccounts("tok");
      expect(list).toHaveLength(1);
      expect(list[0]?.name).toBe("ea-fallback");
      expect(guardedFetchMock).toHaveBeenCalledTimes(2);
    });

    it("re-throws non-400 errors from the filtered call", async () => {
      queueResponses([
        makeResponse({
          status: 401,
          statusText: "Unauthorized",
          body: { error: { code: "Forbidden", message: "denied" } },
        }),
      ]);

      await expect(armService.listEaBillingAccounts("tok")).rejects.toMatchObject(
        { status: 401 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // EA child listings
  // -------------------------------------------------------------------------
  describe("EA child listings", () => {
    it("listBillingProfiles maps API rows", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                id: "/.../billingProfiles/bp-1",
                name: "bp-1",
                properties: { displayName: "BP One", status: "Active" },
              },
            ],
          },
        }),
      ]);

      const profiles = await armService.listBillingProfiles("ea-acct", "tok");
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.displayName).toBe("BP One");
    });

    it("listBillingProfiles validates billing account name", async () => {
      await expect(
        armService.listBillingProfiles("bad name with spaces!", "tok"),
      ).rejects.toThrow(/Invalid billingAccountName/);
    });

    it("listInvoiceSections maps API rows", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                id: "/.../invoiceSections/is-1",
                name: "is-1",
                properties: { displayName: "Invoices One", state: "Active" },
              },
            ],
          },
        }),
      ]);

      const sections = await armService.listInvoiceSections(
        "ea-acct",
        "bp-1",
        "tok",
      );
      expect(sections).toHaveLength(1);
      expect(sections[0]?.name).toBe("is-1");
    });

    it("listEnrollmentAccounts maps API rows including optional fields", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                id: "/.../enrollmentAccounts/ea-1",
                name: "ea-1",
                properties: {
                  displayName: "Enroll One",
                  principalName: "owner@x.com",
                  costCenter: "CC-1",
                  status: "Active",
                  startDate: "2024-01-01",
                  endDate: "2025-01-01",
                },
              },
            ],
          },
        }),
      ]);

      const accts = await armService.listEnrollmentAccounts("ea-acct", "tok");
      expect(accts).toHaveLength(1);
      expect(accts[0]?.accountOwner).toBe("owner@x.com");
      expect(accts[0]?.costCenter).toBe("CC-1");
    });
  });

  // -------------------------------------------------------------------------
  // probeEaCapability
  // -------------------------------------------------------------------------
  describe("probeEaCapability", () => {
    it("returns hasEa=true when accounts exist", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [
              {
                id: "/.../billingAccounts/ea-1",
                name: "ea-1",
                properties: { agreementType: "EnterpriseAgreement" },
              },
            ],
          },
        }),
      ]);

      const cap = await armService.probeEaCapability("tok");
      expect(cap.hasEa).toBe(true);
      expect(cap.billingAccountCount).toBe(1);
      expect(cap.primaryBillingAccountName).toBe("ea-1");
    });

    it("soft-downgrades to hasEa=false on error", async () => {
      queueResponses([
        makeResponse({
          status: 401,
          body: { error: { code: "InvalidAuth", message: "denied" } },
        }),
      ]);

      const cap = await armService.probeEaCapability("tok");
      expect(cap.hasEa).toBe(false);
      expect(cap.billingAccountCount).toBe(0);
      expect(cap.primaryBillingAccountName).toBeUndefined();
    });

    it("returns hasEa=false when there are no EA accounts", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: { value: [] },
        }),
      ]);

      const cap = await armService.probeEaCapability("tok");
      expect(cap.hasEa).toBe(false);
      expect(cap.billingAccountCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // createEaSubscription
  // -------------------------------------------------------------------------
  describe("createEaSubscription", () => {
    const validBillingScope =
      "/providers/Microsoft.Billing/billingAccounts/ea-1/enrollmentAccounts/ea-acct-1";

    it("validates aliasName format", async () => {
      await expect(
        armService.createEaSubscription(
          {
            aliasName: "AB",
            displayName: "My Sub",
            billingScope: validBillingScope,
          },
          "tok",
        ),
      ).rejects.toThrow(/Invalid aliasName/);
      expect(guardedFetchMock).not.toHaveBeenCalled();
    });

    it("validates billingScope shape", async () => {
      await expect(
        armService.createEaSubscription(
          {
            aliasName: "valid-alias",
            displayName: "My Sub",
            billingScope: "/not/a/valid/scope",
          },
          "tok",
        ),
      ).rejects.toThrow(/Invalid billingScope/);
    });

    it("validates displayName length", async () => {
      await expect(
        armService.createEaSubscription(
          {
            aliasName: "valid-alias",
            displayName: "ab",
            billingScope: validBillingScope,
          },
          "tok",
        ),
      ).rejects.toThrow(/Invalid displayName/);
    });

    it("requires subscriptionOwnerId when subscriptionTenantId is set", async () => {
      await expect(
        armService.createEaSubscription(
          {
            aliasName: "valid-alias",
            displayName: "My Sub",
            billingScope: validBillingScope,
            subscriptionTenantId: VALID_SUB_ID,
          },
          "tok",
        ),
      ).rejects.toThrow(/subscriptionOwnerId/);
    });

    it("validates subscriptionTenantId UUID", async () => {
      await expect(
        armService.createEaSubscription(
          {
            aliasName: "valid-alias",
            displayName: "My Sub",
            billingScope: validBillingScope,
            subscriptionTenantId: "not-a-uuid",
            subscriptionOwnerId: VALID_SUB_ID,
          },
          "tok",
        ),
      ).rejects.toThrow(/subscriptionTenantId/);
    });

    it("validates subscriptionOwnerId UUID", async () => {
      await expect(
        armService.createEaSubscription(
          {
            aliasName: "valid-alias",
            displayName: "My Sub",
            billingScope: validBillingScope,
            subscriptionTenantId: VALID_SUB_ID,
            subscriptionOwnerId: "not-a-uuid",
          },
          "tok",
        ),
      ).rejects.toThrow(/subscriptionOwnerId/);
    });

    it("returns alias info on synchronous 200 success", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            id: "/.../aliases/valid-alias",
            name: "valid-alias",
            type: "Microsoft.Subscription/aliases",
            properties: {
              subscriptionId: "newly-created-sub-id",
              provisioningState: "Succeeded",
              displayName: "My Sub",
              billingScope: validBillingScope,
              workload: "Production",
            },
          },
        }),
      ]);

      const result = await armService.createEaSubscription(
        {
          aliasName: "valid-alias",
          displayName: "My Sub",
          billingScope: validBillingScope,
          tags: { env: "test" },
        },
        "tok",
      );

      expect(result.aliasName).toBe("valid-alias");
      expect(result.subscriptionId).toBe("newly-created-sub-id");
      expect(result.provisioningState).toBe("Succeeded");
      expect(result.displayName).toBe("My Sub");
    });

    it("surfaces ARM 400 error", async () => {
      queueResponses([
        makeResponse({
          status: 400,
          statusText: "Bad Request",
          body: {
            error: {
              code: "AliasAlreadyInUse",
              message: "alias name taken",
            },
          },
        }),
      ]);

      await expect(
        armService.createEaSubscription(
          {
            aliasName: "valid-alias",
            displayName: "My Sub",
            billingScope: validBillingScope,
          },
          "tok",
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  // -------------------------------------------------------------------------
  // Typed-error contract — keeps the imports used and verifies the taxonomy.
  // -------------------------------------------------------------------------
  describe("typed-error contract", () => {
    it("typed errors are instances of AzureRequestError", () => {
      const auth = new AuthError("a", 401, "x", {});
      const rate = new RateLimitError("a", "x", {}, 5);
      const nf = new NotFoundError("a", "x", {});
      const tr = new TransientError("a", 502, "x", {});
      const val = new ValidationError("a", "x", {});

      expect(auth).toBeInstanceOf(AzureRequestError);
      expect(rate).toBeInstanceOf(AzureRequestError);
      expect(nf).toBeInstanceOf(AzureRequestError);
      expect(tr).toBeInstanceOf(AzureRequestError);
      expect(val).toBeInstanceOf(AzureRequestError);
      expect(rate.retryAfterSeconds).toBe(5);
    });
  });
});
