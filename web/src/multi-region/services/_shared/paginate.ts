/**
 * Shared `nextLink`-walking pagination primitive.
 *
 * Every service (ARM, Batch, Graph, Quota, ARG) has its own paginate
 * loop that does the same thing with a different "next page" key:
 *
 *   ARM:   `data.nextLink`
 *   Batch: `data["odata.nextLink"]`
 *   Graph: `data["@odata.nextLink"]`
 *   ARG:   `$skipToken` (POST-bodied)
 *
 * Five near-identical implementations is five places to forget AbortSignal,
 * five places to special-case 4xx parsing, and five places to drift apart
 * over time. This module centralizes the GET-style walk; ARG's POST-bodied
 * pagination keeps its own loop because the cursor lives in the request
 * body, not in a response field.
 */

import { abortError } from "../abort-helpers";

export interface FetchAllPagesOptions<T> {
  /** Initial URL — first page fetched. */
  initialUrl: string;
  /**
   * Field accessor that returns the next-page URL (or null/undefined when
   * pagination is complete). Receives the parsed page JSON.
   *
   * Common values:
   *   ARM:   `(p) => p.nextLink`
   *   Batch: `(p) => p["odata.nextLink"]`
   *   Graph: `(p) => p["@odata.nextLink"]`
   */
  nextLinkPath: (page: any) => string | undefined | null;
  /**
   * Field accessor that returns the array of rows in a page. Defaults
   * to `(p) => p.value` — true for ARM / Graph / Batch.
   */
  parsePage?: (page: any) => T[];
  /**
   * Single-page fetch primitive. The shared paginate doesn't know about
   * tokens / headers / family classification — those are baked into the
   * service-specific fetcher.
   *
   * MUST throw on non-2xx; the paginate loop assumes a resolved value
   * is parseable. `signal` is forwarded so the underlying fetch can
   * honor cancellation.
   */
  fetcher: (url: string, signal?: AbortSignal) => Promise<any>;
  /** Optional cancellation hook. */
  signal?: AbortSignal;
  /**
   * Optional per-page hook. Receives `(chunk, cumulative, hasMore)` so
   * progressive-render UIs can paint as each page lands without
   * waiting for the full walk.
   */
  onPage?: (chunk: T[], cumulative: T[], hasMore: boolean) => void;
}

/**
 * Walk every page of a paginated response, concatenating row arrays.
 *
 * Throws a canonical `AbortError` (DOMException, name === "AbortError")
 * when the signal fires mid-walk — services / hooks that check
 * `e.name === "AbortError"` swallow it correctly.
 */
export async function fetchAllPages<T>(
  opts: FetchAllPagesOptions<T>,
): Promise<T[]> {
  const parsePage = opts.parsePage ?? ((p: { value?: T[] }) => p.value ?? []);
  const all: T[] = [];
  let url: string | undefined | null = opts.initialUrl;
  while (url) {
    if (opts.signal?.aborted) throw abortError();
    const page = await opts.fetcher(url, opts.signal);
    const chunk = parsePage(page);
    if (Array.isArray(chunk) && chunk.length > 0) all.push(...chunk);
    url = opts.nextLinkPath(page);
    opts.onPage?.(Array.isArray(chunk) ? chunk : [], all, Boolean(url));
  }
  return all;
}
