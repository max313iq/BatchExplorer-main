/**
 * Verify the quota-service in-memory cache evicts LRU-style once it
 * exceeds CACHE_MAX_ENTRIES.
 *
 * The cache is module-internal so we exercise it indirectly via the
 * public `subscribeQuotaCache` notify hook plus the
 * `invalidateQuotaCache` reset. We populate by calling
 * `getBatchAccountQuota` with a mocked `guardedFetch`.
 */
import { invalidateQuotaCache, subscribeQuotaCache } from "../quota-service";

// Mock guardedFetch so we don't hit the network.
jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(),
}));

// Mock _shared/paginate so the parallel "list accounts in region"
// call inside getBatchAccountQuota resolves to an empty array,
// keeping the test focused on the single-page quota fetch path.
jest.mock("../_shared/paginate", () => ({
  fetchAllPages: jest.fn(async () => []),
}));

import { guardedFetch } from "../../scheduling/request-governance";
import { getBatchAccountQuota } from "../quota-service";

const mockGuardedFetch = guardedFetch as jest.MockedFunction<
  typeof guardedFetch
>;

const VALID_SUB = "11111111-1111-1111-1111-111111111111";

function mockOk(accountQuota: number): Response {
  const body = JSON.stringify({ accountQuota });
  const headers = new Headers({ "Content-Type": "application/json" });
  const self: any = {
    status: 200,
    ok: true,
    statusText: "OK",
    headers,
    url: "https://management.azure.com/test",
    text: async () => body,
    json: async () => JSON.parse(body),
    clone: () => mockOk(accountQuota),
  };
  return self as Response;
}

describe("quota-service in-memory LRU cap", () => {
  beforeEach(() => {
    invalidateQuotaCache(); // clear the module-scope cache
    mockGuardedFetch.mockReset();
  });

  it("evicts oldest entry when the cap is exceeded", async () => {
    mockGuardedFetch.mockImplementation(() => Promise.resolve(mockOk(1)));

    // 501 distinct regions on one subscription — the cap is 500.
    const regions = Array.from({ length: 501 }, (_, i) => `region-${i}`);
    for (const r of regions) {
      await getBatchAccountQuota(VALID_SUB, r, "tok");
    }
    // 501 fresh fetches (each was a miss).
    expect(mockGuardedFetch).toHaveBeenCalledTimes(501);

    // Query the first inserted key — should have been evicted and
    // therefore re-fetched.
    mockGuardedFetch.mockClear();
    await getBatchAccountQuota(VALID_SUB, regions[0], "tok");
    expect(mockGuardedFetch).toHaveBeenCalledTimes(1);

    // Query the newest key — should still be cached.
    mockGuardedFetch.mockClear();
    await getBatchAccountQuota(VALID_SUB, regions[500], "tok");
    expect(mockGuardedFetch).toHaveBeenCalledTimes(0);
  });

  it("notifies subscribers when a fresh entry lands", async () => {
    mockGuardedFetch.mockImplementation(() => Promise.resolve(mockOk(2)));
    const events: string[] = [];
    const unsub = subscribeQuotaCache((key) => events.push(key));
    try {
      await getBatchAccountQuota(VALID_SUB, "eastus", "tok");
      expect(events.length).toBeGreaterThan(0);
    } finally {
      unsub();
    }
  });
});
