import { __awaiter } from "tslib";
import { ROLE_AUTHENTICATION_ADMIN, ROLE_GLOBAL_ADMIN, ROLE_HELPDESK_ADMIN, ROLE_PRIVILEGED_AUTH_ADMIN, ROLE_USER_ADMIN, canCreateUsers, canResetPasswords, createUser, getMyDirectoryRoles, getUserDirectoryRoles, listOrgSubscriptions, listOrgUsers, listVerifiedDomains, resetUserPassword, } from "../graph-service";
import { AzureRequestError } from "../types";
// Mock guardedFetch so the service hits our fake instead of network.
jest.mock("../../scheduling/request-governance", () => ({
    guardedFetch: jest.fn(),
}));
// Re-import after the mock is in place so we can drive the mock per-test.
import { guardedFetch } from "../../scheduling/request-governance";
const guardedFetchMock = guardedFetch;
const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TOKEN = "fake-access-token";
function jsonResponse(init = {}) {
    var _a, _b, _c;
    const status = (_a = init.status) !== null && _a !== void 0 ? _a : 200;
    const ok = (_b = init.ok) !== null && _b !== void 0 ? _b : (status >= 200 && status < 300);
    const body = (_c = init.body) !== null && _c !== void 0 ? _c : {};
    return {
        ok,
        status,
        json: () => __awaiter(this, void 0, void 0, function* () { return body; }),
        text: () => __awaiter(this, void 0, void 0, function* () { return JSON.stringify(body); }),
        headers: new Headers(),
    };
}
function makeRole(roleTemplateId, displayName = "Some Role") {
    return {
        id: `role-${roleTemplateId}`,
        displayName,
        description: "test role",
        roleTemplateId,
    };
}
beforeEach(() => {
    guardedFetchMock.mockReset();
});
// ---------------------------------------------------------------------------
// Pure helpers — canResetPasswords / canCreateUsers
// ---------------------------------------------------------------------------
describe("canResetPasswords", () => {
    it("returns false for empty / non-array inputs", () => {
        expect(canResetPasswords([])).toBe(false);
        // @ts-expect-error — exercising defensive guard
        expect(canResetPasswords(null)).toBe(false);
        // @ts-expect-error — exercising defensive guard
        expect(canResetPasswords(undefined)).toBe(false);
    });
    it("returns true when any password-reset role template id is present", () => {
        const roleIds = [
            ROLE_GLOBAL_ADMIN,
            ROLE_USER_ADMIN,
            ROLE_HELPDESK_ADMIN,
            ROLE_AUTHENTICATION_ADMIN,
            ROLE_PRIVILEGED_AUTH_ADMIN,
        ];
        for (const id of roleIds) {
            expect(canResetPasswords([makeRole(id)])).toBe(true);
        }
    });
    it("returns false when only non-password-reset roles are present", () => {
        expect(canResetPasswords([makeRole("00000000-0000-0000-0000-000000000000")])).toBe(false);
    });
    it("returns true when one of several roles matches", () => {
        expect(canResetPasswords([
            makeRole("00000000-0000-0000-0000-000000000000"),
            makeRole(ROLE_HELPDESK_ADMIN),
        ])).toBe(true);
    });
});
describe("canCreateUsers", () => {
    it("returns false for empty arrays", () => {
        expect(canCreateUsers([])).toBe(false);
    });
    it("accepts Global Admin and User Admin", () => {
        expect(canCreateUsers([makeRole(ROLE_GLOBAL_ADMIN)])).toBe(true);
        expect(canCreateUsers([makeRole(ROLE_USER_ADMIN)])).toBe(true);
    });
    it("rejects helpdesk / authentication admins (reset-only)", () => {
        expect(canCreateUsers([makeRole(ROLE_HELPDESK_ADMIN)])).toBe(false);
        expect(canCreateUsers([makeRole(ROLE_AUTHENTICATION_ADMIN)])).toBe(false);
        expect(canCreateUsers([makeRole(ROLE_PRIVILEGED_AUTH_ADMIN)])).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// listOrgUsers
// ---------------------------------------------------------------------------
describe("listOrgUsers", () => {
    it("rejects an invalid tenantId without calling fetch", () => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(listOrgUsers("not-a-guid", TOKEN)).rejects.toThrow(/Invalid tenantId/);
        expect(guardedFetchMock).not.toHaveBeenCalled();
    }));
    it("returns mapped users on a happy path single page", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            body: {
                value: [
                    {
                        id: "u1",
                        displayName: "User One",
                        userPrincipalName: "u1@example.com",
                        mail: "u1@example.com",
                        accountEnabled: true,
                        jobTitle: "Engineer",
                        department: "Eng",
                    },
                    {
                        id: "u2",
                        displayName: "User Two",
                        userPrincipalName: "u2@example.com",
                        mail: null,
                        accountEnabled: false,
                    },
                ],
            },
        }));
        const users = yield listOrgUsers(TENANT_ID, TOKEN);
        expect(users).toHaveLength(2);
        expect(users[0]).toEqual({
            id: "u1",
            displayName: "User One",
            userPrincipalName: "u1@example.com",
            mail: "u1@example.com",
            accountEnabled: true,
            jobTitle: "Engineer",
            department: "Eng",
        });
        expect(users[1].mail).toBeNull();
        expect(users[1].accountEnabled).toBe(false);
        expect(users[1].jobTitle).toBeNull();
        expect(users[1].department).toBeNull();
        const [url, init, opts] = guardedFetchMock.mock.calls[0];
        expect(typeof url).toBe("string");
        expect(url.startsWith("https://graph.microsoft.com/v1.0/users")).toBe(true);
        expect(url).toContain("%24select=");
        expect(url).toContain("%24top=");
        const headers = init === null || init === void 0 ? void 0 : init.headers;
        expect(headers === null || headers === void 0 ? void 0 : headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(opts).toEqual({ subscriptionId: TENANT_ID, family: "graph" });
    }));
    it("paginates via @odata.nextLink", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock
            .mockResolvedValueOnce(jsonResponse({
            body: {
                value: [{ id: "u1", displayName: "U1", userPrincipalName: "u1" }],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?next=2",
            },
        }))
            .mockResolvedValueOnce(jsonResponse({
            body: {
                value: [{ id: "u2", displayName: "U2", userPrincipalName: "u2" }],
            },
        }));
        const users = yield listOrgUsers(TENANT_ID, TOKEN);
        expect(users.map((u) => u.id)).toEqual(["u1", "u2"]);
        expect(guardedFetchMock).toHaveBeenCalledTimes(2);
    }));
    it("uses $search + ConsistencyLevel header when search is supplied", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({ body: { value: [] } }));
        yield listOrgUsers(TENANT_ID, TOKEN, {
            search: 'al"ice',
            top: 50,
            select: ["id", "displayName"],
        });
        const [url, init] = guardedFetchMock.mock.calls[0];
        expect(url).toContain("%24search=");
        expect(url).toContain("%24count=true");
        const headers = init === null || init === void 0 ? void 0 : init.headers;
        expect(headers === null || headers === void 0 ? void 0 : headers["ConsistencyLevel"]).toBe("eventual");
    }));
    it("does not set $search when the search string is empty/whitespace", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({ body: { value: [] } }));
        yield listOrgUsers(TENANT_ID, TOKEN, { search: "   " });
        const [url, init] = guardedFetchMock.mock.calls[0];
        expect(url).not.toContain("%24search=");
        const headers = init === null || init === void 0 ? void 0 : init.headers;
        expect(headers === null || headers === void 0 ? void 0 : headers["ConsistencyLevel"]).toBeUndefined();
    }));
    it("throws AzureRequestError on 401", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            ok: false,
            status: 401,
            body: { error: { code: "InvalidAuthenticationToken", message: "bad" } },
        }));
        yield expect(listOrgUsers(TENANT_ID, TOKEN)).rejects.toBeInstanceOf(AzureRequestError);
    }));
    it("throws AzureRequestError on 429 with rate-limit info", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            ok: false,
            status: 429,
            body: { error: { code: "TooManyRequests", message: "slow down" } },
        }));
        yield expect(listOrgUsers(TENANT_ID, TOKEN)).rejects.toMatchObject({
            status: 429,
        });
    }));
    it("falls back to a generic error message when body parse fails", () => __awaiter(void 0, void 0, void 0, function* () {
        const badResponse = {
            ok: false,
            status: 500,
            json: () => __awaiter(void 0, void 0, void 0, function* () {
                throw new Error("not json");
            }),
        };
        guardedFetchMock.mockResolvedValueOnce(badResponse);
        yield expect(listOrgUsers(TENANT_ID, TOKEN)).rejects.toMatchObject({
            status: 500,
        });
    }));
});
// ---------------------------------------------------------------------------
// getMyDirectoryRoles / getUserDirectoryRoles
// ---------------------------------------------------------------------------
describe("getMyDirectoryRoles", () => {
    it("filters out non-directoryRole entries", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            body: {
                value: [
                    {
                        "@odata.type": "#microsoft.graph.directoryRole",
                        id: "1",
                        displayName: "Global Admin",
                        roleTemplateId: ROLE_GLOBAL_ADMIN,
                    },
                    {
                        "@odata.type": "#microsoft.graph.group",
                        id: "2",
                        displayName: "Some Group",
                        roleTemplateId: "",
                    },
                ],
            },
        }));
        const roles = yield getMyDirectoryRoles(TENANT_ID, TOKEN);
        expect(roles).toHaveLength(1);
        expect(roles[0].roleTemplateId).toBe(ROLE_GLOBAL_ADMIN);
    }));
    it("rejects invalid tenantId", () => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(getMyDirectoryRoles("not-a-guid", TOKEN)).rejects.toThrow(/Invalid tenantId/);
    }));
    it("propagates 403 errors", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            ok: false,
            status: 403,
            body: { error: { code: "Authorization_RequestDenied", message: "no" } },
        }));
        yield expect(getMyDirectoryRoles(TENANT_ID, TOKEN)).rejects.toMatchObject({
            status: 403,
        });
    }));
});
describe("getUserDirectoryRoles", () => {
    it("rejects invalid userId", () => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(getUserDirectoryRoles(TENANT_ID, "not-a-guid", TOKEN)).rejects.toThrow(/Invalid userId/);
    }));
    it("rejects invalid tenantId", () => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(getUserDirectoryRoles("not-a-guid", USER_ID, TOKEN)).rejects.toThrow(/Invalid tenantId/);
    }));
    it("hits /users/{id}/memberOf and maps roles", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            body: {
                value: [
                    {
                        "@odata.type": "#microsoft.graph.directoryRole",
                        id: "1",
                        displayName: "User Admin",
                        roleTemplateId: ROLE_USER_ADMIN,
                        description: "can manage users",
                    },
                ],
            },
        }));
        const roles = yield getUserDirectoryRoles(TENANT_ID, USER_ID, TOKEN);
        expect(roles).toHaveLength(1);
        expect(roles[0].displayName).toBe("User Admin");
        const [url] = guardedFetchMock.mock.calls[0];
        expect(url).toContain(`/users/${encodeURIComponent(USER_ID)}/memberOf`);
    }));
});
// ---------------------------------------------------------------------------
// resetUserPassword
// ---------------------------------------------------------------------------
describe("resetUserPassword", () => {
    it("sends PATCH /users/{id} with passwordProfile", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({ status: 204, ok: true, body: {} }));
        yield resetUserPassword(TENANT_ID, USER_ID, "P@ssw0rd!", true, TOKEN);
        const [url, init] = guardedFetchMock.mock.calls[0];
        expect(url).toContain(`/users/${encodeURIComponent(USER_ID)}`);
        expect(init.method).toBe("PATCH");
        const body = JSON.parse(init.body);
        expect(body.passwordProfile.password).toBe("P@ssw0rd!");
        expect(body.passwordProfile.forceChangePasswordNextSignIn).toBe(true);
        const headers = init.headers;
        expect(headers["Content-Type"]).toBe("application/json");
    }));
    it("rejects an empty password without calling fetch", () => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(resetUserPassword(TENANT_ID, USER_ID, "", false, TOKEN)).rejects.toThrow(/Invalid newPassword/);
        expect(guardedFetchMock).not.toHaveBeenCalled();
    }));
    it("rejects invalid userId", () => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(resetUserPassword(TENANT_ID, "bad", "x", false, TOKEN)).rejects.toThrow(/Invalid userId/);
    }));
    it("scrubs password from echo-back error messages", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            ok: false,
            status: 400,
            body: {
                error: {
                    code: "BadRequest",
                    message: 'Invalid body: {"passwordProfile":{"password":"super-secret"}}',
                },
            },
        }));
        let caught;
        try {
            yield resetUserPassword(TENANT_ID, USER_ID, "x", false, TOKEN);
        }
        catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(AzureRequestError);
        expect(caught === null || caught === void 0 ? void 0 : caught.message).not.toContain("super-secret");
        expect(caught === null || caught === void 0 ? void 0 : caught.message).toContain('"password":"***"');
    }));
    it("propagates 404 when user does not exist", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            ok: false,
            status: 404,
            body: { error: { code: "Request_ResourceNotFound", message: "no" } },
        }));
        yield expect(resetUserPassword(TENANT_ID, USER_ID, "x", false, TOKEN)).rejects.toMatchObject({ status: 404 });
    }));
});
// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------
describe("createUser", () => {
    const validReq = {
        userPrincipalName: "alice@example.com",
        displayName: "Alice",
        mailNickname: "alice",
        password: "P@ssw0rd!",
        forceChangePasswordNextSignIn: true,
        accountEnabled: true,
    };
    it("rejects invalid tenantId without calling fetch", () => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(createUser("not-a-guid", validReq, TOKEN)).rejects.toThrow(/Invalid tenantId/);
        expect(guardedFetchMock).not.toHaveBeenCalled();
    }));
    it.each([
        [
            "missing UPN",
            Object.assign(Object.assign({}, validReq), { userPrincipalName: "no-at-sign" }),
            /Invalid userPrincipalName/,
        ],
        [
            "missing displayName",
            Object.assign(Object.assign({}, validReq), { displayName: "" }),
            /Invalid displayName/,
        ],
        [
            "missing mailNickname",
            Object.assign(Object.assign({}, validReq), { mailNickname: "" }),
            /Invalid mailNickname/,
        ],
        ["empty password", Object.assign(Object.assign({}, validReq), { password: "" }), /Invalid password/],
    ])("rejects %s", (_label, req, re) => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(createUser(TENANT_ID, req, TOKEN)).rejects.toThrow(re);
        expect(guardedFetchMock).not.toHaveBeenCalled();
    }));
    it("rejects a non-object request payload", () => __awaiter(void 0, void 0, void 0, function* () {
        // Forcing the runtime guard at the top of createUser.
        yield expect(createUser(TENANT_ID, null, TOKEN)).rejects.toThrow();
    }));
    it("posts the expected payload and maps the response", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            status: 201,
            ok: true,
            body: {
                id: "new-id",
                userPrincipalName: "alice@example.com",
                displayName: "Alice",
                accountEnabled: true,
                mailNickname: "alice",
                createdDateTime: "2026-01-01T00:00:00Z",
            },
        }));
        const result = yield createUser(TENANT_ID, Object.assign(Object.assign({}, validReq), { usageLocation: "US", givenName: "Alice", surname: "Doe", jobTitle: "Eng", department: "Cloud" }), TOKEN);
        expect(result.id).toBe("new-id");
        expect(result.userPrincipalName).toBe("alice@example.com");
        expect(result.createdDateTime).toBe("2026-01-01T00:00:00Z");
        const [, init] = guardedFetchMock.mock.calls[0];
        const sent = JSON.parse(init.body);
        expect(sent.userPrincipalName).toBe("alice@example.com");
        expect(sent.usageLocation).toBe("US");
        expect(sent.givenName).toBe("Alice");
        expect(sent.surname).toBe("Doe");
        expect(sent.jobTitle).toBe("Eng");
        expect(sent.department).toBe("Cloud");
        const profile = sent.passwordProfile;
        expect(profile.password).toBe("P@ssw0rd!");
    }));
    it("propagates 403 PermissionError-style failures", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            ok: false,
            status: 403,
            body: { error: { code: "Authorization_RequestDenied", message: "no" } },
        }));
        yield expect(createUser(TENANT_ID, validReq, TOKEN)).rejects.toMatchObject({
            status: 403,
        });
    }));
    it("returns empty-string defaults when Graph response omits fields", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({ status: 201, ok: true, body: {} }));
        const result = yield createUser(TENANT_ID, validReq, TOKEN);
        expect(result.id).toBe("");
        expect(result.userPrincipalName).toBe("");
        expect(result.displayName).toBe("");
        expect(result.mailNickname).toBe("");
        expect(result.accountEnabled).toBe(false);
        expect(result.createdDateTime).toBeUndefined();
    }));
});
// ---------------------------------------------------------------------------
// listVerifiedDomains
// ---------------------------------------------------------------------------
describe("listVerifiedDomains", () => {
    it("returns [] when /organization is empty", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({ body: { value: [] } }));
        expect(yield listVerifiedDomains(TENANT_ID, TOKEN)).toEqual([]);
    }));
    it("filters domains by Email capability or .onmicrosoft.com suffix", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            body: {
                value: [
                    {
                        verifiedDomains: [
                            {
                                name: "contoso.onmicrosoft.com",
                                isDefault: true,
                                isInitial: true,
                                type: "Managed",
                                capabilities: "OfficeCommunicationsOnline",
                            },
                            {
                                name: "contoso.com",
                                isDefault: false,
                                isInitial: false,
                                type: "Managed",
                                capabilities: "Email, OfficeCommunicationsOnline",
                            },
                            {
                                name: "no-mail.example",
                                isDefault: false,
                                isInitial: false,
                                type: "Managed",
                                capabilities: "OfficeCommunicationsOnline",
                            },
                            {
                                name: "",
                                isDefault: false,
                                isInitial: false,
                                type: "Managed",
                                capabilities: "Email",
                            },
                        ],
                    },
                ],
            },
        }));
        const out = yield listVerifiedDomains(TENANT_ID, TOKEN);
        const names = out.map((d) => d.name).sort();
        expect(names).toEqual(["contoso.com", "contoso.onmicrosoft.com"]);
    }));
    it("propagates 401 errors", () => __awaiter(void 0, void 0, void 0, function* () {
        guardedFetchMock.mockResolvedValueOnce(jsonResponse({
            ok: false,
            status: 401,
            body: { error: { code: "InvalidAuthenticationToken", message: "no" } },
        }));
        yield expect(listVerifiedDomains(TENANT_ID, TOKEN)).rejects.toMatchObject({
            status: 401,
        });
    }));
});
// ---------------------------------------------------------------------------
// listOrgSubscriptions (deferred / placeholder)
// ---------------------------------------------------------------------------
describe("listOrgSubscriptions", () => {
    it("validates tenantId and returns [] without HTTP traffic", () => __awaiter(void 0, void 0, void 0, function* () {
        expect(yield listOrgSubscriptions(TENANT_ID, TOKEN)).toEqual([]);
        expect(guardedFetchMock).not.toHaveBeenCalled();
    }));
    it("rejects invalid tenantId", () => __awaiter(void 0, void 0, void 0, function* () {
        yield expect(listOrgSubscriptions("not-a-guid", TOKEN)).rejects.toThrow(/Invalid tenantId/);
    }));
});
//# sourceMappingURL=graph-service.test.js.map