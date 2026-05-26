import { __awaiter } from "tslib";
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
    fetchAllPages: jest.fn(() => __awaiter(void 0, void 0, void 0, function* () { return []; })),
}));
import { guardedFetch } from "../../scheduling/request-governance";
import { getBatchAccountQuota } from "../quota-service";
const mockGuardedFetch = guardedFetch;
const VALID_SUB = "11111111-1111-1111-1111-111111111111";
function mockOk(accountQuota) {
    const body = JSON.stringify({ accountQuota });
    const headers = new Headers({ "Content-Type": "application/json" });
    const self = {
        status: 200,
        ok: true,
        statusText: "OK",
        headers,
        url: "https://management.azure.com/test",
        text: () => __awaiter(this, void 0, void 0, function* () { return body; }),
        json: () => __awaiter(this, void 0, void 0, function* () { return JSON.parse(body); }),
        clone: () => mockOk(accountQuota),
    };
    return self;
}
describe("quota-service in-memory LRU cap", () => {
    beforeEach(() => {
        invalidateQuotaCache(); // clear the module-scope cache
        mockGuardedFetch.mockReset();
    });
    it("evicts oldest entry when the cap is exceeded", () => __awaiter(void 0, void 0, void 0, function* () {
        mockGuardedFetch.mockImplementation(() => Promise.resolve(mockOk(1)));
        // 501 distinct regions on one subscription — the cap is 500.
        const regions = Array.from({ length: 501 }, (_, i) => `region-${i}`);
        for (const r of regions) {
            yield getBatchAccountQuota(VALID_SUB, r, "tok");
        }
        // 501 fresh fetches (each was a miss).
        expect(mockGuardedFetch).toHaveBeenCalledTimes(501);
        // Query the first inserted key — should have been evicted and
        // therefore re-fetched.
        mockGuardedFetch.mockClear();
        yield getBatchAccountQuota(VALID_SUB, regions[0], "tok");
        expect(mockGuardedFetch).toHaveBeenCalledTimes(1);
        // Query the newest key — should still be cached.
        mockGuardedFetch.mockClear();
        yield getBatchAccountQuota(VALID_SUB, regions[500], "tok");
        expect(mockGuardedFetch).toHaveBeenCalledTimes(0);
    }));
    it("notifies subscribers when a fresh entry lands", () => __awaiter(void 0, void 0, void 0, function* () {
        mockGuardedFetch.mockImplementation(() => Promise.resolve(mockOk(2)));
        const events = [];
        const unsub = subscribeQuotaCache((key) => events.push(key));
        try {
            yield getBatchAccountQuota(VALID_SUB, "eastus", "tok");
            expect(events.length).toBeGreaterThan(0);
        }
        finally {
            unsub();
        }
    }));
});
//# sourceMappingURL=lru-quota-cache.spec.js.map