import { FilterAgent } from "../filter-agent";
import { MultiRegionStore } from "../../store/multi-region-store";
import { ManagedAccount, ManagedPool } from "../../store/store-types";
import { FilterInput } from "../agent-types";

// Avoid persistence side effects from msal-auth's setActiveTenant.
jest.mock("../../auth/msal-auth", () => ({
  setActiveTenant: jest.fn(),
}));

const makeAccount = (
  id: string,
  overrides: Partial<ManagedAccount> = {},
): ManagedAccount => ({
  id,
  accountName: `acct-${id}`,
  resourceGroup: "rg",
  subscriptionId: "sub1",
  region: "eastus",
  provisioningState: "created",
  ...overrides,
});

const makePool = (
  id: string,
  accountId: string,
  overrides: Partial<ManagedPool> = {},
): ManagedPool => ({
  id,
  accountId,
  poolId: `pool-${id}`,
  provisioningState: "created",
  config: {},
  ...overrides,
});

const buildStore = (
  accounts: ManagedAccount[],
  pools: ManagedPool[] = [],
): MultiRegionStore => new MultiRegionStore({ accounts, pools });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("FilterAgent — basics & no-filter behavior", () => {
  it("exposes name 'filter' and a no-op cancel()", () => {
    const agent = new FilterAgent(buildStore([]));
    expect(agent.name).toBe("filter");
    expect(() => agent.cancel()).not.toThrow();
  });

  it("returns all accounts when no filters are supplied", () => {
    const accounts = [makeAccount("a1"), makeAccount("a2"), makeAccount("a3")];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({ filters: {} });
    expect(out.matchCount).toBe(3);
    expect(out.accounts.map((a) => a.accountId).sort()).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
  });

  it("maps account fields onto FilterOutput shape", () => {
    const acct = makeAccount("a1", {
      accountName: "Acme",
      region: "eastus",
      subscriptionId: "subZ",
    });
    const agent = new FilterAgent(buildStore([acct]));
    const out = agent.filter({ filters: {} });
    expect(out.accounts[0]).toEqual({
      accountId: "a1",
      accountName: "Acme",
      region: "eastus",
      subscriptionId: "subZ",
      hasPool: false,
    });
  });

  it("returns matchCount 0 when state has no accounts", () => {
    const agent = new FilterAgent(buildStore([]));
    const out = agent.filter({ filters: {} });
    expect(out.matchCount).toBe(0);
    expect(out.accounts).toEqual([]);
  });

  it("treats empty filter arrays as no filter", () => {
    const accounts = [makeAccount("a1"), makeAccount("a2")];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({
      filters: { regions: [], subscriptionIds: [], accountIds: [] },
    });
    expect(out.matchCount).toBe(2);
  });
});

describe("FilterAgent — region filter", () => {
  it("filters by region (case-insensitive on both filter and account)", () => {
    const accounts = [
      makeAccount("a1", { region: "eastus" }),
      makeAccount("a2", { region: "WESTUS" }),
      makeAccount("a3", { region: "westeurope" }),
    ];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({ filters: { regions: ["EASTUS", "westus"] } });
    expect(out.matchCount).toBe(2);
    expect(out.accounts.map((a) => a.accountId).sort()).toEqual(["a1", "a2"]);
  });

  it("returns nothing when no region matches", () => {
    const accounts = [makeAccount("a1", { region: "eastus" })];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({ filters: { regions: ["southeastasia"] } });
    expect(out.matchCount).toBe(0);
  });
});

describe("FilterAgent — subscription filter", () => {
  it("filters by subscriptionIds (exact match)", () => {
    const accounts = [
      makeAccount("a1", { subscriptionId: "subA" }),
      makeAccount("a2", { subscriptionId: "subB" }),
      makeAccount("a3", { subscriptionId: "subC" }),
    ];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({
      filters: { subscriptionIds: ["subA", "subC"] },
    });
    expect(out.matchCount).toBe(2);
    expect(out.accounts.map((a) => a.accountId).sort()).toEqual(["a1", "a3"]);
  });

  it("subscription filter is case-sensitive", () => {
    const accounts = [makeAccount("a1", { subscriptionId: "SubA" })];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({ filters: { subscriptionIds: ["suba"] } });
    expect(out.matchCount).toBe(0);
  });
});

describe("FilterAgent — provisioningState filter", () => {
  it("filters by exact provisioningState", () => {
    const accounts = [
      makeAccount("a1", { provisioningState: "created" }),
      makeAccount("a2", { provisioningState: "pending" }),
      makeAccount("a3", { provisioningState: "failed" }),
    ];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({ filters: { provisioningState: "pending" } });
    expect(out.matchCount).toBe(1);
    expect(out.accounts[0].accountId).toBe("a2");
  });

  it("'all' bypasses the provisioningState filter", () => {
    const accounts = [
      makeAccount("a1", { provisioningState: "created" }),
      makeAccount("a2", { provisioningState: "pending" }),
    ];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({ filters: { provisioningState: "all" } });
    expect(out.matchCount).toBe(2);
  });
});

describe("FilterAgent — accountIds filter", () => {
  it("filters by explicit account id list", () => {
    const accounts = [makeAccount("a1"), makeAccount("a2"), makeAccount("a3")];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({ filters: { accountIds: ["a1", "a3"] } });
    expect(out.matchCount).toBe(2);
    expect(out.accounts.map((a) => a.accountId).sort()).toEqual(["a1", "a3"]);
  });

  it("returns empty when accountIds list contains no real ids", () => {
    const accounts = [makeAccount("a1")];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({ filters: { accountIds: ["nope"] } });
    expect(out.matchCount).toBe(0);
  });
});

describe("FilterAgent — hasPool filter & hasPool flag", () => {
  it("hasPool=true keeps only accounts with a 'created' pool", () => {
    const accounts = [makeAccount("a1"), makeAccount("a2"), makeAccount("a3")];
    const pools = [
      makePool("p1", "a1", { provisioningState: "created" }),
      makePool("p2", "a2", { provisioningState: "pending" }),
    ];
    const agent = new FilterAgent(buildStore(accounts, pools));
    const out = agent.filter({ filters: { hasPool: true } });
    expect(out.matchCount).toBe(1);
    expect(out.accounts[0].accountId).toBe("a1");
    expect(out.accounts[0].hasPool).toBe(true);
  });

  it("hasPool=false keeps only accounts without a 'created' pool", () => {
    const accounts = [makeAccount("a1"), makeAccount("a2")];
    const pools = [makePool("p1", "a1", { provisioningState: "created" })];
    const agent = new FilterAgent(buildStore(accounts, pools));
    const out = agent.filter({ filters: { hasPool: false } });
    expect(out.matchCount).toBe(1);
    expect(out.accounts[0].accountId).toBe("a2");
    expect(out.accounts[0].hasPool).toBe(false);
  });

  it("non-'created' pool states do not count as having a pool", () => {
    const accounts = [makeAccount("a1")];
    const pools = [makePool("p1", "a1", { provisioningState: "failed" })];
    const agent = new FilterAgent(buildStore(accounts, pools));
    const out = agent.filter({ filters: {} });
    expect(out.accounts[0].hasPool).toBe(false);
  });

  it("hasPool flag is populated even when filter is not applied", () => {
    const accounts = [makeAccount("a1"), makeAccount("a2")];
    const pools = [makePool("p1", "a1", { provisioningState: "created" })];
    const agent = new FilterAgent(buildStore(accounts, pools));
    const out = agent.filter({ filters: {} });
    const a1 = out.accounts.find((a) => a.accountId === "a1");
    const a2 = out.accounts.find((a) => a.accountId === "a2");
    expect(a1?.hasPool).toBe(true);
    expect(a2?.hasPool).toBe(false);
  });
});

describe("FilterAgent — combined filters", () => {
  it("AND-combines region + subscription + provisioningState + hasPool", () => {
    const accounts = [
      makeAccount("a1", {
        region: "eastus",
        subscriptionId: "subA",
        provisioningState: "created",
      }),
      makeAccount("a2", {
        region: "eastus",
        subscriptionId: "subA",
        provisioningState: "pending",
      }),
      makeAccount("a3", {
        region: "westus",
        subscriptionId: "subA",
        provisioningState: "created",
      }),
      makeAccount("a4", {
        region: "eastus",
        subscriptionId: "subB",
        provisioningState: "created",
      }),
    ];
    const pools = [
      makePool("p1", "a1", { provisioningState: "created" }),
      makePool("p2", "a4", { provisioningState: "created" }),
    ];
    const agent = new FilterAgent(buildStore(accounts, pools));
    const out = agent.filter({
      filters: {
        regions: ["eastus"],
        subscriptionIds: ["subA"],
        provisioningState: "created",
        hasPool: true,
      },
    });
    expect(out.matchCount).toBe(1);
    expect(out.accounts[0].accountId).toBe("a1");
  });

  it("accountIds + provisioningState combine correctly", () => {
    const accounts = [
      makeAccount("a1", { provisioningState: "created" }),
      makeAccount("a2", { provisioningState: "pending" }),
      makeAccount("a3", { provisioningState: "pending" }),
    ];
    const agent = new FilterAgent(buildStore(accounts));
    const out = agent.filter({
      filters: {
        accountIds: ["a1", "a2"],
        provisioningState: "pending",
      },
    });
    expect(out.matchCount).toBe(1);
    expect(out.accounts[0].accountId).toBe("a2");
  });
});

describe("FilterAgent — execute() agent contract", () => {
  it("execute() resolves to a completed AgentResult with FilterOutput summary", async () => {
    const accounts = [makeAccount("a1"), makeAccount("a2")];
    const agent = new FilterAgent(buildStore(accounts));
    const params: FilterInput = { filters: { accountIds: ["a1"] } };
    const result = await agent.execute(
      params as unknown as Record<string, unknown>,
    );
    expect(result.status).toBe("completed");
    expect(result.summary.matchCount).toBe(1);
    const summaryAccounts = result.summary.accounts as Array<{
      accountId: string;
    }>;
    expect(summaryAccounts).toHaveLength(1);
    expect(summaryAccounts[0].accountId).toBe("a1");
  });
});
