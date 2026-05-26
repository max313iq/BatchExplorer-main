/**
 * Verify `isRetryableStatus(408)` is true AND that a 408 routes through
 * `TransientError` via `classifyHttpError`. This was missing before —
 * `request-scheduler.ts:184` retried 408 but the type classification
 * lost the retryable signal, so consumers branching on
 * `error.isRetryable` mis-handled it as fatal.
 */
import { classifyHttpError, isRetryableStatus, TransientError, } from "../types";
describe("isRetryableStatus(408)", () => {
    it("returns true for HTTP 408 (request timeout)", () => {
        expect(isRetryableStatus(408)).toBe(true);
    });
    it("still returns true for 429 / 500 / 502 / 503", () => {
        expect(isRetryableStatus(429)).toBe(true);
        expect(isRetryableStatus(500)).toBe(true);
        expect(isRetryableStatus(502)).toBe(true);
        expect(isRetryableStatus(503)).toBe(true);
    });
    it("returns false for non-retryable statuses", () => {
        expect(isRetryableStatus(400)).toBe(false);
        expect(isRetryableStatus(403)).toBe(false);
        expect(isRetryableStatus(404)).toBe(false);
        expect(isRetryableStatus(409)).toBe(false);
    });
});
describe("classifyHttpError on 408", () => {
    it("marks the resulting AzureRequestError as retryable", () => {
        const err = classifyHttpError("timed out", 408, "RequestTimeout", null);
        expect(err.isRetryable).toBe(true);
    });
    it("classifies 500-range as TransientError but 408 as base + retryable", () => {
        const t500 = classifyHttpError("server error", 500, "InternalError", null);
        expect(t500).toBeInstanceOf(TransientError);
        expect(t500.isRetryable).toBe(true);
        // 408 doesn't have a dedicated subclass — the base
        // AzureRequestError with isRetryable === true is what consumers
        // expect.
        const t408 = classifyHttpError("timed out", 408, "RequestTimeout", null);
        expect(t408.isRetryable).toBe(true);
    });
});
//# sourceMappingURL=retryable-status-408.spec.js.map