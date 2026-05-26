import { __awaiter } from "tslib";
/**
 * `listPoolsViaArg` should issue ONE ARM POST that returns rows for
 * every pool across the requested subscriptions.
 */
import { listPoolsViaArg } from "../arg-service";
jest.mock("../../scheduling/request-governance", () => ({
    guardedFetch: jest.fn(),
}));
import { guardedFetch } from "../../scheduling/request-governance";
const mockedFetch = guardedFetch;
function fakeResponse(body, status = 200) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const self = {
        status,
        ok: status >= 200 && status < 300,
        statusText: "OK",
        headers: new Headers(),
        url: "https://management.azure.com/providers/Microsoft.ResourceGraph/resources",
        text: () => __awaiter(this, void 0, void 0, function* () { return text; }),
        json: () => __awaiter(this, void 0, void 0, function* () { return (text ? JSON.parse(text) : {}); }),
        clone: () => fakeResponse(body, status),
    };
    return self;
}
describe("listPoolsViaArg", () => {
    beforeEach(() => {
        mockedFetch.mockReset();
    });
    it("issues one ARG POST and returns the parsed rows", () => __awaiter(void 0, void 0, void 0, function* () {
        mockedFetch.mockImplementationOnce(() => __awaiter(void 0, void 0, void 0, function* () {
            return fakeResponse({
                totalRecords: 2,
                count: 2,
                data: [
                    {
                        id: "/subscriptions/sub-1/.../pools/p1",
                        name: "p1",
                        type: "microsoft.batch/batchaccounts/pools",
                        location: "eastus",
                        resourceGroup: "rg-1",
                        subscriptionId: "sub-1",
                        accountName: "acct1",
                        vmSize: "Standard_D2_v3",
                        allocationState: "steady",
                        currentDedicatedNodes: 2,
                        currentLowPriorityNodes: 0,
                        targetDedicatedNodes: 2,
                        targetLowPriorityNodes: 0,
                        provisioningState: "Succeeded",
                        tags: {},
                    },
                    {
                        id: "/subscriptions/sub-2/.../pools/p2",
                        name: "p2",
                        type: "microsoft.batch/batchaccounts/pools",
                        location: "westus",
                        resourceGroup: "rg-2",
                        subscriptionId: "sub-2",
                        accountName: "acct2",
                        vmSize: "Standard_F4s_v2",
                        allocationState: "resizing",
                        currentDedicatedNodes: 0,
                        currentLowPriorityNodes: 4,
                        targetDedicatedNodes: 0,
                        targetLowPriorityNodes: 4,
                        provisioningState: "Succeeded",
                        tags: {},
                    },
                ],
            });
        }));
        const out = yield listPoolsViaArg("tok", ["sub-1", "sub-2"]);
        expect(out.rows).toHaveLength(2);
        expect(out.rows[0].name).toBe("p1");
        expect(out.rows[1].vmSize).toBe("Standard_F4s_v2");
        expect(out.requestCount).toBe(1);
        expect(mockedFetch).toHaveBeenCalledTimes(1);
    }));
    it("forwards signal to guardedFetch", () => __awaiter(void 0, void 0, void 0, function* () {
        mockedFetch.mockImplementationOnce(() => __awaiter(void 0, void 0, void 0, function* () { return fakeResponse({ data: [] }); }));
        const ctrl = new AbortController();
        yield listPoolsViaArg("tok", ["sub-1"], { signal: ctrl.signal });
        const [, init] = mockedFetch.mock.calls[0];
        expect(init === null || init === void 0 ? void 0 : init.signal).toBe(ctrl.signal);
    }));
});
//# sourceMappingURL=arg-bulk-pools.spec.js.map