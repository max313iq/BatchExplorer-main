import { __awaiter } from "tslib";
/**
 * Tests for the shared `_shared/paginate.ts` helper. Covers:
 *   - empty initial URL = single fetch, returns all
 *   - chained nextLink walks the full chain
 *   - abort signal short-circuits the walk
 *   - onPage receives chunks progressively
 *   - custom parsePage extracts non-default array fields
 */
import { fetchAllPages } from "../_shared/paginate";
describe("fetchAllPages (shared)", () => {
    it("returns the single page when there is no nextLink", () => __awaiter(void 0, void 0, void 0, function* () {
        const fetcher = jest.fn(() => __awaiter(void 0, void 0, void 0, function* () {
            return ({
                value: [{ id: "a" }, { id: "b" }],
            });
        }));
        const out = yield fetchAllPages({
            initialUrl: "https://example/p1",
            nextLinkPath: (p) => p.nextLink,
            fetcher,
        });
        expect(out).toEqual([{ id: "a" }, { id: "b" }]);
        expect(fetcher).toHaveBeenCalledTimes(1);
    }));
    it("walks every page when nextLink is set", () => __awaiter(void 0, void 0, void 0, function* () {
        const fetcher = jest
            .fn()
            .mockResolvedValueOnce({
            value: [{ id: "a" }],
            nextLink: "https://example/p2",
        })
            .mockResolvedValueOnce({
            value: [{ id: "b" }],
            nextLink: "https://example/p3",
        })
            .mockResolvedValueOnce({ value: [{ id: "c" }] });
        const out = yield fetchAllPages({
            initialUrl: "https://example/p1",
            nextLinkPath: (p) => p.nextLink,
            fetcher,
        });
        expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
        expect(fetcher).toHaveBeenCalledTimes(3);
    }));
    it("calls onPage(chunk, cumulative, hasMore) per page", () => __awaiter(void 0, void 0, void 0, function* () {
        const fetcher = jest
            .fn()
            .mockResolvedValueOnce({
            value: [{ id: "a" }, { id: "b" }],
            nextLink: "https://example/p2",
        })
            .mockResolvedValueOnce({ value: [{ id: "c" }] });
        const onPage = jest.fn();
        yield fetchAllPages({
            initialUrl: "https://example/p1",
            nextLinkPath: (p) => p.nextLink,
            onPage,
            fetcher,
        });
        expect(onPage).toHaveBeenCalledTimes(2);
        expect(onPage.mock.calls[0][2]).toBe(true); // hasMore after page 1
        expect(onPage.mock.calls[1][2]).toBe(false); // hasMore after page 2
        expect(onPage.mock.calls[1][1]).toHaveLength(3); // cumulative
    }));
    it("aborts when signal.aborted before first fetch", () => __awaiter(void 0, void 0, void 0, function* () {
        const controller = new AbortController();
        controller.abort();
        const fetcher = jest.fn();
        yield expect(fetchAllPages({
            initialUrl: "https://example/p1",
            nextLinkPath: () => undefined,
            signal: controller.signal,
            fetcher,
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(fetcher).not.toHaveBeenCalled();
    }));
    it("supports custom parsePage to extract non-default array fields", () => __awaiter(void 0, void 0, void 0, function* () {
        const fetcher = jest.fn(() => __awaiter(void 0, void 0, void 0, function* () {
            return ({
                items: [{ x: 1 }, { x: 2 }],
            });
        }));
        const out = yield fetchAllPages({
            initialUrl: "https://example/p1",
            nextLinkPath: () => undefined,
            parsePage: (p) => { var _a; return (_a = p.items) !== null && _a !== void 0 ? _a : []; },
            fetcher,
        });
        expect(out).toEqual([{ x: 1 }, { x: 2 }]);
    }));
});
//# sourceMappingURL=fetch-all-pages-shared.spec.js.map