/**
 * Tests for the effective-permission probe used by the account-provisioning
 * "Pick existing" resource-group flow:
 *   - isActionAllowed: Azure RBAC wildcard + notActions semantics (pure fn).
 *   - listResourceGroupPermissions: maps the Microsoft.Authorization/permissions
 *     response.
 *   - canCreateBatchAccountInResourceGroup: end-to-end allow/deny verdict.
 *
 * Runner matches `*.spec.ts` only (util/common-config/jest-common.js), hence
 * this `.spec.ts` file.
 */

jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(),
}));

import * as armService from "../arm-service";
import type { EffectivePermission } from "../arm-service";
import { guardedFetch } from "../../scheduling/request-governance";

const guardedFetchMock = guardedFetch as jest.MockedFunction<
  typeof guardedFetch
>;

const VALID_SUB_ID = "11111111-2222-3333-4444-555555555555";
const BATCH_WRITE = "Microsoft.Batch/batchAccounts/write";

function perm(p: Partial<EffectivePermission>): EffectivePermission {
  return {
    actions: p.actions ?? [],
    notActions: p.notActions ?? [],
    dataActions: p.dataActions ?? [],
    notDataActions: p.notDataActions ?? [],
  };
}

function makeResponse(body: unknown, status = 200): Response {
  return {
    status,
    statusText: "",
    ok: status >= 200 && status < 300,
    url: "https://management.azure.com/",
    headers: { get: () => null } as unknown as Headers,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    clone: () => makeResponse(body, status),
  } as unknown as Response;
}

describe("isActionAllowed (Azure RBAC matcher)", () => {
  it("allows everything under the root wildcard", () => {
    expect(armService.isActionAllowed([perm({ actions: ["*"] })], BATCH_WRITE)).toBe(
      true,
    );
  });

  it("allows via a namespace wildcard spanning slashes", () => {
    expect(
      armService.isActionAllowed(
        [perm({ actions: ["Microsoft.Batch/*"] })],
        BATCH_WRITE,
      ),
    ).toBe(true);
  });

  it("allows an exact action match", () => {
    expect(
      armService.isActionAllowed([perm({ actions: [BATCH_WRITE] })], BATCH_WRITE),
    ).toBe(true);
  });

  it("denies when only a read action is granted", () => {
    expect(
      armService.isActionAllowed(
        [perm({ actions: ["Microsoft.Batch/batchAccounts/read"] })],
        BATCH_WRITE,
      ),
    ).toBe(false);
  });

  it("denies when notActions excludes the action within the granting entry", () => {
    expect(
      armService.isActionAllowed(
        [perm({ actions: ["*"], notActions: ["Microsoft.Batch/batchAccounts/write"] })],
        BATCH_WRITE,
      ),
    ).toBe(false);
  });

  it("allows when a second entry grants it despite a first entry's notActions", () => {
    expect(
      armService.isActionAllowed(
        [
          perm({ actions: ["*"], notActions: ["Microsoft.Batch/*"] }),
          perm({ actions: ["Microsoft.Batch/batchAccounts/*"] }),
        ],
        BATCH_WRITE,
      ),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      armService.isActionAllowed(
        [perm({ actions: ["microsoft.batch/*"] })],
        BATCH_WRITE,
      ),
    ).toBe(true);
  });

  it("treats a notActions wildcard as a star-dot-star (does not over-match unrelated actions)", () => {
    // notActions `Microsoft.Batch/batchAccounts/*` must not block a Storage write.
    expect(
      armService.isActionAllowed(
        [
          perm({
            actions: ["*"],
            notActions: ["Microsoft.Batch/batchAccounts/*"],
          }),
        ],
        "Microsoft.Storage/storageAccounts/write",
      ),
    ).toBe(true);
  });

  it("denies against an empty permission set", () => {
    expect(armService.isActionAllowed([], BATCH_WRITE)).toBe(false);
  });
});

describe("listResourceGroupPermissions", () => {
  beforeEach(() => {
    guardedFetchMock.mockReset();
  });

  it("maps API rows and defaults missing arrays to empty", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      makeResponse({
        value: [
          {
            actions: ["*"],
            notActions: ["Microsoft.Authorization/*/Delete"],
          },
          { actions: ["Microsoft.Batch/batchAccounts/read"] },
        ],
      }),
    );

    const perms = await armService.listResourceGroupPermissions(
      VALID_SUB_ID,
      "rg-prod",
      "tok",
    );

    expect(perms).toHaveLength(2);
    expect(perms[0]?.actions).toEqual(["*"]);
    expect(perms[0]?.notActions).toEqual(["Microsoft.Authorization/*/Delete"]);
    // Missing arrays normalized to [].
    expect(perms[1]?.notActions).toEqual([]);
    expect(perms[1]?.dataActions).toEqual([]);

    // URL targets the RG-scoped permissions endpoint.
    const url = String(guardedFetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(
      "/resourceGroups/rg-prod/providers/Microsoft.Authorization/permissions",
    );
  });

  it("rejects an invalid subscription id before fetching", async () => {
    await expect(
      armService.listResourceGroupPermissions("nope", "rg", "tok"),
    ).rejects.toThrow(/Invalid subscriptionId/);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty resource-group name", async () => {
    await expect(
      armService.listResourceGroupPermissions(VALID_SUB_ID, "", "tok"),
    ).rejects.toThrow(/resourceGroupName is required/);
  });
});

describe("canCreateBatchAccountInResourceGroup", () => {
  beforeEach(() => {
    guardedFetchMock.mockReset();
  });

  it("returns true when the caller holds Batch write at the RG scope", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      makeResponse({ value: [{ actions: ["Microsoft.Batch/*"] }] }),
    );
    await expect(
      armService.canCreateBatchAccountInResourceGroup(VALID_SUB_ID, "rg", "tok"),
    ).resolves.toBe(true);
  });

  it("returns false when the caller only has read", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      makeResponse({ value: [{ actions: ["*/read"] }] }),
    );
    await expect(
      armService.canCreateBatchAccountInResourceGroup(VALID_SUB_ID, "rg", "tok"),
    ).resolves.toBe(false);
  });
});
