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
export function accountEndpointHost(
  accountName: string,
  region: string,
): string;
export function accountEndpointHost(account: AccountForEndpoint): string;
export function accountEndpointHost(
  accountOrName: AccountForEndpoint | string,
  region?: string,
): string {
  if (typeof accountOrName === "string") {
    return `${accountOrName}.${region}.batch.azure.com`;
  }
  return `${accountOrName.accountName}.${accountOrName.region}.batch.azure.com`;
}

/** Full URL: `https://{name}.{region}.batch.azure.com`. */
export function accountEndpoint(
  accountName: string,
  region: string,
): string;
export function accountEndpoint(account: AccountForEndpoint): string;
export function accountEndpoint(
  accountOrName: AccountForEndpoint | string,
  region?: string,
): string {
  if (typeof accountOrName === "string") {
    return `https://${accountEndpointHost(accountOrName, region!)}`;
  }
  return `https://${accountEndpointHost(accountOrName)}`;
}
