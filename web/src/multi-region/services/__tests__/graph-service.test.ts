import {
  ROLE_AUTHENTICATION_ADMIN,
  ROLE_GLOBAL_ADMIN,
  ROLE_HELPDESK_ADMIN,
  ROLE_PRIVILEGED_AUTH_ADMIN,
  ROLE_USER_ADMIN,
  canCreateUsers,
  canResetPasswords,
  createUser,
  getMyDirectoryRoles,
  getUserDirectoryRoles,
  listOrgSubscriptions,
  listOrgUsers,
  listVerifiedDomains,
  resetUserPassword,
} from "../graph-service";
import type { CreateUserRequest } from "../graph-service";
import { AzureRequestError, DirectoryRole } from "../types";

// Mock guardedFetch so the service hits our fake instead of network.
jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(),
}));

// Re-import after the mock is in place so we can drive the mock per-test.
import { guardedFetch } from "../../scheduling/request-governance";

const guardedFetchMock = guardedFetch as jest.MockedFunction<
  typeof guardedFetch
>;

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TOKEN = "fake-access-token";

interface JsonResponseInit {
  status?: number;
  ok?: boolean;
  body?: unknown;
}

function jsonResponse(init: JsonResponseInit = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  const body = init.body ?? {};
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

function makeRole(roleTemplateId: string, displayName = "Some Role"): DirectoryRole {
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
    expect(
      canResetPasswords([makeRole("00000000-0000-0000-0000-000000000000")]),
    ).toBe(false);
  });

  it("returns true when one of several roles matches", () => {
    expect(
      canResetPasswords([
        makeRole("00000000-0000-0000-0000-000000000000"),
        makeRole(ROLE_HELPDESK_ADMIN),
      ]),
    ).toBe(true);
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
  it("rejects an invalid tenantId without calling fetch", async () => {
    await expect(listOrgUsers("not-a-guid", TOKEN)).rejects.toThrow(
      /Invalid tenantId/,
    );
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("returns mapped users on a happy path single page", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
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
      }),
    );

    const users = await listOrgUsers(TENANT_ID, TOKEN);
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
    expect((url as string).startsWith("https://graph.microsoft.com/v1.0/users")).toBe(
      true,
    );
    expect((url as string)).toContain("%24select=");
    expect((url as string)).toContain("%24top=");
    const headers = (init as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opts).toEqual({ subscriptionId: TENANT_ID, family: "graph" });
  });

  it("paginates via @odata.nextLink", async () => {
    guardedFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            value: [{ id: "u1", displayName: "U1", userPrincipalName: "u1" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?next=2",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            value: [{ id: "u2", displayName: "U2", userPrincipalName: "u2" }],
          },
        }),
      );

    const users = await listOrgUsers(TENANT_ID, TOKEN);
    expect(users.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(guardedFetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses $search + ConsistencyLevel header when search is supplied", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({ body: { value: [] } }),
    );
    await listOrgUsers(TENANT_ID, TOKEN, {
      search: 'al"ice',
      top: 50,
      select: ["id", "displayName"],
    });

    const [url, init] = guardedFetchMock.mock.calls[0];
    expect((url as string)).toContain("%24search=");
    expect((url as string)).toContain("%24count=true");
    const headers = (init as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["ConsistencyLevel"]).toBe("eventual");
  });

  it("does not set $search when the search string is empty/whitespace", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({ body: { value: [] } }),
    );
    await listOrgUsers(TENANT_ID, TOKEN, { search: "   " });
    const [url, init] = guardedFetchMock.mock.calls[0];
    expect((url as string)).not.toContain("%24search=");
    const headers = (init as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["ConsistencyLevel"]).toBeUndefined();
  });

  it("throws AzureRequestError on 401", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: false,
        status: 401,
        body: { error: { code: "InvalidAuthenticationToken", message: "bad" } },
      }),
    );
    await expect(listOrgUsers(TENANT_ID, TOKEN)).rejects.toBeInstanceOf(
      AzureRequestError,
    );
  });

  it("throws AzureRequestError on 429 with rate-limit info", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: false,
        status: 429,
        body: { error: { code: "TooManyRequests", message: "slow down" } },
      }),
    );
    await expect(listOrgUsers(TENANT_ID, TOKEN)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("falls back to a generic error message when body parse fails", async () => {
    const badResponse = {
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response;
    guardedFetchMock.mockResolvedValueOnce(badResponse);
    await expect(listOrgUsers(TENANT_ID, TOKEN)).rejects.toMatchObject({
      status: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// getMyDirectoryRoles / getUserDirectoryRoles
// ---------------------------------------------------------------------------

describe("getMyDirectoryRoles", () => {
  it("filters out non-directoryRole entries", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
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
      }),
    );

    const roles = await getMyDirectoryRoles(TENANT_ID, TOKEN);
    expect(roles).toHaveLength(1);
    expect(roles[0].roleTemplateId).toBe(ROLE_GLOBAL_ADMIN);
  });

  it("rejects invalid tenantId", async () => {
    await expect(
      getMyDirectoryRoles("not-a-guid", TOKEN),
    ).rejects.toThrow(/Invalid tenantId/);
  });

  it("propagates 403 errors", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: false,
        status: 403,
        body: { error: { code: "Authorization_RequestDenied", message: "no" } },
      }),
    );
    await expect(getMyDirectoryRoles(TENANT_ID, TOKEN)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("getUserDirectoryRoles", () => {
  it("rejects invalid userId", async () => {
    await expect(
      getUserDirectoryRoles(TENANT_ID, "not-a-guid", TOKEN),
    ).rejects.toThrow(/Invalid userId/);
  });

  it("rejects invalid tenantId", async () => {
    await expect(
      getUserDirectoryRoles("not-a-guid", USER_ID, TOKEN),
    ).rejects.toThrow(/Invalid tenantId/);
  });

  it("hits /users/{id}/memberOf and maps roles", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
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
      }),
    );
    const roles = await getUserDirectoryRoles(TENANT_ID, USER_ID, TOKEN);
    expect(roles).toHaveLength(1);
    expect(roles[0].displayName).toBe("User Admin");
    const [url] = guardedFetchMock.mock.calls[0];
    expect((url as string)).toContain(
      `/users/${encodeURIComponent(USER_ID)}/memberOf`,
    );
  });
});

// ---------------------------------------------------------------------------
// resetUserPassword
// ---------------------------------------------------------------------------

describe("resetUserPassword", () => {
  it("sends PATCH /users/{id} with passwordProfile", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 204, ok: true, body: {} }),
    );
    await resetUserPassword(TENANT_ID, USER_ID, "P@ssw0rd!", true, TOKEN);

    const [url, init] = guardedFetchMock.mock.calls[0];
    expect((url as string)).toContain(
      `/users/${encodeURIComponent(USER_ID)}`,
    );
    expect((init as RequestInit).method).toBe("PATCH");
    const body = JSON.parse((init as RequestInit).body as string) as {
      passwordProfile: { password: string; forceChangePasswordNextSignIn: boolean };
    };
    expect(body.passwordProfile.password).toBe("P@ssw0rd!");
    expect(body.passwordProfile.forceChangePasswordNextSignIn).toBe(true);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("rejects an empty password without calling fetch", async () => {
    await expect(
      resetUserPassword(TENANT_ID, USER_ID, "", false, TOKEN),
    ).rejects.toThrow(/Invalid newPassword/);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid userId", async () => {
    await expect(
      resetUserPassword(TENANT_ID, "bad", "x", false, TOKEN),
    ).rejects.toThrow(/Invalid userId/);
  });

  it("scrubs password from echo-back error messages", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: false,
        status: 400,
        body: {
          error: {
            code: "BadRequest",
            message:
              'Invalid body: {"passwordProfile":{"password":"super-secret"}}',
          },
        },
      }),
    );
    let caught: AzureRequestError | undefined;
    try {
      await resetUserPassword(TENANT_ID, USER_ID, "x", false, TOKEN);
    } catch (e) {
      caught = e as AzureRequestError;
    }
    expect(caught).toBeInstanceOf(AzureRequestError);
    expect(caught?.message).not.toContain("super-secret");
    expect(caught?.message).toContain('"password":"***"');
  });

  it("propagates 404 when user does not exist", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: false,
        status: 404,
        body: { error: { code: "Request_ResourceNotFound", message: "no" } },
      }),
    );
    await expect(
      resetUserPassword(TENANT_ID, USER_ID, "x", false, TOKEN),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------

describe("createUser", () => {
  const validReq: CreateUserRequest = {
    userPrincipalName: "alice@example.com",
    displayName: "Alice",
    mailNickname: "alice",
    password: "P@ssw0rd!",
    forceChangePasswordNextSignIn: true,
    accountEnabled: true,
  };

  it("rejects invalid tenantId without calling fetch", async () => {
    await expect(createUser("not-a-guid", validReq, TOKEN)).rejects.toThrow(
      /Invalid tenantId/,
    );
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing UPN",
      { ...validReq, userPrincipalName: "no-at-sign" },
      /Invalid userPrincipalName/,
    ],
    [
      "missing displayName",
      { ...validReq, displayName: "" },
      /Invalid displayName/,
    ],
    [
      "missing mailNickname",
      { ...validReq, mailNickname: "" },
      /Invalid mailNickname/,
    ],
    ["empty password", { ...validReq, password: "" }, /Invalid password/],
  ])("rejects %s", async (_label, req, re) => {
    await expect(createUser(TENANT_ID, req, TOKEN)).rejects.toThrow(re);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-object request payload", async () => {
    // Forcing the runtime guard at the top of createUser.
    await expect(
      createUser(
        TENANT_ID,
        null as unknown as CreateUserRequest,
        TOKEN,
      ),
    ).rejects.toThrow();
  });

  it("posts the expected payload and maps the response", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
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
      }),
    );
    const result = await createUser(
      TENANT_ID,
      {
        ...validReq,
        usageLocation: "US",
        givenName: "Alice",
        surname: "Doe",
        jobTitle: "Eng",
        department: "Cloud",
      },
      TOKEN,
    );
    expect(result.id).toBe("new-id");
    expect(result.userPrincipalName).toBe("alice@example.com");
    expect(result.createdDateTime).toBe("2026-01-01T00:00:00Z");

    const [, init] = guardedFetchMock.mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(sent.userPrincipalName).toBe("alice@example.com");
    expect(sent.usageLocation).toBe("US");
    expect(sent.givenName).toBe("Alice");
    expect(sent.surname).toBe("Doe");
    expect(sent.jobTitle).toBe("Eng");
    expect(sent.department).toBe("Cloud");
    const profile = sent.passwordProfile as Record<string, unknown>;
    expect(profile.password).toBe("P@ssw0rd!");
  });

  it("propagates 403 PermissionError-style failures", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: false,
        status: 403,
        body: { error: { code: "Authorization_RequestDenied", message: "no" } },
      }),
    );
    await expect(createUser(TENANT_ID, validReq, TOKEN)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("returns empty-string defaults when Graph response omits fields", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 201, ok: true, body: {} }),
    );
    const result = await createUser(TENANT_ID, validReq, TOKEN);
    expect(result.id).toBe("");
    expect(result.userPrincipalName).toBe("");
    expect(result.displayName).toBe("");
    expect(result.mailNickname).toBe("");
    expect(result.accountEnabled).toBe(false);
    expect(result.createdDateTime).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listVerifiedDomains
// ---------------------------------------------------------------------------

describe("listVerifiedDomains", () => {
  it("returns [] when /organization is empty", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({ body: { value: [] } }),
    );
    expect(await listVerifiedDomains(TENANT_ID, TOKEN)).toEqual([]);
  });

  it("filters domains by Email capability or .onmicrosoft.com suffix", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
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
      }),
    );
    const out = await listVerifiedDomains(TENANT_ID, TOKEN);
    const names = out.map((d) => d.name).sort();
    expect(names).toEqual(["contoso.com", "contoso.onmicrosoft.com"]);
  });

  it("propagates 401 errors", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: false,
        status: 401,
        body: { error: { code: "InvalidAuthenticationToken", message: "no" } },
      }),
    );
    await expect(listVerifiedDomains(TENANT_ID, TOKEN)).rejects.toMatchObject({
      status: 401,
    });
  });
});

// ---------------------------------------------------------------------------
// listOrgSubscriptions (deferred / placeholder)
// ---------------------------------------------------------------------------

describe("listOrgSubscriptions", () => {
  it("validates tenantId and returns [] without HTTP traffic", async () => {
    expect(await listOrgSubscriptions(TENANT_ID, TOKEN)).toEqual([]);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid tenantId", async () => {
    await expect(listOrgSubscriptions("not-a-guid", TOKEN)).rejects.toThrow(
      /Invalid tenantId/,
    );
  });
});
