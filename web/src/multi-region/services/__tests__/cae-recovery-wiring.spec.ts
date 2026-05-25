/**
 * Wiring test: `guardedFetch` should call `tokenProvider(claims)` on a
 * CAE 401 and retry the request with the fresh bearer header.
 */
import { guardedFetch } from "../../scheduling/request-governance";

/**
 * Minimal fake Response. jsdom doesn't expose `Response`, and the unit
 * test only exercises `status` / `headers.get` / `clone().text()` /
 * `text()` / `json()` — stubbing those keeps the test deterministic
 * without pulling in a full polyfill.
 */
function fakeResponse(opts: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  url?: string;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  const body = opts.body ?? "";
  const url = opts.url ?? "https://example.test/";
  const self: any = {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers,
    url,
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : {}),
    clone: () => fakeResponse(opts),
  };
  return self as Response;
}

function b64UrlEncode(s: string): string {
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

describe("guardedFetch + CAE recovery", () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
  });

  it("retries with claims-derived token when caller supplies tokenProvider", async () => {
    const challengeClaims = b64UrlEncode(
      JSON.stringify({ access_token: { acrs: { essential: true } } }),
    );
    const wwwAuth = `Bearer authorization_uri="https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize", error="insufficient_claims", claims="${challengeClaims}"`;
    let calls = 0;
    const seen: Array<string | null> = [];
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const headers = new Headers(init?.headers);
      seen.push(headers.get("Authorization"));
      if (calls === 1) {
        return fakeResponse({
          status: 401,
          body: JSON.stringify({ error: { code: "401" } }),
          headers: { "WWW-Authenticate": wwwAuth },
        });
      }
      return fakeResponse({
        status: 200,
        body: JSON.stringify({ ok: true }),
      });
    }) as unknown as typeof fetch;

    const tokenProvider = jest.fn(async (claims?: string) => {
      expect(typeof claims).toBe("string");
      expect((claims ?? "").length).toBeGreaterThan(0);
      return "fresh-token";
    });

    const resp = await guardedFetch(
      "https://management.azure.com/subscriptions/test",
      {
        headers: { Authorization: "Bearer stale-token" },
      },
      {
        subscriptionId: "sub-test",
        family: "arm",
        tokenProvider,
      },
    );

    expect(resp.status).toBe(200);
    expect(calls).toBe(2);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    // First call used the stale token, retry used the fresh one.
    expect(seen[0]).toBe("Bearer stale-token");
    expect(seen[1]).toBe("Bearer fresh-token");
  });

  it("bubbles 401 unchanged when no tokenProvider is supplied", async () => {
    global.fetch = jest.fn(async () => {
      return fakeResponse({
        status: 401,
        body: "{}",
        headers: {
          "WWW-Authenticate": `Bearer claims="${b64UrlEncode("{}")}"`,
        },
      });
    }) as unknown as typeof fetch;

    const resp = await guardedFetch(
      "https://management.azure.com/foo",
      { headers: { Authorization: "Bearer x" } },
      { subscriptionId: "sub-test", family: "arm" },
    );
    expect(resp.status).toBe(401);
  });
});
