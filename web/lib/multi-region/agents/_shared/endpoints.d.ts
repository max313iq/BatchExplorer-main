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
export interface AccountForEndpoint {
    accountName: string;
    region: string;
}
/** Bare host: `{name}.{region}.batch.azure.com` — no scheme. */
export declare function accountEndpointHost(accountName: string, region: string): string;
export declare function accountEndpointHost(account: AccountForEndpoint): string;
/** Full URL: `https://{name}.{region}.batch.azure.com`. */
export declare function accountEndpoint(accountName: string, region: string): string;
export declare function accountEndpoint(account: AccountForEndpoint): string;
//# sourceMappingURL=endpoints.d.ts.map