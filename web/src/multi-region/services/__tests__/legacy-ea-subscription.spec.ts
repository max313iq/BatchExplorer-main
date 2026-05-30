/**
 * Tests for createLegacyEaSubscription owner handling.
 *
 * Regression: a non-GUID owner (a UPN / email pasted into the "owners" box)
 * used to be silently filtered out, leaving an empty `owners: []` in the body
 * — which Azure rejects with "Owners are not valid, please make sure request
 * has correct tenant Id and object Id". The fix validates owners up front
 * (clear error naming the bad value) and never emits an empty owners array.
 *
 * Runner matches `*.spec.ts` only (util/common-config/jest-common.js).
 */

jest.mock("../../scheduling/request-governance", () => ({
  guardedFetch: jest.fn(),
}));

import * as armService from "../arm-service";
import { ValidationError } from "../types";
import { guardedFetch } from "../../scheduling/request-governance";

const guardedFetchMock = guardedFetch as jest.MockedFunction<
  typeof guardedFetch
>;

const ENROLLMENT_ID = "3f4941fd-7cc7-4b33-977f-23abd34d273c";
const OWNER_A = "11111111-2222-3333-4444-555555555555";
const OWNER_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function syncSuccess(): Response {
  // 200 with no Location/Azure-AsyncOperation header → synchronous success.
  return {
    status: 200,
    statusText: "OK",
    ok: true,
    url: "https://management.azure.com/",
    headers: { get: () => null } as unknown as Headers,
    text: () => Promise.resolve(JSON.stringify({ subscriptionLink: "" })),
    json: () =>
      Promise.resolve({
        subscriptionLink: `/subscriptions/${OWNER_A}`,
      }),
    clone: () => syncSuccess(),
  } as unknown as Response;
}

/** Parse the JSON body sent on the first guardedFetch call. */
function sentBody(): Record<string, unknown> {
  const init = guardedFetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("createLegacyEaSubscription — owners", () => {
  beforeEach(() => {
    guardedFetchMock.mockReset();
  });

  it("throws a clear ValidationError for a non-GUID owner and never calls ARM", async () => {
    await expect(
      armService.createLegacyEaSubscription(
        ENROLLMENT_ID,
        { offerType: "MS-AZR-0017P", owners: ["chung.ho@essist.com.tw"] },
        "tok",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      armService.createLegacyEaSubscription(
        ENROLLMENT_ID,
        { offerType: "MS-AZR-0017P", owners: ["chung.ho@essist.com.tw"] },
        "tok",
      ),
    ).rejects.toThrow(/not AAD object ids/i);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("omits owners entirely when all rows are blank (caller becomes owner)", async () => {
    guardedFetchMock.mockResolvedValueOnce(syncSuccess());

    await armService.createLegacyEaSubscription(
      ENROLLMENT_ID,
      { offerType: "MS-AZR-0017P", owners: ["", "   "] },
      "tok",
    );

    const body = sentBody();
    expect(body).not.toHaveProperty("owners");
    expect(body.offerType).toBe("MS-AZR-0017P");
  });

  it("sends valid owners as {objectId} objects, trimming and dropping blanks", async () => {
    guardedFetchMock.mockResolvedValueOnce(syncSuccess());

    await armService.createLegacyEaSubscription(
      ENROLLMENT_ID,
      {
        offerType: "MS-AZR-0148P",
        displayName: "  Dev Team  ",
        owners: [` ${OWNER_A} `, "", OWNER_B],
      },
      "tok",
    );

    const body = sentBody();
    expect(body.owners).toEqual([
      { objectId: OWNER_A },
      { objectId: OWNER_B },
    ]);
    expect(body.displayName).toBe("Dev Team");
  });

  it("rejects a malformed enrollment account id before fetching", async () => {
    await expect(
      armService.createLegacyEaSubscription(
        "not-a-guid",
        { offerType: "MS-AZR-0017P" },
        "tok",
      ),
    ).rejects.toThrow(/enrollmentAccountObjectId must be a UUID/);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });
});
