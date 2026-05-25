/**
 * Tests for the imported-tokens module — specifically the
 * proxy-fallback path of `redeemRefreshToken` and the
 * `parseRetryAfterHeader` helper. Both were tightened in the
 * 2026-05-25 auth-pod pass.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

import { parseRetryAfterHeader, ImportedTokenError } from "../imported-tokens";

describe("parseRetryAfterHeader", () => {
  it("returns null for missing / empty input", () => {
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader("")).toBeNull();
    expect(parseRetryAfterHeader("   ")).toBeNull();
  });

  it("parses an integer seconds form to milliseconds", () => {
    expect(parseRetryAfterHeader("30")).toBe(30_000);
    expect(parseRetryAfterHeader("0")).toBe(0);
    expect(parseRetryAfterHeader("2.5")).toBe(2_500);
  });

  it("parses an HTTP-date form to a positive delta", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfterHeader(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(2_000);
    expect(ms!).toBeLessThan(8_000);
  });

  it("returns null for non-numeric, non-date input", () => {
    expect(parseRetryAfterHeader("soonish")).toBeNull();
  });
});

describe("redeemRefreshToken proxy fallback", () => {
  // ALWAYS register the redeemRefreshToken function fresh so the
  // mock fetch state doesn't leak between cases.
  let originalFetch: typeof global.fetch | undefined;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch;
    else delete (global as { fetch?: typeof fetch }).fetch;
  });

  it("includes x-proxy-target header when falling back to /api/auth/proxy-token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = jest.fn().mockImplementation(
      async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (typeof url === "string" && url.includes("login.microsoftonline.com")) {
          // Simulate CORS failure on direct AAD POST.
          throw new TypeError("Failed to fetch");
        }
        if (typeof url === "string" && url === "/api/auth/proxy-token") {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({
              access_token: "proxied-arm-token",
              expires_in: 3600,
            }),
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      },
    ) as unknown as typeof fetch;

    const { redeemRefreshToken } = require("../imported-tokens");
    const result = await redeemRefreshToken(
      "fake-rt",
      "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
      "tenant-id",
      "https://management.azure.com/.default",
    );

    expect(result.access_token).toBe("proxied-arm-token");
    // Find the proxy call.
    const proxyCall = calls.find((c) => c.url === "/api/auth/proxy-token");
    expect(proxyCall).toBeDefined();
    const headers = (proxyCall!.init?.headers ?? {}) as Record<string, string>;
    // Header MUST point at AAD's login.microsoftonline.com endpoint.
    expect(headers["x-proxy-target"]).toMatch(/login\.microsoftonline\.com/);
    expect(headers["x-proxy-target"]).toMatch(/oauth2\/v2\.0\/token/);
  });

  it("propagates the 429 + Retry-After as a typed ImportedTokenError", async () => {
    global.fetch = jest.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 429,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "retry-after" ? "10" : null,
        },
        json: async () => ({ error: "throttled" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { redeemRefreshToken } = require("../imported-tokens");
    await expect(
      redeemRefreshToken(
        "fake-rt",
        "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
        "tenant",
        "https://management.azure.com/.default",
      ),
    ).rejects.toMatchObject({
      name: "ImportedTokenError",
      code: "rate_limited",
      httpStatus: 429,
      retryAfterMs: 10_000,
    });
  });

  it("throws retry_after_exceeded when Retry-After is > 60s", async () => {
    global.fetch = jest.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 429,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "retry-after" ? "300" : null,
        },
        json: async () => ({ error: "throttled" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { redeemRefreshToken } = require("../imported-tokens");
    await expect(
      redeemRefreshToken("rt", "client", "tenant", "scope"),
    ).rejects.toMatchObject({
      name: "ImportedTokenError",
      code: "retry_after_exceeded",
    });
  });
});

describe("ImportedTokenError", () => {
  it("carries code / body / httpStatus and preserves message on .message", () => {
    const err = new ImportedTokenError(
      "invalid_grant",
      "AAD says no.",
      { error: "invalid_grant", error_description: "expired RT" },
      400,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ImportedTokenError");
    expect(err.message).toBe("AAD says no.");
    expect(err.code).toBe("invalid_grant");
    expect(err.httpStatus).toBe(400);
    expect(err.body.error_description).toBe("expired RT");
  });
});
