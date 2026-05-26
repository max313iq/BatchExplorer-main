import { __awaiter } from "tslib";
/**
 * Tests for RequestGuard (rate limiter + circuit breaker) from
 * src/multi-region/scheduling/request-governance.ts.
 *
 * Coverage targets:
 *   - Closed circuit allows requests through.
 *   - Threshold of failures opens the circuit.
 *   - Open circuit short-circuits subsequent requests.
 *   - Half-open after cooldown; single probe; success → closed; failure → open.
 *   - Per-(subscriptionId, family) isolation.
 *   - Telemetry transitions are surfaced to the sink.
 */
import { RequestGuard, getSharedRequestGuard, } from '../request-governance';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SUB_A = 'sub-aaaaaaaaaaaaaaaa';
const SUB_B = 'sub-bbbbbbbbbbbbbbbb';
function makeSink() {
    const entries = [];
    const transitions = [];
    const criticals = [];
    return {
        entries,
        transitions,
        criticals,
        setEntry(subscriptionId, family, entry) {
            entries.push({ subscriptionId, family, entry });
        },
        pushTransition(t) {
            transitions.push(t);
        },
        critical(message) {
            criticals.push(message);
        },
    };
}
function ctx429(retryAfterMs = null) {
    return { status: 429, retryAfterMs, headers: null, bodyText: null };
}
function ctxOk() {
    return { status: 200, retryAfterMs: null, headers: null, bodyText: null };
}
// Trip the breaker by feeding 3 consecutive 429s within 30s window.
function trip(guard, sub, family) {
    return __awaiter(this, void 0, void 0, function* () {
        for (let i = 0; i < 3; i++) {
            guard.observe(sub, family, ctx429());
        }
    });
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('RequestGuard', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        // Anchor wall-clock so Date.now() is deterministic.
        jest.setSystemTime(new Date('2026-05-07T00:00:00.000Z'));
    });
    afterEach(() => {
        jest.useRealTimers();
    });
    describe('closed circuit', () => {
        it('allows acquire+release without throwing when circuit is closed', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const release = yield guard.acquire(SUB_A, 'arm');
            expect(typeof release).toBe('function');
            // Releasing twice is a no-op.
            release();
            release();
        }));
        it('runs an executor through acquire/release end-to-end', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const executor = jest.fn().mockResolvedValue('payload');
            const release = yield guard.acquire(SUB_A, 'arm');
            const result = yield executor();
            release();
            guard.observe(SUB_A, 'arm', ctxOk());
            expect(result).toBe('payload');
            expect(executor).toHaveBeenCalledTimes(1);
        }));
        it('publishes a status snapshot on benign 5xx without changing state', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            const release = yield guard.acquire(SUB_A, 'arm');
            release();
            sink.entries.length = 0;
            guard.observe(SUB_A, 'arm', {
                status: 503,
                retryAfterMs: null,
                headers: null,
                bodyText: null,
            });
            // No transition fired; status snapshot was published.
            expect(sink.transitions).toHaveLength(0);
            expect(sink.entries.length).toBeGreaterThan(0);
            const last = sink.entries[sink.entries.length - 1];
            expect(last.entry.state).toBe('closed');
        }));
        it('treats a default-string subscriptionId as "default"', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const release = yield guard.acquire('', 'arm');
            release();
            // Two consecutive empty-id calls should hit the same internal bucket.
            const release2 = yield guard.acquire('', 'arm');
            release2();
        }));
    });
    describe('threshold opens circuit', () => {
        it('opens after 3 consecutive 429s within the 30s window', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            // Prime the breaker entry by acquiring once.
            const release = yield guard.acquire(SUB_A, 'arm');
            release();
            sink.transitions.length = 0;
            yield trip(guard, SUB_A, 'arm');
            const opens = sink.transitions.filter((t) => t.to === 'open');
            expect(opens.length).toBeGreaterThanOrEqual(1);
            expect(opens[opens.length - 1].from).toBe('closed');
            expect(opens[opens.length - 1].reason).toMatch(/3 consecutive 429s/i);
        }));
        it('does not open on a single 429', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            guard.observe(SUB_A, 'arm', ctx429());
            expect(sink.transitions.filter((t) => t.to === 'open')).toHaveLength(0);
            // A subsequent acquire should still succeed (circuit closed).
            const release = yield guard.acquire(SUB_A, 'arm');
            release();
        }));
        it('immediately opens with SUSPENSION_COOLDOWN on a suspension signal', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            const headers = new Headers({ 'x-ms-throttling-version': '1' });
            guard.observe(SUB_A, 'arm', {
                status: 429,
                retryAfterMs: null,
                headers,
                bodyText: null,
            });
            const opens = sink.transitions.filter((t) => t.to === 'open');
            expect(opens).toHaveLength(1);
            expect(opens[0].reason).toBe('suspension signal');
            expect(sink.criticals.length).toBe(1);
            expect(sink.criticals[0]).toMatch(/CRITICAL/);
            // Acquire should now fail.
            yield expect(guard.acquire(SUB_A, 'arm')).rejects.toThrow(/Circuit open/);
        }));
        it('treats a body matching SUSPENSION_RE as a suspension signal', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            guard.observe(SUB_A, 'arm', {
                status: 429,
                retryAfterMs: null,
                headers: null,
                bodyText: 'Subscription is being throttled, please retry later.',
            });
            expect(sink.criticals).toHaveLength(1);
            expect(sink.transitions.some((t) => t.to === 'open')).toBe(true);
        }));
    });
    describe('open circuit short-circuits requests', () => {
        it('throws "Circuit open" on acquire when state is open', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            yield trip(guard, SUB_A, 'arm');
            yield expect(guard.acquire(SUB_A, 'arm')).rejects.toThrow(/Circuit open/);
        }));
        it('does not consume a token while the circuit is open', () => __awaiter(void 0, void 0, void 0, function* () {
            // After 3x 429s, refillPerSec halves each time (10→5→2→1) and tokens=0.
            // We just verify acquire throws before any token math is needed.
            const guard = new RequestGuard();
            yield trip(guard, SUB_A, 'arm');
            const before = Date.now();
            yield expect(guard.acquire(SUB_A, 'arm')).rejects.toThrow(/Circuit open/);
            // Throw was synchronous (no setTimeout fired). Wall-clock unchanged.
            expect(Date.now()).toBe(before);
        }));
    });
    describe('half-open after cooldown', () => {
        it('transitions to half_open when cooldown elapses and acquire is attempted', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            yield trip(guard, SUB_A, 'arm');
            expect(sink.transitions[sink.transitions.length - 1].to).toBe('open');
            // Advance past the 60s cooldown.
            jest.setSystemTime(new Date('2026-05-07T00:01:01.000Z'));
            const release = yield guard.acquire(SUB_A, 'arm');
            const lastTo = sink.transitions[sink.transitions.length - 1].to;
            expect(lastTo).toBe('half_open');
            release();
        }));
        it('allows only ONE probe in half_open; second concurrent acquire throws', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            yield trip(guard, SUB_A, 'arm');
            jest.setSystemTime(new Date('2026-05-07T00:01:01.000Z'));
            const release = yield guard.acquire(SUB_A, 'arm');
            // Second concurrent acquire while probe is in flight rejects.
            yield expect(guard.acquire(SUB_A, 'arm')).rejects.toThrow(/half-open probe in progress/i);
            release();
        }));
        it('closes the circuit on a successful probe', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            yield trip(guard, SUB_A, 'arm');
            jest.setSystemTime(new Date('2026-05-07T00:01:01.000Z'));
            const release = yield guard.acquire(SUB_A, 'arm');
            // Probe succeeds.
            guard.observe(SUB_A, 'arm', ctxOk());
            release();
            const lastClose = [...sink.transitions]
                .reverse()
                .find((t) => t.to === 'closed');
            expect(lastClose).toBeDefined();
            expect(lastClose.from).toBe('half_open');
            expect(lastClose.reason).toBe('probe succeeded');
            // Subsequent acquire should not throw and should not be in half_open.
            const release2 = yield guard.acquire(SUB_A, 'arm');
            release2();
        }));
        it('re-opens with extended cooldown on a probe 429', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            yield trip(guard, SUB_A, 'arm');
            jest.setSystemTime(new Date('2026-05-07T00:01:01.000Z'));
            const release = yield guard.acquire(SUB_A, 'arm');
            // Probe fails with 429.
            guard.observe(SUB_A, 'arm', ctx429());
            release();
            const lastTransition = sink.transitions[sink.transitions.length - 1];
            expect(lastTransition.to).toBe('open');
            expect(lastTransition.from).toBe('half_open');
            expect(lastTransition.reason).toBe('half-open probe 429');
            // Still short-circuiting now.
            yield expect(guard.acquire(SUB_A, 'arm')).rejects.toThrow(/Circuit open/);
        }));
    });
    describe('per-(subscriptionId, family) isolation', () => {
        it('tripping (subA, arm) does not open (subB, arm)', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            yield trip(guard, SUB_A, 'arm');
            yield expect(guard.acquire(SUB_A, 'arm')).rejects.toThrow(/Circuit open/);
            // Different subscription should still be closed.
            const release = yield guard.acquire(SUB_B, 'arm');
            release();
        }));
        it('tripping (sub, arm) does not open (sub, graph)', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            yield trip(guard, SUB_A, 'arm');
            yield expect(guard.acquire(SUB_A, 'arm')).rejects.toThrow(/Circuit open/);
            // Different family on same subscription is independent.
            const release = yield guard.acquire(SUB_A, 'graph');
            release();
        }));
        it('tracks transitions with the correct subscriptionId and family', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            yield trip(guard, SUB_A, 'arm');
            yield trip(guard, SUB_B, 'graph');
            const armOpens = sink.transitions.filter((t) => t.subscriptionId === SUB_A && t.family === 'arm');
            const graphOpens = sink.transitions.filter((t) => t.subscriptionId === SUB_B && t.family === 'graph');
            expect(armOpens.length).toBeGreaterThanOrEqual(1);
            expect(graphOpens.length).toBeGreaterThanOrEqual(1);
            expect(armOpens.every((t) => t.family === 'arm')).toBe(true);
            expect(graphOpens.every((t) => t.subscriptionId === SUB_B)).toBe(true);
        }));
    });
    describe('telemetry surface', () => {
        it('logs every state transition with a from/to/reason', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            // closed → open
            yield trip(guard, SUB_A, 'arm');
            // open → half_open (via cooldown)
            jest.setSystemTime(new Date('2026-05-07T00:01:01.000Z'));
            const release = yield guard.acquire(SUB_A, 'arm');
            // half_open → closed (probe success)
            guard.observe(SUB_A, 'arm', ctxOk());
            release();
            const tos = sink.transitions.map((t) => t.to);
            expect(tos).toContain('open');
            expect(tos).toContain('half_open');
            expect(tos).toContain('closed');
            for (const t of sink.transitions) {
                expect(t.subscriptionId).toBe(SUB_A);
                expect(t.family).toBe('arm');
                expect(typeof t.timestamp).toBe('string');
                expect(t.reason.length).toBeGreaterThan(0);
                expect(t.from).not.toBe(t.to);
            }
        }));
        it('publishes a snapshot entry on every transition and on observe', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            const release = yield guard.acquire(SUB_A, 'arm');
            release();
            const before = sink.entries.length;
            guard.observe(SUB_A, 'arm', ctx429());
            expect(sink.entries.length).toBeGreaterThan(before);
            const last = sink.entries[sink.entries.length - 1];
            expect(last.subscriptionId).toBe(SUB_A);
            expect(last.family).toBe('arm');
            expect(last.entry.state).toBe('closed');
            // refillPerSec halves on 429 (10 → 5).
            expect(last.entry.refillPerSec).toBeLessThan(10);
        }));
        it('replays current bucket entries to a newly attached telemetry sink', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            // Create state without telemetry.
            const release = yield guard.acquire(SUB_A, 'arm');
            release();
            const sink = makeSink();
            guard.setTelemetry(sink);
            // setTelemetry should have re-published existing buckets to the new sink.
            const replayed = sink.entries.find((e) => e.subscriptionId === SUB_A && e.family === 'arm');
            expect(replayed).toBeDefined();
        }));
        it('detaches when telemetry is set to null', () => __awaiter(void 0, void 0, void 0, function* () {
            const guard = new RequestGuard();
            const sink = makeSink();
            guard.setTelemetry(sink);
            const release = yield guard.acquire(SUB_A, 'arm');
            release();
            const countBefore = sink.entries.length;
            guard.setTelemetry(null);
            guard.observe(SUB_A, 'arm', ctx429());
            // No new entries should appear on the detached sink.
            expect(sink.entries.length).toBe(countBefore);
        }));
    });
    describe('singleton accessor', () => {
        it('getSharedRequestGuard returns a stable RequestGuard instance', () => {
            const a = getSharedRequestGuard();
            const b = getSharedRequestGuard();
            expect(a).toBe(b);
            expect(a).toBeInstanceOf(RequestGuard);
        });
    });
});
//# sourceMappingURL=request-governance.test.js.map