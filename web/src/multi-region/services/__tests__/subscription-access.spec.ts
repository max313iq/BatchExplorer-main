/**
 * Tests for listSubscriptionAccessByPrincipal — the tenant-wide
 * "which principals have access to which subscriptions" enumeration that
 * powers the Tenant Users "Has Sub" counts. It runs entirely off the
 * caller's own ARM token (no per-user sign-in): enumerate subscriptions →
 * read role assignments per sub → group by principalId.
 *
 * Covers:
 *   - grouping a principal's access across multiple subscriptions
 *   - de-duplication (same principal, multiple role rows in one sub)
 *   - partial failure: a 403 on one sub is collected, others still resolve
 *   - subscription-id filtering
 *   - concrete principalType winning over a previously-seen "Unknown"
 *
 * Runner matches `*.spec.ts` only (util/common-config/jest-common.js).
 */

jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(),
}));

import * as armService from "../arm-service";
import { guardedFetch } from "../../scheduling/request-governance";

const guardedFetchMock = guardedFetch as jest.MockedFunction<
  typeof guardedFetch
>;

const SUB_A = "11111111-1111-1111-1111-111111111111";
const SUB_B = "22222222-2222-2222-2222-222222222222";
const SUB_C = "33333333-3333-3333-3333-333333333333";
const USER_1 = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_2 = "aaaaaaaa-0000-0000-0000-000000000002";
const SP_1 = "bbbbbbbb-0000-0000-0000-000000000001";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    ok: status >= 200 && status < 300,
    url: "https://management.azure.com/",
    headers: { get: () => null } as unknown as Headers,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    clone: () => jsonResponse(body, status),
  } as unknown as Response;
}

function roleRow(
  sub: string,
  principalId: string,
  principalType: string,
  guid: string,
) {
  return {
    id: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleAssignments/${guid}`,
    name: guid,
    properties: {
      roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/role-${guid}`,
      principalId,
      principalType,
      scope: `/subscriptions/${sub}`,
    },
  };
}

/**
 * Route guardedFetch by URL: the `/subscriptions?...` list call returns the
 * `subs` set; each `/subscriptions/{id}/.../roleAssignments` call returns that
 * sub's rows, or a 403 when the sub id is in `deny`.
 */
function route(opts: {
  subs: Array<{ subscriptionId: string; displayName: string }>;
  rolesBySub: Record<string, unknown[]>;
  deny?: Set<string>;
}): void {
  guardedFetchMock.mockImplementation((async (url: string) => {
    const u = String(url);
    // Subscription list: /subscriptions?api-version=... (no /resourceGroups etc.)
    if (/\/subscriptions\?api-version=/.test(u)) {
      return jsonResponse({
        value: opts.subs.map((s) => ({
          subscriptionId: s.subscriptionId,
          displayName: s.displayName,
          state: "Enabled",
          tenantId: "t",
        })),
      });
    }
    // Role assignments: /subscriptions/{id}/providers/Microsoft.Authorization/roleAssignments
    const m = /\/subscriptions\/([^/]+)\/providers\/Microsoft\.Authorization\/roleAssignments/.exec(
      u,
    );
    if (m) {
      const subId = m[1];
      if (opts.deny?.has(subId)) {
        return jsonResponse(
          { error: { code: "AuthorizationFailed", message: "denied" } },
          403,
        );
      }
      return jsonResponse({ value: opts.rolesBySub[subId] ?? [] });
    }
    return jsonResponse({ value: [] });
  }) as unknown as typeof guardedFetch);
}

describe("listSubscriptionAccessByPrincipal", () => {
  beforeEach(() => {
    guardedFetchMock.mockReset();
  });

  it("groups a principal's subscriptions and de-dupes repeat role rows", async () => {
    route({
      subs: [
        { subscriptionId: SUB_A, displayName: "Sub A" },
        { subscriptionId: SUB_B, displayName: "Sub B" },
      ],
      rolesBySub: {
        [SUB_A]: [
          roleRow(SUB_A, USER_1, "User", "g1"),
          // Same principal, second role in the SAME sub → must not double-count.
          roleRow(SUB_A, USER_1, "User", "g2"),
          roleRow(SUB_A, SP_1, "ServicePrincipal", "g3"),
        ],
        [SUB_B]: [roleRow(SUB_B, USER_1, "User", "g4")],
      },
    });

    const result = await armService.listSubscriptionAccessByPrincipal("tok");

    expect(result.subscriptions).toHaveLength(2);
    expect(result.failedSubscriptions).toEqual([]);

    const u1 = result.principals.find((p) => p.principalId === USER_1);
    expect(u1).toBeDefined();
    expect(u1!.principalType).toBe("User");
    expect(u1!.subscriptionIds.sort()).toEqual([SUB_A, SUB_B].sort());

    const sp = result.principals.find((p) => p.principalId === SP_1);
    expect(sp!.principalType).toBe("ServicePrincipal");
    expect(sp!.subscriptionIds).toEqual([SUB_A]);
  });

  it("collects a 403 sub into failedSubscriptions without aborting the rest", async () => {
    route({
      subs: [
        { subscriptionId: SUB_A, displayName: "Sub A" },
        { subscriptionId: SUB_B, displayName: "Sub B" },
      ],
      rolesBySub: {
        [SUB_B]: [roleRow(SUB_B, USER_2, "User", "g9")],
      },
      deny: new Set([SUB_A]),
    });

    const result = await armService.listSubscriptionAccessByPrincipal("tok", {
      concurrency: 1,
    });

    expect(result.failedSubscriptions).toHaveLength(1);
    expect(result.failedSubscriptions[0]?.subscriptionId).toBe(SUB_A);
    // SUB_B still resolved.
    const u2 = result.principals.find((p) => p.principalId === USER_2);
    expect(u2?.subscriptionIds).toEqual([SUB_B]);
  });

  it("honors a subscriptionIds filter", async () => {
    route({
      subs: [
        { subscriptionId: SUB_A, displayName: "A" },
        { subscriptionId: SUB_B, displayName: "B" },
        { subscriptionId: SUB_C, displayName: "C" },
      ],
      rolesBySub: {
        [SUB_A]: [roleRow(SUB_A, USER_1, "User", "g1")],
        [SUB_C]: [roleRow(SUB_C, USER_1, "User", "g2")],
      },
    });

    const result = await armService.listSubscriptionAccessByPrincipal("tok", {
      subscriptionIds: [SUB_C],
    });

    expect(result.subscriptions.map((s) => s.subscriptionId)).toEqual([SUB_C]);
    const u1 = result.principals.find((p) => p.principalId === USER_1);
    expect(u1?.subscriptionIds).toEqual([SUB_C]);
  });

  it("upgrades a principal's type from Unknown to a concrete value", async () => {
    route({
      subs: [
        { subscriptionId: SUB_A, displayName: "A" },
        { subscriptionId: SUB_B, displayName: "B" },
      ],
      rolesBySub: {
        // First sub seen reports an empty principalType → mapped to "Unknown".
        [SUB_A]: [roleRow(SUB_A, USER_1, "", "g1")],
        // Second sub reports a concrete type → must win.
        [SUB_B]: [roleRow(SUB_B, USER_1, "User", "g2")],
      },
    });

    const result = await armService.listSubscriptionAccessByPrincipal("tok", {
      concurrency: 1,
    });
    const u1 = result.principals.find((p) => p.principalId === USER_1);
    expect(u1?.principalType).toBe("User");
    expect(u1?.subscriptionIds.sort()).toEqual([SUB_A, SUB_B].sort());
  });
});

describe("listOrgSubscriptions (graph-service delegation)", () => {
  // listOrgSubscriptions lives in graph-service but delegates to the ARM
  // implementation; verify the {userId, subscriptionIds} shape and the
  // degrade-to-empty contract via the same mocked transport.
  beforeEach(() => {
    guardedFetchMock.mockReset();
  });

  it("maps principals to {userId, subscriptionIds}", async () => {
    route({
      subs: [{ subscriptionId: SUB_A, displayName: "A" }],
      rolesBySub: { [SUB_A]: [roleRow(SUB_A, USER_1, "User", "g1")] },
    });
    const graph = await import("../graph-service");
    const rows = await graph.listOrgSubscriptions(
      "00000000-0000-0000-0000-000000000000",
      "arm-tok",
    );
    expect(rows).toEqual([{ userId: USER_1, subscriptionIds: [SUB_A] }]);
  });

  it("degrades to [] when subscription enumeration throws", async () => {
    guardedFetchMock.mockImplementation((async () =>
      jsonResponse(
        { error: { code: "InvalidAuthenticationToken", message: "bad" } },
        401,
      )) as unknown as typeof guardedFetch);
    const graph = await import("../graph-service");
    const rows = await graph.listOrgSubscriptions(
      "00000000-0000-0000-0000-000000000000",
      "arm-tok",
    );
    expect(rows).toEqual([]);
  });
});
