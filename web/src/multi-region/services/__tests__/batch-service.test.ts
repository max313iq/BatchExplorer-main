import * as batchService from "../batch-service";
import {
  AzureRequestError,
  BatchPool,
  BatchNode,
  NodeAction,
} from "../types";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  url?: string;
  body?: unknown;
  rawText?: string;
  headers?: Record<string, string>;
}

/**
 * Build a Response-like object compatible with what `guardedFetch` and
 * `batch-service` consume. Mirrors the helper used in `arm-service.test.ts`:
 * - `headers.get(name)` for Retry-After / x-ms-throttling-version
 * - `clone().text()` for error bodies
 * - `json()` for the parsed Batch payload
 */
function makeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const statusText = init.statusText ?? "";
  const url = init.url ?? "https://acct.eastus.batch.azure.com/";
  const headersMap = new Map<string, string>(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const headers = {
    get: (name: string): string | null =>
      headersMap.get(name.toLowerCase()) ?? null,
  } as unknown as Headers;

  const text =
    init.rawText !== undefined
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
    json: () =>
      init.body !== undefined
        ? Promise.resolve(init.body as unknown)
        : Promise.reject(new Error("no body")),
    clone: () => makeResponse(init),
  };

  return response as unknown as Response;
}

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;

function getFetchMock(): FetchMock {
  return global.fetch as unknown as FetchMock;
}

function queueResponses(responses: Response[]): void {
  const mock = getFetchMock();
  for (const r of responses) {
    mock.mockResolvedValueOnce(r);
  }
}

// Valid Batch endpoint per the SSRF guard in `validateAccountEndpoint`.
const VALID_ENDPOINT = "https://acct.eastus.batch.azure.com";
const TOKEN = "test-token";

// ---------------------------------------------------------------------------
// Setup / teardown — hermetic per design contract §9.
// ---------------------------------------------------------------------------

describe("batch-service", () => {
  // jest.fn() token provider per the brief; the service itself takes raw
  // strings, so the provider is called by tests that need rotation semantics.
  let tokenProvider: jest.Mock<string, []>;

  beforeEach(() => {
    (global.fetch as unknown as jest.Mock) = jest.fn();
    tokenProvider = jest.fn(() => TOKEN);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Endpoint validation (SSRF guard) — exercised through every public method
  // -------------------------------------------------------------------------
  describe("endpoint validation", () => {
    it("rejects non-batch.azure.com endpoints in listPools", async () => {
      await expect(
        batchService.listPools("evil.example.com", tokenProvider()),
      ).rejects.toThrow(/batch\.azure\.com/);
      expect(getFetchMock()).not.toHaveBeenCalled();
    });

    it("rejects malformed endpoints", async () => {
      await expect(
        batchService.listPools("not a url at all !!!", tokenProvider()),
      ).rejects.toThrow(/Invalid accountEndpoint|hostname/);
      expect(getFetchMock()).not.toHaveBeenCalled();
    });

    it("accepts bare hostnames (auto-prepends https://)", async () => {
      queueResponses([makeResponse({ status: 200, body: { value: [] } })]);
      await expect(
        batchService.listPools("acct.eastus.batch.azure.com", tokenProvider()),
      ).resolves.toEqual([]);
      expect(getFetchMock()).toHaveBeenCalledTimes(1);
      const url = getFetchMock().mock.calls[0]?.[0];
      expect(url).toMatch(/^https:\/\/acct\.eastus\.batch\.azure\.com\/pools\?/);
    });
  });

  // -------------------------------------------------------------------------
  // listPools
  // -------------------------------------------------------------------------
  describe("listPools", () => {
    it("returns pools and follows odata.nextLink pagination", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [{ id: "pool-1", vmSize: "STANDARD_D2_V3" }],
            "odata.nextLink":
              "https://acct.eastus.batch.azure.com/pools?api-version=2024-07-01.20.0&skip=1",
          },
        }),
        makeResponse({
          status: 200,
          body: {
            value: [{ id: "pool-2", vmSize: "STANDARD_D2_V3" }],
          },
        }),
      ]);

      const pools: BatchPool[] = await batchService.listPools(
        VALID_ENDPOINT,
        tokenProvider(),
      );
      expect(pools).toHaveLength(2);
      expect(pools[0]?.id).toBe("pool-1");
      expect(pools[1]?.id).toBe("pool-2");
      expect(getFetchMock()).toHaveBeenCalledTimes(2);

      // Verify Authorization header on the first call.
      const firstInit = getFetchMock().mock.calls[0]?.[1];
      const headers = firstInit?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers?.Accept).toMatch(/application\/json/);

      // Token provider was invoked exactly once per call site.
      expect(tokenProvider).toHaveBeenCalledTimes(1);
    });

    it("returns [] when value is missing or non-array", async () => {
      queueResponses([makeResponse({ status: 200, body: { value: null } })]);
      const pools = await batchService.listPools(VALID_ENDPOINT, TOKEN);
      expect(pools).toEqual([]);
    });

    it("throws AzureRequestError on 401 (auth failure)", async () => {
      queueResponses([
        makeResponse({
          status: 401,
          statusText: "Unauthorized",
          body: {
            error: {
              code: "InvalidAuthenticationToken",
              message: { value: "token expired" },
            },
          },
        }),
      ]);

      try {
        await batchService.listPools(VALID_ENDPOINT, "bad");
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err).toBeInstanceOf(AzureRequestError);
        expect(err.status).toBe(401);
        expect(err.code).toBe("InvalidAuthenticationToken");
        expect(err.message).toBe("token expired");
      }
    });

    it("surfaces 5xx errors as AzureRequestError with status preserved", async () => {
      queueResponses([
        makeResponse({
          status: 503,
          statusText: "Service Unavailable",
          body: {
            error: { code: "ServiceUnavailable", message: "try later" },
          },
        }),
      ]);

      await expect(
        batchService.listPools(VALID_ENDPOINT, TOKEN),
      ).rejects.toMatchObject({ status: 503 });
    });

    it("falls back to a default message when the error body is empty", async () => {
      queueResponses([
        makeResponse({ status: 500, rawText: "", body: undefined }),
      ]);

      try {
        await batchService.listPools(VALID_ENDPOINT, TOKEN);
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err.status).toBe(500);
        expect(err.message).toContain("500");
      }
    });
  });

  // -------------------------------------------------------------------------
  // createPool
  // -------------------------------------------------------------------------
  describe("createPool", () => {
    it("POSTs the pool body and resolves on 201", async () => {
      queueResponses([
        makeResponse({ status: 201, body: { /* Batch returns empty */ } }),
      ]);

      await expect(
        batchService.createPool(
          VALID_ENDPOINT,
          { id: "new-pool", vmSize: "STANDARD_D2_V3" },
          TOKEN,
        ),
      ).resolves.toBeUndefined();

      const call = getFetchMock().mock.calls[0];
      expect(call?.[1]?.method).toBe("POST");
      const init = call?.[1];
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers?.["Content-Type"]).toMatch(/application\/json/);
      expect(init?.body).toBe(
        JSON.stringify({ id: "new-pool", vmSize: "STANDARD_D2_V3" }),
      );
    });

    it("throws AzureRequestError on 400 (validation)", async () => {
      queueResponses([
        makeResponse({
          status: 400,
          statusText: "Bad Request",
          body: {
            "odata.error": {
              code: "InvalidPropertyValue",
              message: { value: "vmSize is required" },
            },
          },
        }),
      ]);

      try {
        await batchService.createPool(
          VALID_ENDPOINT,
          { id: "incomplete" },
          TOKEN,
        );
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err.status).toBe(400);
        expect(err.code).toBe("InvalidPropertyValue");
        expect(err.message).toBe("vmSize is required");
      }
    });
  });

  // -------------------------------------------------------------------------
  // patchPool (resize / update)
  // -------------------------------------------------------------------------
  describe("patchPool", () => {
    it("PATCHes the pool with the provided patch body", async () => {
      queueResponses([makeResponse({ status: 200, body: {} })]);

      await batchService.patchPool(
        VALID_ENDPOINT,
        "pool with spaces",
        { targetDedicatedNodes: 5 },
        TOKEN,
      );

      const call = getFetchMock().mock.calls[0];
      expect(call?.[1]?.method).toBe("PATCH");
      // poolId is URI-encoded.
      expect(call?.[0]).toContain("/pools/pool%20with%20spaces?");
      expect(call?.[1]?.body).toBe(
        JSON.stringify({ targetDedicatedNodes: 5 }),
      );
    });

    it("throws AzureRequestError on 404 (resize a missing pool)", async () => {
      queueResponses([
        makeResponse({
          status: 404,
          statusText: "Not Found",
          body: {
            error: {
              code: "PoolNotFound",
              message: { value: "pool 'ghost' does not exist" },
            },
          },
        }),
      ]);

      try {
        await batchService.patchPool(
          VALID_ENDPOINT,
          "ghost",
          { targetDedicatedNodes: 1 },
          TOKEN,
        );
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err.status).toBe(404);
        expect(err.code).toBe("PoolNotFound");
      }
    });
  });

  // -------------------------------------------------------------------------
  // deletePool
  // -------------------------------------------------------------------------
  describe("deletePool", () => {
    it("DELETEs the encoded pool URL", async () => {
      queueResponses([makeResponse({ status: 202, body: {} })]);

      await batchService.deletePool(VALID_ENDPOINT, "p/1", TOKEN);

      const call = getFetchMock().mock.calls[0];
      expect(call?.[1]?.method).toBe("DELETE");
      expect(call?.[0]).toContain("/pools/p%2F1?");
      const headers = call?.[1]?.headers as
        | Record<string, string>
        | undefined;
      expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("throws AzureRequestError on 429 with retry hint surfaced", async () => {
      queueResponses([
        makeResponse({
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "30" },
          body: {
            error: {
              code: "TooManyRequests",
              message: { value: "slow down" },
            },
          },
        }),
      ]);

      try {
        await batchService.deletePool(VALID_ENDPOINT, "p", TOKEN);
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err.status).toBe(429);
        expect(err.code).toBe("TooManyRequests");
        // The base AzureRequestError marks 429 as retryable.
        expect(err.isRetryable).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // listNodes
  // -------------------------------------------------------------------------
  describe("listNodes", () => {
    it("returns nodes for a pool", async () => {
      queueResponses([
        makeResponse({
          status: 200,
          body: {
            value: [
              { id: "node-1", state: "idle", schedulingState: "enabled" },
              { id: "node-2", state: "running", schedulingState: "enabled" },
            ],
          },
        }),
      ]);

      const nodes: BatchNode[] = await batchService.listNodes(
        VALID_ENDPOINT,
        "my-pool",
        TOKEN,
      );
      expect(nodes).toHaveLength(2);
      expect(nodes[0]?.id).toBe("node-1");
      expect(nodes[1]?.schedulingState).toBe("enabled");

      const url = getFetchMock().mock.calls[0]?.[0];
      expect(url).toContain("/pools/my-pool/nodes?");
    });

    it("throws AzureRequestError on 404 (pool removed mid-flight)", async () => {
      queueResponses([
        makeResponse({
          status: 404,
          body: {
            error: { code: "PoolNotFound", message: "deleted" },
          },
        }),
      ]);

      await expect(
        batchService.listNodes(VALID_ENDPOINT, "gone", TOKEN),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  // -------------------------------------------------------------------------
  // performNodeAction (reboot / reimage / scheduling state)
  // -------------------------------------------------------------------------
  describe("performNodeAction", () => {
    const cases: Array<{ action: NodeAction; expectedSegment: string }> = [
      { action: "reboot", expectedSegment: "reboot" },
      { action: "reimage", expectedSegment: "reimage" },
      { action: "disableScheduling", expectedSegment: "disablescheduling" },
      { action: "enableScheduling", expectedSegment: "enablescheduling" },
    ];

    it.each(cases)(
      "POSTs to the correct segment for action=%p",
      async ({ action, expectedSegment }) => {
        queueResponses([makeResponse({ status: 202, body: {} })]);

        await batchService.performNodeAction(
          VALID_ENDPOINT,
          "pool-x",
          "node-y",
          action,
          TOKEN,
        );

        const call = getFetchMock().mock.calls[0];
        expect(call?.[1]?.method).toBe("POST");
        // URL must contain encoded poolId/nodeId and the mapped segment.
        expect(call?.[0]).toContain(
          `/pools/pool-x/nodes/node-y/${expectedSegment}?`,
        );
        // Body is `{}` per the implementation.
        expect(call?.[1]?.body).toBe("{}");
      },
    );

    it("URI-encodes pool and node IDs containing special characters", async () => {
      queueResponses([makeResponse({ status: 202, body: {} })]);

      await batchService.performNodeAction(
        VALID_ENDPOINT,
        "p/1",
        "n#2",
        "reboot",
        TOKEN,
      );

      const url = getFetchMock().mock.calls[0]?.[0];
      expect(url).toContain("/pools/p%2F1/nodes/n%232/reboot?");
    });

    it("throws AzureRequestError on 5xx (transient batch failure)", async () => {
      queueResponses([
        makeResponse({
          status: 502,
          body: { error: { code: "BadGateway", message: "upstream broke" } },
        }),
      ]);

      try {
        await batchService.performNodeAction(
          VALID_ENDPOINT,
          "p",
          "n",
          "reimage",
          TOKEN,
        );
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err.status).toBe(502);
        // 5xx is retryable per AzureRequestError auto-classification.
        expect(err.isRetryable).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // removeNodes (bulk node removal)
  // -------------------------------------------------------------------------
  describe("removeNodes", () => {
    it("POSTs nodeList JSON body to /removenodes", async () => {
      queueResponses([makeResponse({ status: 202, body: {} })]);

      await batchService.removeNodes(
        VALID_ENDPOINT,
        "p/1",
        ["a", "b", "c"],
        TOKEN,
      );

      const call = getFetchMock().mock.calls[0];
      expect(call?.[1]?.method).toBe("POST");
      expect(call?.[0]).toContain("/pools/p%2F1/removenodes?");
      expect(call?.[1]?.body).toBe(
        JSON.stringify({ nodeList: ["a", "b", "c"] }),
      );
    });

    it("throws AzureRequestError on 403 (permission denied)", async () => {
      queueResponses([
        makeResponse({
          status: 403,
          body: {
            error: {
              code: "AuthorizationFailed",
              message: { value: "no access" },
            },
          },
        }),
      ]);

      try {
        await batchService.removeNodes(VALID_ENDPOINT, "p", ["x"], TOKEN);
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err.status).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Error pathways covered via the toBatchError helper indirectly. These
  // tests verify the message-extraction branches survive the JSON parse
  // failure path (`response.json().catch(() => ({}))` in batch-service).
  // -------------------------------------------------------------------------
  describe("error body parsing", () => {
    it("recovers when error body is non-JSON", async () => {
      // `json()` rejects -> caught -> falls back to default message.
      const badResponse = makeResponse({
        status: 500,
        rawText: "<html>oops</html>",
      });
      // Override json() to reject so the catch path runs.
      (badResponse as unknown as { json: () => Promise<unknown> }).json = () =>
        Promise.reject(new SyntaxError("Unexpected token <"));

      queueResponses([badResponse]);

      try {
        await batchService.listPools(VALID_ENDPOINT, TOKEN);
        fail("expected throw");
      } catch (e) {
        const err = e as AzureRequestError;
        expect(err.status).toBe(500);
        // Default fallback message contains the status code.
        expect(err.message).toMatch(/500/);
      }
    });
  });
});
