/**
 * `checkPoolCreatable` should return:
 *   - `{ ok: false }` when the VM SKU isn't on Batch's supported list.
 *   - `{ ok: false }` when the SKU is restricted at sub level.
 *   - `{ ok: true }` on the happy path.
 *   - Fail-open when the probe itself errors.
 */
import { checkPoolCreatable, invalidateQuotaCache } from "../quota-service";

jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(),
}));

// Mock the shared paginate helper. `checkPoolCreatable` is layered on
// top of `listBatchSupportedVmSkus` + `listAllVmSkus`, both of which
// reach the network exclusively through `armGetPaginated` →
// `sharedFetchAllPages`. We stub that, AND invoke the `onPage` hook
// inline so `listAllVmSkus`'s normalized accumulator gets populated
// the same way it would in production.
jest.mock("../_shared/paginate", () => ({
  fetchAllPages: jest.fn(),
}));

import { fetchAllPages } from "../_shared/paginate";

const mockedFetchAll = fetchAllPages as jest.MockedFunction<
  typeof fetchAllPages
>;

const SUB_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Helper: register a sequence of paginate responses. Each entry is the
 * full row array for a single call. The mock invokes `onPage(rows, rows,
 * false)` so `listAllVmSkus`'s normalized accumulator gets populated.
 */
function queuePages<T>(...rowsPerCall: T[][]): void {
  for (const rows of rowsPerCall) {
    mockedFetchAll.mockImplementationOnce(async (opts: any) => {
      opts?.onPage?.(rows, rows, false);
      return rows;
    });
  }
}

describe("checkPoolCreatable", () => {
  beforeEach(() => {
    // Cache is module-scoped — flush so prior runs don't leak.
    invalidateQuotaCache();
    mockedFetchAll.mockReset();
  });

  it("rejects when VM is not on Batch's supported list", async () => {
    queuePages([], []);
    const result = await checkPoolCreatable(
      { subscriptionId: SUB_ID },
      "eastus",
      "Standard_NC24s_v3",
      8,
      "tok",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Batch does not support/i);
  });

  it("rejects when the VM is restricted at subscription scope", async () => {
    queuePages(
      // Batch supported list — includes our SKU.
      [{ name: "Standard_NC24s_v3", familyName: "ncv3" }],
      // Compute SKUs — blocked by Location restriction.
      [
        {
          name: "Standard_NC24s_v3",
          resourceType: "virtualMachines",
          locations: ["eastus"],
          restrictions: [{ type: "Location", values: ["eastus"] }],
        },
      ],
    );

    const result = await checkPoolCreatable(
      { subscriptionId: SUB_ID },
      "eastus",
      "Standard_NC24s_v3",
      8,
      "tok",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/blocked by a subscription restriction/i);
  });

  it("accepts on happy path", async () => {
    queuePages(
      [{ name: "Standard_D2_v3", familyName: "dv3" }],
      [
        {
          name: "Standard_D2_v3",
          resourceType: "virtualMachines",
          locations: ["eastus", "westus"],
          restrictions: [],
        },
      ],
    );

    const result = await checkPoolCreatable(
      { subscriptionId: SUB_ID },
      "eastus",
      "Standard_D2_v3",
      4,
      "tok",
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails open when both probes throw", async () => {
    mockedFetchAll.mockRejectedValueOnce(new Error("403 forbidden"));
    mockedFetchAll.mockRejectedValueOnce(new Error("403 forbidden"));
    const result = await checkPoolCreatable(
      { subscriptionId: SUB_ID },
      "eastus",
      "Standard_D2_v3",
      4,
      "tok",
    );
    // Fail-open semantics: probe failure should not block.
    expect(result.ok).toBe(true);
  });
});
