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
import { __awaiter } from "tslib";
import { abortError } from "../abort-helpers";
/**
 * Walk every page of a paginated response, concatenating row arrays.
 *
 * Throws a canonical `AbortError` (DOMException, name === "AbortError")
 * when the signal fires mid-walk — services / hooks that check
 * `e.name === "AbortError"` swallow it correctly.
 */
export function fetchAllPages(opts) {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function* () {
        const parsePage = (_a = opts.parsePage) !== null && _a !== void 0 ? _a : ((p) => { var _a; return (_a = p.value) !== null && _a !== void 0 ? _a : []; });
        const all = [];
        let url = opts.initialUrl;
        while (url) {
            if ((_b = opts.signal) === null || _b === void 0 ? void 0 : _b.aborted)
                throw abortError();
            const page = yield opts.fetcher(url, opts.signal);
            const chunk = parsePage(page);
            if (Array.isArray(chunk) && chunk.length > 0)
                all.push(...chunk);
            url = opts.nextLinkPath(page);
            (_c = opts.onPage) === null || _c === void 0 ? void 0 : _c.call(opts, Array.isArray(chunk) ? chunk : [], all, Boolean(url));
        }
        return all;
    });
}
//# sourceMappingURL=paginate.js.map