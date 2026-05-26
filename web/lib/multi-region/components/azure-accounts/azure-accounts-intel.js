const CLOUD_DESCRIPTIONS = {
    commercial: "Public Azure (login.microsoftonline.com → graph.microsoft.com → management.azure.com).",
    gov: "Azure US Government (login.microsoftonline.us → graph.microsoft.us → management.usgovcloudapi.net).",
    dod: "Azure US Government DoD (Defense cloud; same endpoints as Gov but DoD subset of CA policies).",
    china: "Azure China 21Vianet (login.partner.microsoftonline.cn → microsoftgraph.chinacloudapi.cn → management.chinacloudapi.cn).",
    germany: "Azure Germany (legacy: login.microsoftonline.de → graph.microsoft.de). Retired for new tenants.",
    unknown: "Could not classify the sign-in environment from the MSAL `environment` field.",
};
/**
 * Classify an account by the MSAL `environment` string AND, when
 * available, the `iss` claim from a token decoded by the page. The
 * `environment` field is set by MSAL when it caches the account, and
 * is the most reliable signal for which cloud minted the original token
 * — `tid` looks the same across clouds for the same tenant GUID, but
 * `environment` will always be the per-cloud login host.
 *
 * Defenders: a single user with the SAME `homeAccountId` showing up in
 * both `commercial` and `gov` is exactly the cross-cloud pivot pattern
 * in `_bypass_tenant_switch.md §8.2`.
 */
export function classifyCloudEnvironment(environment) {
    const env = (environment !== null && environment !== void 0 ? environment : "").toLowerCase();
    if (!env) {
        return {
            kind: "unknown",
            label: "Unknown",
            description: CLOUD_DESCRIPTIONS.unknown,
        };
    }
    // Gov / DoD share `login.microsoftonline.us`; the DoD subset is only
    // identifiable from CA policy / tenant config so we conservatively
    // classify as `gov` and let the operator drill in via the drawer.
    if (env.includes("login.microsoftonline.us") ||
        env.includes("graph.microsoft.us") ||
        env.includes("usgovcloudapi.net")) {
        return {
            kind: "gov",
            label: "US Gov",
            description: CLOUD_DESCRIPTIONS.gov,
        };
    }
    if (env.includes("login.partner.microsoftonline.cn") ||
        env.includes("microsoftgraph.chinacloudapi.cn") ||
        env.includes("chinacloudapi.cn")) {
        return {
            kind: "china",
            label: "China",
            description: CLOUD_DESCRIPTIONS.china,
        };
    }
    if (env.includes("login.microsoftonline.de") ||
        env.includes("microsoftazure.de")) {
        return {
            kind: "germany",
            label: "Germany",
            description: CLOUD_DESCRIPTIONS.germany,
        };
    }
    if (env.includes("login.microsoftonline.com") ||
        env.includes("graph.microsoft.com") ||
        env.includes("management.azure.com") ||
        env.includes("sts.windows.net")) {
        return {
            kind: "commercial",
            label: "Commercial",
            description: CLOUD_DESCRIPTIONS.commercial,
        };
    }
    return {
        kind: "unknown",
        label: env,
        description: CLOUD_DESCRIPTIONS.unknown,
    };
}
export function detectCrossTenant(account) {
    var _a, _b, _c, _d, _e;
    const active = account.activeTenantId && account.activeTenantId.length > 0
        ? account.activeTenantId
        : account.tenantId;
    if (!active)
        return null;
    if (active === account.tenantId)
        return null;
    const tenants = (_a = account.tenants) !== null && _a !== void 0 ? _a : [];
    const activeRow = tenants.find((t) => t.tenantId === active);
    const homeRow = tenants.find((t) => t.tenantId === account.tenantId);
    return {
        homeTenantId: account.tenantId,
        activeTenantId: active,
        activeTenantLabel: (_c = (_b = activeRow === null || activeRow === void 0 ? void 0 : activeRow.displayName) !== null && _b !== void 0 ? _b : activeRow === null || activeRow === void 0 ? void 0 : activeRow.defaultDomain) !== null && _c !== void 0 ? _c : active,
        homeTenantLabel: (_e = (_d = homeRow === null || homeRow === void 0 ? void 0 : homeRow.displayName) !== null && _d !== void 0 ? _d : homeRow === null || homeRow === void 0 ? void 0 : homeRow.defaultDomain) !== null && _e !== void 0 ? _e : account.tenantId,
        // `tenants` is populated lazily — if it's empty we have nothing to
        // compare against and should NOT raise a stale flag. Only when the
        // list is non-empty AND the active id is missing from it do we know
        // the operator is on a tenant they no longer enumerate.
        staleAssociation: tenants.length > 0 && !tenants.some((t) => t.tenantId === active),
    };
}
/**
 * Build the tenant graph from the page's `accounts` array. Single pass,
 * O(accounts × tenants_per_account + subs); cheap to recompute on every
 * accounts change but the caller should still wrap in `useMemo` because
 * the resulting `TenantNode` objects are new identities.
 */
export function buildTenantGraph(accounts) {
    var _a, _b, _c;
    const nodes = new Map();
    const ensureNode = (tenantId, label, defaultDomain) => {
        let node = nodes.get(tenantId);
        if (!node) {
            node = {
                tenantId,
                label: label !== null && label !== void 0 ? label : tenantId,
                defaultDomain,
                accountHomeAccountIds: [],
                subscriptions: [],
                homeAccountsCount: 0,
                guestAccountsCount: 0,
                guestOnly: false,
            };
            nodes.set(tenantId, node);
        }
        else {
            // Upgrade the label if we've learned a friendlier name from a
            // later account's tenant list (`tenants` is best-effort and the
            // first account that discovered the tenant may have only a GUID).
            if ((node.label === node.tenantId || !node.label) &&
                label &&
                label !== tenantId) {
                node.label = label;
            }
            if (!node.defaultDomain && defaultDomain) {
                node.defaultDomain = defaultDomain;
            }
        }
        return node;
    };
    let multiTenantAccountCount = 0;
    let subscriptionCount = 0;
    for (const acct of accounts) {
        // 1. Home tenant — always a node, possibly without a friendly label
        //    if `tenants` hasn't been fetched yet.
        const homeRow = (_a = acct.tenants) === null || _a === void 0 ? void 0 : _a.find((t) => t.tenantId === acct.tenantId);
        const homeNode = ensureNode(acct.tenantId, (_b = homeRow === null || homeRow === void 0 ? void 0 : homeRow.displayName) !== null && _b !== void 0 ? _b : homeRow === null || homeRow === void 0 ? void 0 : homeRow.defaultDomain, homeRow === null || homeRow === void 0 ? void 0 : homeRow.defaultDomain);
        if (!homeNode.accountHomeAccountIds.includes(acct.homeAccountId)) {
            homeNode.accountHomeAccountIds.push(acct.homeAccountId);
            homeNode.homeAccountsCount += 1;
        }
        // 2. Every other tenant in the account's tenants list is a guest
        //    relationship from this account's perspective.
        const allTenants = (_c = acct.tenants) !== null && _c !== void 0 ? _c : [];
        let touched = 0;
        for (const t of allTenants) {
            const node = ensureNode(t.tenantId, t.displayName, t.defaultDomain);
            if (t.tenantId === acct.tenantId) {
                touched += 1;
                continue;
            }
            if (!node.accountHomeAccountIds.includes(acct.homeAccountId)) {
                node.accountHomeAccountIds.push(acct.homeAccountId);
                node.guestAccountsCount += 1;
            }
            touched += 1;
        }
        if (touched > 1)
            multiTenantAccountCount += 1;
        // 3. Subscriptions — bucket by the subscription's `tenantId` (which
        //    is the OWNING tenant). A subscription from a Lighthouse-
        //    delegated tenant will land in that delegated tenant's node
        //    even though the account itself is in a different home tenant.
        for (const sub of acct.subscriptions) {
            subscriptionCount += 1;
            const node = ensureNode(sub.tenantId, undefined, undefined);
            // Dedup by subscription id (some accounts can see the same sub
            // via two routes — Lighthouse + direct guest — and we don't want
            // to double-count it).
            if (!node.subscriptions.some((s) => s.subscriptionId === sub.subscriptionId)) {
                node.subscriptions.push({
                    subscriptionId: sub.subscriptionId,
                    displayName: sub.displayName,
                    ownedBy: acct.homeAccountId,
                });
            }
        }
    }
    // Flag tenants that NO surveyed account claims as home — those are
    // "guest-only" entries (you reach them via someone's guest invitation
    // or via a subscription's owning-tenant pointer, but no signed-in
    // account is native there).
    for (const node of nodes.values()) {
        node.guestOnly = node.homeAccountsCount === 0;
    }
    const sorted = Array.from(nodes.values()).sort((a, b) => {
        // Home-tenants of signed-in accounts first; then by friendly label.
        if (a.homeAccountsCount > 0 && b.homeAccountsCount === 0)
            return -1;
        if (b.homeAccountsCount > 0 && a.homeAccountsCount === 0)
            return 1;
        return a.label.localeCompare(b.label);
    });
    return {
        nodes: sorted,
        accountCount: accounts.length,
        tenantCount: sorted.length,
        subscriptionCount,
        multiTenantAccountCount,
    };
}
export function summarizePosture(accounts) {
    let crossTenantCount = 0;
    let staleTenantCount = 0;
    let sovereignAccountCount = 0;
    const cloudByAccount = {};
    const crossTenantByAccount = {};
    for (const acct of accounts) {
        const cloud = classifyCloudEnvironment(acct.environment);
        cloudByAccount[acct.homeAccountId] = cloud;
        if (cloud.kind !== "commercial" && cloud.kind !== "unknown") {
            sovereignAccountCount += 1;
        }
        const xt = detectCrossTenant(acct);
        if (xt) {
            crossTenantByAccount[acct.homeAccountId] = xt;
            crossTenantCount += 1;
            if (xt.staleAssociation)
                staleTenantCount += 1;
        }
    }
    return {
        crossTenantCount,
        staleTenantCount,
        sovereignAccountCount,
        cloudByAccount,
        crossTenantByAccount,
    };
}
/* ------------------------------------------------------------------ */
/*  Token-age trend buckets                                           */
/* ------------------------------------------------------------------ */
/**
 * Bucket an account into a "token age trend" — coarse-grained colour
 * coding for an inline mini-trend cell. We don't have per-token issue
 * timestamps available without decoding every cached JWT (and that
 * would burn an MSAL silent acquire), so we use `addedAt` as the
 * conservative proxy: it's set on initial sign-in and updated on every
 * refresh, so it tracks "how long since this account's bundle was last
 * confirmed valid".
 *
 * The same buckets drive the inline sparkline in the row — see
 * `tenant-graph-panel.tsx`.
 */
export function bucketAccountAge(account, now) {
    const ts = account.addedAt ? Date.parse(account.addedAt) : NaN;
    if (!Number.isFinite(ts)) {
        return { bucket: "ancient", ageMs: Number.POSITIVE_INFINITY, ageLabel: "—" };
    }
    const age = now - ts;
    if (age < 60 * 60 * 1000) {
        return { bucket: "fresh", ageMs: age, ageLabel: "<1h" };
    }
    if (age < 6 * 60 * 60 * 1000) {
        return { bucket: "warm", ageMs: age, ageLabel: "<6h" };
    }
    if (age < 24 * 60 * 60 * 1000) {
        return { bucket: "cool", ageMs: age, ageLabel: "<24h" };
    }
    if (age < 7 * 24 * 60 * 60 * 1000) {
        return { bucket: "stale", ageMs: age, ageLabel: "<7d" };
    }
    return { bucket: "ancient", ageMs: age, ageLabel: "≥7d" };
}
//# sourceMappingURL=azure-accounts-intel.js.map