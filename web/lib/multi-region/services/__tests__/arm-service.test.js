import { __awaiter } from "tslib";
import * as armService from "../arm-service";
import { AuthError, RateLimitError, NotFoundError, TransientError, ValidationError, AzureRequestError, } from "../types";
// Mock guardedFetch so the service hits our fake instead of network.
// (Matches the convention used by graph-service.test.ts.)
jest.mock("../../scheduling/request-governance", () => ({
    guardedFetch: jest.fn(),
}));
import { guardedFetch } from "../../scheduling/request-governance";
const guardedFetchMock = guardedFetch;
/**
 * Build a Response-like object compatible with everything `arm-service`
 * touches: `.ok`, `.status`, `.statusText`, `.url`, `.headers.get(...)`,
 * `.text()`, `.json()`, and `.clone()` for retry-after sniffing.
 */
function makeResponse(init = {}) {
    var _a, _b, _c, _d;
    const status = (_a = init.status) !== null && _a !== void 0 ? _a : 200;
    const statusText = (_b = init.statusText) !== null && _b !== void 0 ? _b : "";
    const url = (_c = init.url) !== null && _c !== void 0 ? _c : "https://management.azure.com/";
    const headersMap = new Map(Object.entries((_d = init.headers) !== null && _d !== void 0 ? _d : {}).map(([k, v]) => [k.toLowerCase(), v]));
    const headers = {
        get: (name) => { var _a; return (_a = headersMap.get(name.toLowerCase())) !== null && _a !== void 0 ? _a : null; },
    };
    const text = init.rawText !== undefined
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
        json: () => Promise.resolve(init.body),
        clone: () => makeResponse(init),
    };
    return response;
}
function queueResponses(responses) {
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
            .mockImplementation(((fn) => {
            fn();
            return 0;
        }));
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    // -------------------------------------------------------------------------
    // listSubscriptions
    // -------------------------------------------------------------------------
    describe("listSubscriptions", () => {
        it("returns subscriptions on 200, following nextLink pagination", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
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
            const subs = yield armService.listSubscriptions("token");
            expect(subs).toHaveLength(2);
            expect((_a = subs[0]) === null || _a === void 0 ? void 0 : _a.subscriptionId).toBe("sub-1");
            expect((_b = subs[1]) === null || _b === void 0 ? void 0 : _b.subscriptionId).toBe("sub-2");
            expect(guardedFetchMock).toHaveBeenCalledTimes(2);
            // Verify Authorization header on first call.
            const firstCall = guardedFetchMock.mock.calls[0];
            const init = firstCall === null || firstCall === void 0 ? void 0 : firstCall[1];
            const headers = init === null || init === void 0 ? void 0 : init.headers;
            expect(headers === null || headers === void 0 ? void 0 : headers.Authorization).toBe("Bearer token");
        }));
        it("throws AzureRequestError on 401 (Auth failure)", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 401,
                    statusText: "Unauthorized",
                    body: { error: { code: "InvalidAuthentication", message: "bad token" } },
                }),
            ]);
            try {
                yield armService.listSubscriptions("bad");
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err).toBeInstanceOf(AzureRequestError);
                expect(err.status).toBe(401);
                expect(err.message).toContain("bad token");
            }
        }));
        it("surfaces 5xx errors with parsed message", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 503,
                    statusText: "Service Unavailable",
                    body: { error: { code: "ServiceUnavailable", message: "Try later" } },
                }),
            ]);
            yield expect(armService.listSubscriptions("t")).rejects.toMatchObject({
                status: 503,
            });
        }));
    });
    // -------------------------------------------------------------------------
    // listBatchAccounts
    // -------------------------------------------------------------------------
    describe("listBatchAccounts", () => {
        it("returns accounts when subscription is valid", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
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
            const accounts = yield armService.listBatchAccounts(VALID_SUB_ID, "tok");
            expect(accounts).toHaveLength(1);
            expect((_a = accounts[0]) === null || _a === void 0 ? void 0 : _a.name).toBe("accountA");
        }));
        it("throws on invalid subscription ID format before any fetch", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.listBatchAccounts("not-a-uuid", "tok")).rejects.toThrow(/Invalid subscriptionId/);
            expect(guardedFetchMock).not.toHaveBeenCalled();
        }));
    });
    // -------------------------------------------------------------------------
    // getBatchAccount
    // -------------------------------------------------------------------------
    describe("getBatchAccount", () => {
        it("returns an account on 200", () => __awaiter(void 0, void 0, void 0, function* () {
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
            const acct = yield armService.getBatchAccount(VALID_SUB_ID, "rg", "foobar", "tok");
            expect(acct.name).toBe("foo");
        }));
        it("throws on invalid account name", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.getBatchAccount(VALID_SUB_ID, "rg", "BAD_NAME!", "tok")).rejects.toThrow(/Invalid accountName/);
        }));
        it("translates 404 to AzureRequestError with status 404", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 404,
                    statusText: "Not Found",
                    body: { error: { code: "ResourceNotFound", message: "no such" } },
                }),
            ]);
            yield expect(armService.getBatchAccount(VALID_SUB_ID, "rg", "missing", "tok")).rejects.toMatchObject({ status: 404 });
        }));
        it("translates 429 with retry-after into a rate-limit response", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 429,
                    statusText: "Too Many Requests",
                    body: { error: { code: "TooManyRequests", message: "slow down" } },
                    headers: { "retry-after": "30" },
                }),
            ]);
            yield expect(armService.getBatchAccount(VALID_SUB_ID, "rg", "okay", "tok")).rejects.toMatchObject({ status: 429 });
        }));
        it("falls back to raw text when error body is non-JSON", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 400,
                    statusText: "Bad Request",
                    rawText: "<html>Bad request</html>",
                }),
            ]);
            try {
                yield armService.getBatchAccount(VALID_SUB_ID, "rg", "okay", "tok");
                fail("expected throw");
            }
            catch (e) {
                const err = e;
                expect(err.status).toBe(400);
                expect(err.message).toContain("400");
            }
        }));
    });
    // -------------------------------------------------------------------------
    // createResourceGroup
    // -------------------------------------------------------------------------
    describe("createResourceGroup", () => {
        it("PUTs and returns the resource group", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
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
            const rg = yield armService.createResourceGroup(VALID_SUB_ID, "rg", "eastus", "tok");
            expect(rg.name).toBe("rg");
            const call = guardedFetchMock.mock.calls[0];
            const init = call === null || call === void 0 ? void 0 : call[1];
            expect(init === null || init === void 0 ? void 0 : init.method).toBe("PUT");
            // Body must include the location.
            const bodyStr = ((_a = init === null || init === void 0 ? void 0 : init.body) !== null && _a !== void 0 ? _a : "");
            expect(bodyStr).toContain("eastus");
        }));
        it("throws on 400 from ARM", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 400,
                    statusText: "Bad Request",
                    body: {
                        error: { code: "InvalidLocation", message: "bad region" },
                    },
                }),
            ]);
            yield expect(armService.createResourceGroup(VALID_SUB_ID, "rg", "bogus", "tok")).rejects.toMatchObject({ status: 400 });
        }));
        it("validates subscription ID before calling fetch", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.createResourceGroup("not-uuid", "rg", "eastus", "tok")).rejects.toThrow(/Invalid subscriptionId/);
            expect(guardedFetchMock).not.toHaveBeenCalled();
        }));
    });
    // -------------------------------------------------------------------------
    // createBatchAccount
    // -------------------------------------------------------------------------
    describe("createBatchAccount", () => {
        it("returns immediately on 200 with provisioningState=Succeeded", () => __awaiter(void 0, void 0, void 0, function* () {
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
            const acct = yield armService.createBatchAccount(VALID_SUB_ID, "rg", "foobar", "eastus", "tok");
            expect(acct.name).toBe("foobar");
        }));
        it("rejects with status 400 when ARM returns bad request", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 400,
                    statusText: "Bad Request",
                    body: {
                        error: { code: "AccountNameInUse", message: "name already taken" },
                    },
                }),
            ]);
            yield expect(armService.createBatchAccount(VALID_SUB_ID, "rg", "foobar", "eastus", "tok")).rejects.toMatchObject({ status: 400 });
        }));
        it("validates subscription and account name before calling fetch", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.createBatchAccount("bad", "rg", "foobar", "eastus", "tok")).rejects.toThrow(/Invalid subscriptionId/);
            yield expect(armService.createBatchAccount(VALID_SUB_ID, "rg", "AB", "eastus", "tok")).rejects.toThrow(/Invalid accountName/);
            expect(guardedFetchMock).not.toHaveBeenCalled();
        }));
    });
    // -------------------------------------------------------------------------
    // listEaBillingAccounts
    // -------------------------------------------------------------------------
    describe("listEaBillingAccounts", () => {
        it("returns EA billing accounts when filter call succeeds", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
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
            const list = yield armService.listEaBillingAccounts("tok");
            expect(list).toHaveLength(1);
            expect((_a = list[0]) === null || _a === void 0 ? void 0 : _a.name).toBe("ea123");
        }));
        it("falls back to unfiltered list when filtered call returns 400", () => __awaiter(void 0, void 0, void 0, function* () {
            var _b;
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
            const list = yield armService.listEaBillingAccounts("tok");
            expect(list).toHaveLength(1);
            expect((_b = list[0]) === null || _b === void 0 ? void 0 : _b.name).toBe("ea-fallback");
            expect(guardedFetchMock).toHaveBeenCalledTimes(2);
        }));
        it("re-throws non-400 errors from the filtered call", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 401,
                    statusText: "Unauthorized",
                    body: { error: { code: "Forbidden", message: "denied" } },
                }),
            ]);
            yield expect(armService.listEaBillingAccounts("tok")).rejects.toMatchObject({ status: 401 });
        }));
    });
    // -------------------------------------------------------------------------
    // EA child listings
    // -------------------------------------------------------------------------
    describe("EA child listings", () => {
        it("listBillingProfiles maps API rows", () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
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
            const profiles = yield armService.listBillingProfiles("ea-acct", "tok");
            expect(profiles).toHaveLength(1);
            expect((_a = profiles[0]) === null || _a === void 0 ? void 0 : _a.displayName).toBe("BP One");
        }));
        it("listBillingProfiles validates billing account name", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.listBillingProfiles("bad name with spaces!", "tok")).rejects.toThrow(/Invalid billingAccountName/);
        }));
        it("listInvoiceSections maps API rows", () => __awaiter(void 0, void 0, void 0, function* () {
            var _b;
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
            const sections = yield armService.listInvoiceSections("ea-acct", "bp-1", "tok");
            expect(sections).toHaveLength(1);
            expect((_b = sections[0]) === null || _b === void 0 ? void 0 : _b.name).toBe("is-1");
        }));
        it("listEnrollmentAccounts maps API rows including optional fields", () => __awaiter(void 0, void 0, void 0, function* () {
            var _c, _d;
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
            const accts = yield armService.listEnrollmentAccounts("ea-acct", "tok");
            expect(accts).toHaveLength(1);
            expect((_c = accts[0]) === null || _c === void 0 ? void 0 : _c.accountOwner).toBe("owner@x.com");
            expect((_d = accts[0]) === null || _d === void 0 ? void 0 : _d.costCenter).toBe("CC-1");
        }));
    });
    // -------------------------------------------------------------------------
    // probeEaCapability
    // -------------------------------------------------------------------------
    describe("probeEaCapability", () => {
        it("returns hasEa=true when accounts exist", () => __awaiter(void 0, void 0, void 0, function* () {
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
            const cap = yield armService.probeEaCapability("tok");
            expect(cap.hasEa).toBe(true);
            expect(cap.billingAccountCount).toBe(1);
            expect(cap.primaryBillingAccountName).toBe("ea-1");
        }));
        it("soft-downgrades to hasEa=false on error", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 401,
                    body: { error: { code: "InvalidAuth", message: "denied" } },
                }),
            ]);
            const cap = yield armService.probeEaCapability("tok");
            expect(cap.hasEa).toBe(false);
            expect(cap.billingAccountCount).toBe(0);
            expect(cap.primaryBillingAccountName).toBeUndefined();
        }));
        it("returns hasEa=false when there are no EA accounts", () => __awaiter(void 0, void 0, void 0, function* () {
            queueResponses([
                makeResponse({
                    status: 200,
                    body: { value: [] },
                }),
            ]);
            const cap = yield armService.probeEaCapability("tok");
            expect(cap.hasEa).toBe(false);
            expect(cap.billingAccountCount).toBe(0);
        }));
    });
    // -------------------------------------------------------------------------
    // createEaSubscription
    // -------------------------------------------------------------------------
    describe("createEaSubscription", () => {
        const validBillingScope = "/providers/Microsoft.Billing/billingAccounts/ea-1/enrollmentAccounts/ea-acct-1";
        it("validates aliasName format", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.createEaSubscription({
                aliasName: "AB",
                displayName: "My Sub",
                billingScope: validBillingScope,
            }, "tok")).rejects.toThrow(/Invalid aliasName/);
            expect(guardedFetchMock).not.toHaveBeenCalled();
        }));
        it("validates billingScope shape", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.createEaSubscription({
                aliasName: "valid-alias",
                displayName: "My Sub",
                billingScope: "/not/a/valid/scope",
            }, "tok")).rejects.toThrow(/Invalid billingScope/);
        }));
        it("validates displayName length", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.createEaSubscription({
                aliasName: "valid-alias",
                displayName: "ab",
                billingScope: validBillingScope,
            }, "tok")).rejects.toThrow(/Invalid displayName/);
        }));
        it("requires subscriptionOwnerId when subscriptionTenantId is set", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.createEaSubscription({
                aliasName: "valid-alias",
                displayName: "My Sub",
                billingScope: validBillingScope,
                subscriptionTenantId: VALID_SUB_ID,
            }, "tok")).rejects.toThrow(/subscriptionOwnerId/);
        }));
        it("validates subscriptionTenantId UUID", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.createEaSubscription({
                aliasName: "valid-alias",
                displayName: "My Sub",
                billingScope: validBillingScope,
                subscriptionTenantId: "not-a-uuid",
                subscriptionOwnerId: VALID_SUB_ID,
            }, "tok")).rejects.toThrow(/subscriptionTenantId/);
        }));
        it("validates subscriptionOwnerId UUID", () => __awaiter(void 0, void 0, void 0, function* () {
            yield expect(armService.createEaSubscription({
                aliasName: "valid-alias",
                displayName: "My Sub",
                billingScope: validBillingScope,
                subscriptionTenantId: VALID_SUB_ID,
                subscriptionOwnerId: "not-a-uuid",
            }, "tok")).rejects.toThrow(/subscriptionOwnerId/);
        }));
        it("returns alias info on synchronous 200 success", () => __awaiter(void 0, void 0, void 0, function* () {
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
            const result = yield armService.createEaSubscription({
                aliasName: "valid-alias",
                displayName: "My Sub",
                billingScope: validBillingScope,
                tags: { env: "test" },
            }, "tok");
            expect(result.aliasName).toBe("valid-alias");
            expect(result.subscriptionId).toBe("newly-created-sub-id");
            expect(result.provisioningState).toBe("Succeeded");
            expect(result.displayName).toBe("My Sub");
        }));
        it("surfaces ARM 400 error", () => __awaiter(void 0, void 0, void 0, function* () {
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
            yield expect(armService.createEaSubscription({
                aliasName: "valid-alias",
                displayName: "My Sub",
                billingScope: validBillingScope,
            }, "tok")).rejects.toMatchObject({ status: 400 });
        }));
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
//# sourceMappingURL=arm-service.test.js.map