/**
 * Single source of truth for Batch account endpoint construction.
 *
 * Previously, every agent inlined some flavor of
 *   `https://${account.accountName}.${account.region}.batch.azure.com`
 * or the host-only
 *   `${accountName}.${region}.batch.azure.com`.
 *
 * Both shapes are needed at call sites — service helpers like
 * `createPool(endpoint, ...)` expect the `https://`-prefixed URL, while a
 * few read paths build just the host. Two named exports avoid the
 * silent-mismatch class of bugs ("did I include the scheme this time?")
 * the old inline strings invited.
 */
export function accountEndpointHost(accountOrName, region) {
    if (typeof accountOrName === "string") {
        return `${accountOrName}.${region}.batch.azure.com`;
    }
    return `${accountOrName.accountName}.${accountOrName.region}.batch.azure.com`;
}
export function accountEndpoint(accountOrName, region) {
    if (typeof accountOrName === "string") {
        return `https://${accountEndpointHost(accountOrName, region)}`;
    }
    return `https://${accountEndpointHost(accountOrName)}`;
}
//# sourceMappingURL=endpoints.js.map