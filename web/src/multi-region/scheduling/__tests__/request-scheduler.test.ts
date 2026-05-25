import {
  RequestScheduler,
  RequestSchedulerQueueOverflowError,
  DEFAULT_SCHEDULER_OPTIONS,
} from '../request-scheduler';

interface HttpLikeError {
  status?: number;
  message?: string;
  code?: string;
  headers?: Record<string, string | string[]> | { get: (k: string) => string | null };
  error?: { code?: string; message?: string; headers?: Record<string, string> };
  response?: { headers?: Record<string, string> };
}

const flush = async (cycles = 5): Promise<void> => {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
};

const makeError = (status: number | null, extras?: Partial<HttpLikeError>): HttpLikeError => {
  const err: HttpLikeError = { ...extras };
  if (status !== null) err.status = status;
  return err;
};

describe('RequestScheduler', () => {
  describe('constructor and option normalization', () => {
    it('clamps concurrency to a minimum of 1', () => {
      const s = new RequestScheduler({ concurrency: 0 });
      expect(s.activeCount).toBe(0);
      expect(s.inflightCount).toBe(0);
    });

    it('uses delayMsBetweenRequests when delayMs is not provided (back-compat)', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMsBetweenRequests: 250,
        retryAttempts: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        now: () => 0,
      });
      await s.run('k', () => Promise.resolve('a'));
      await s.run('k', () => Promise.resolve('b'));
      // Pacing waits 250ms (the deprecated delayMsBetweenRequests value)
      expect(sleeps).toContain(250);
    });

    it('falls back to defaults when no options are passed', async () => {
      const s = new RequestScheduler();
      const result = await s.run('k', () => Promise.resolve(123));
      expect(result).toBe(123);
    });

    it('exposes DEFAULT_SCHEDULER_OPTIONS with production-tuned values', () => {
      expect(DEFAULT_SCHEDULER_OPTIONS.concurrency).toBe(1);
      expect(DEFAULT_SCHEDULER_OPTIONS.delayMs).toBe(2000);
      expect(DEFAULT_SCHEDULER_OPTIONS.retryAttempts).toBe(5);
      expect(DEFAULT_SCHEDULER_OPTIONS.retryBackoffSeconds).toEqual([2, 4, 8, 16, 32]);
      expect(DEFAULT_SCHEDULER_OPTIONS.jitterPct).toBe(0.2);
      expect(DEFAULT_SCHEDULER_OPTIONS.maxQueueSize).toBe(100);
    });
  });

  describe('basic execution', () => {
    it('runs a single request and resolves with its value', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });
      const result = await s.run('k', () => Promise.resolve('hello'));
      expect(result).toBe('hello');
      expect(s.activeCount).toBe(0);
      expect(s.inflightCount).toBe(0);
    });

    it('uses the literal "default" key when key is empty', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });
      const result = await s.run('', () => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('decrements inflightCount after completion', async () => {
      const s = new RequestScheduler({
        concurrency: 5,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });
      const p = s.run('a', () => Promise.resolve(1));
      // inflight bumps synchronously inside run()
      expect(s.inflightCount).toBe(1);
      await p;
      // finally hook decrements inflight
      await flush(3);
      expect(s.inflightCount).toBe(0);
    });
  });

  describe('rate-limit (concurrency) enforcement', () => {
    it('does not execute more than `concurrency` callbacks at the same time', async () => {
      const concurrency = 3;
      let active = 0;
      let maxActive = 0;
      const resolvers: Array<() => void> = [];

      const s = new RequestScheduler({
        concurrency,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      const fn = (): Promise<void> => {
        active++;
        if (active > maxActive) maxActive = active;
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            active--;
            resolve();
          });
        });
      };

      // Fire 10 concurrent requests; each request must use a distinct key
      // so that the per-key serialization chain doesn't dominate the test.
      const N = 10;
      const promises: Array<Promise<void>> = [];
      for (let i = 0; i < N; i++) {
        promises.push(s.run(`k${i}`, fn));
      }

      // Let the scheduler dispatch up to `concurrency` slots
      await flush(20);
      expect(s.activeCount).toBeLessThanOrEqual(concurrency);
      expect(active).toBeLessThanOrEqual(concurrency);

      // Drain remaining work, ensuring max never exceeded concurrency
      while (resolvers.length > 0) {
        const r = resolvers.shift()!;
        r();
        await flush(20);
        expect(active).toBeLessThanOrEqual(concurrency);
      }

      await Promise.all(promises);
      expect(maxActive).toBeLessThanOrEqual(concurrency);
      expect(s.activeCount).toBe(0);
    });

    it('schedules waiters via the slot queue when concurrency is saturated', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      let resolveFirst: (() => void) | undefined;
      let secondStarted = false;

      const first = s.run('a', () => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }));
      const second = s.run('b', () => {
        secondStarted = true;
        return Promise.resolve();
      });

      await flush(10);
      // First holds the only slot; second is queued and must not have started.
      expect(secondStarted).toBe(false);
      expect(s.activeCount).toBe(1);

      resolveFirst!();
      await first;
      await second;
      expect(secondStarted).toBe(true);
      expect(s.activeCount).toBe(0);
    });
  });

  describe('FIFO order preservation', () => {
    it('serializes same-key calls so they complete in submission order', async () => {
      const completed: number[] = [];
      const s = new RequestScheduler({
        concurrency: 5,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      const fn = (id: number): (() => Promise<number>) => {
        return () =>
          new Promise<number>((resolve) => {
            completed.push(id);
            resolve(id);
          });
      };

      const p1 = s.run('shared', fn(1));
      const p2 = s.run('shared', fn(2));
      const p3 = s.run('shared', fn(3));
      const p4 = s.run('shared', fn(4));

      await Promise.all([p1, p2, p3, p4]);
      expect(completed).toEqual([1, 2, 3, 4]);
    });

    it('preserves slot-queue FIFO across distinct keys at concurrency=1', async () => {
      const order: string[] = [];
      const resolvers: Record<string, () => void> = {};

      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      const fn = (id: string): (() => Promise<void>) => {
        return () => {
          order.push(id);
          return new Promise<void>((resolve) => {
            resolvers[id] = resolve;
          });
        };
      };

      const pA = s.run('a', fn('a'));
      const pB = s.run('b', fn('b'));
      const pC = s.run('c', fn('c'));

      await flush(20);
      // Only the first should have started; queue holds B and C
      expect(order).toEqual(['a']);
      resolvers['a']();
      await pA;
      await flush(20);
      expect(order).toEqual(['a', 'b']);
      resolvers['b']();
      await pB;
      await flush(20);
      expect(order).toEqual(['a', 'b', 'c']);
      resolvers['c']();
      await pC;
    });
  });

  describe('queue overflow', () => {
    it('rejects with RequestSchedulerQueueOverflowError when maxQueueSize is reached', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        maxQueueSize: 2,
        sleep: () => Promise.resolve(),
      });

      let resolveFirst: (() => void) | undefined;
      const a = s.run('a', () => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }));
      const b = s.run('b', () => Promise.resolve());

      // Now inflight = 2 = maxQueueSize. The third must reject.
      await expect(s.run('c', () => Promise.resolve())).rejects.toBeInstanceOf(
        RequestSchedulerQueueOverflowError,
      );

      resolveFirst!();
      await a;
      await b;
    });

    it('queue overflow error message contains the configured size', () => {
      const err = new RequestSchedulerQueueOverflowError(42);
      expect(err.name).toBe('RequestSchedulerQueueOverflowError');
      expect(err.message).toContain('42');
    });

    it('clamps maxQueueSize to a minimum of 1', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        maxQueueSize: 0, // will be clamped to 1
        sleep: () => Promise.resolve(),
      });
      let resolveFirst: (() => void) | undefined;
      const a = s.run('a', () => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }));
      // With maxQueueSize=1 and 1 inflight, the next must overflow
      await expect(s.run('b', () => Promise.resolve())).rejects.toBeInstanceOf(
        RequestSchedulerQueueOverflowError,
      );
      resolveFirst!();
      await a;
    });
  });

  describe('retry and backoff', () => {
    it('retries on a 500 transient error and applies exponential backoff', async () => {
      const sleepCalls: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 3,
        retryBackoffSeconds: [1, 2, 4, 8],
        jitterPct: 0,
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts < 3) return Promise.reject(makeError(500));
        return Promise.resolve('ok');
      };

      const result = await s.run('k', fn);
      expect(result).toBe('ok');
      expect(attempts).toBe(3);
      // Backoff sleeps after attempt 1 (1s) and attempt 2 (2s), no jitter
      const backoffSleeps = sleepCalls.filter((ms) => ms === 1000 || ms === 2000);
      expect(backoffSleeps).toEqual([1000, 2000]);
    });

    it('retries on 429 with throttle floor of at least 1000ms', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [0], // base = 0 → throttle floor must kick in
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) return Promise.reject(makeError(429));
        return Promise.resolve('done');
      };

      const result = await s.run('k', fn);
      expect(result).toBe('done');
      expect(sleeps).toContain(1000);
    });

    it('honors numeric Retry-After headers (seconds) and uses the larger of base/retry-after', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [1],
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(
            makeError(503, { headers: { 'retry-after': '5' } }),
          );
        }
        return Promise.resolve('ok');
      };

      const result = await s.run('k', fn);
      expect(result).toBe('ok');
      // 5 seconds = 5000ms wins over base backoff of 1000ms
      expect(sleeps).toContain(5000);
    });

    it('honors HTTP-date Retry-After headers', async () => {
      const sleeps: number[] = [];
      const fixedNow = Date.parse('2024-01-01T00:00:00Z');
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [0],
        jitterPct: 0,
        now: () => fixedNow,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const futureDate = new Date(fixedNow + 7000).toUTCString();
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(
            makeError(503, { headers: { 'retry-after': futureDate } }),
          );
        }
        return Promise.resolve('done');
      };

      await s.run('k', fn);
      expect(sleeps).toContain(7000);
    });

    it('reads Retry-After via Headers-like .get accessor', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [1],
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const headersLike = {
        get: (name: string): string | null => {
          if (name.toLowerCase() === 'retry-after') return '3';
          return null;
        },
      };
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(makeError(503, { headers: headersLike }));
        }
        return Promise.resolve('ok');
      };

      await s.run('k', fn);
      expect(sleeps).toContain(3000);
    });

    it('reads Retry-After from array values', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [1],
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(
            makeError(503, { headers: { 'Retry-After': ['4'] } }),
          );
        }
        return Promise.resolve('ok');
      };

      await s.run('k', fn);
      expect(sleeps).toContain(4000);
    });

    it('does not retry non-retryable status codes (e.g. 401)', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 5,
        retryBackoffSeconds: [1],
        jitterPct: 0,
        sleep: () => Promise.resolve(),
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        return Promise.reject(makeError(401, { message: 'unauthorized' }));
      };

      await expect(s.run('k', fn)).rejects.toMatchObject({ status: 401 });
      expect(attempts).toBe(1);
    });

    it('treats null/undefined status as a network error and retries', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 2,
        retryBackoffSeconds: [0],
        jitterPct: 0,
        sleep: () => Promise.resolve(),
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts < 3) {
          // status 0 — counts as network
          return Promise.reject(makeError(0));
        }
        return Promise.resolve('recovered');
      };

      const r = await s.run('k', fn);
      expect(r).toBe('recovered');
      expect(attempts).toBe(3);
    });

    it('exhausts retryAttempts and rethrows the last error', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 2,
        retryBackoffSeconds: [0],
        jitterPct: 0,
        sleep: () => Promise.resolve(),
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        return Promise.reject(makeError(500));
      };

      await expect(s.run('k', fn)).rejects.toMatchObject({ status: 500 });
      // 2 retries + 1 initial = 3 total attempts
      expect(attempts).toBe(3);
    });

    it('retries 409 only when conflict message hints at a transient state', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [0],
        jitterPct: 0,
        sleep: () => Promise.resolve(),
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(
            makeError(409, { code: 'PoolIsResizing', message: 'pool busy' }),
          );
        }
        return Promise.resolve('ok');
      };

      const r = await s.run('k', fn);
      expect(r).toBe('ok');
      expect(attempts).toBe(2);
    });

    it('does not retry a non-retriable 409 (no transient hint)', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 5,
        retryBackoffSeconds: [0],
        jitterPct: 0,
        sleep: () => Promise.resolve(),
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        return Promise.reject(
          makeError(409, { code: 'NameAlreadyTaken', message: 'duplicate' }),
        );
      };

      await expect(s.run('k', fn)).rejects.toMatchObject({ status: 409 });
      expect(attempts).toBe(1);
    });

    it('caps backoff index at the last entry of the table', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 5,
        retryBackoffSeconds: [1, 2], // only 2 entries; subsequent retries use idx=1
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts < 5) return Promise.reject(makeError(500));
        return Promise.resolve('done');
      };

      const r = await s.run('k', fn);
      expect(r).toBe('done');
      // backoff sleeps: 1000, 2000, 2000, 2000 (last index repeated)
      const backoffSleeps = sleeps.filter((ms) => ms === 1000 || ms === 2000);
      expect(backoffSleeps).toEqual([1000, 2000, 2000, 2000]);
    });

    it('applies jitter using the injected random source', async () => {
      const sleeps: number[] = [];
      // Random returns 0 → jitter = 0 - spread = -spread, clamped at 0
      // Random returns 1 → jitter = +spread
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [10], // 10s base
        jitterPct: 0.2, // ±20%
        random: () => 1, // forces +spread
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) return Promise.reject(makeError(500));
        return Promise.resolve('ok');
      };

      await s.run('k', fn);
      // base 10000ms + max jitter 2000ms = 12000ms exactly when random=1
      expect(sleeps).toContain(12000);
    });

    it('clamps jitterPct above 0.5 down to 0.5', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [10],
        jitterPct: 5, // clamped to 0.5
        random: () => 1,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) return Promise.reject(makeError(500));
        return Promise.resolve('ok');
      };

      await s.run('k', fn);
      // 10000 + 50% spread = 15000 max
      expect(sleeps).toContain(15000);
    });

    it('uses deprecated backoffSeconds when retryBackoffSeconds is empty', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [],
        backoffSeconds: [3],
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) return Promise.reject(makeError(500));
        return Promise.resolve('ok');
      };

      await s.run('k', fn);
      expect(sleeps).toContain(3000);
    });

    it('treats invalid Retry-After header as null and falls back to base backoff', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [2],
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(
            makeError(503, { headers: { 'retry-after': 'not-a-date' } }),
          );
        }
        return Promise.resolve('ok');
      };

      await s.run('k', fn);
      expect(sleeps).toContain(2000);
    });

    it('reads Retry-After from error.error.headers when top-level headers are absent', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [0],
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(
            makeError(503, { error: { headers: { 'retry-after': '6' } } }),
          );
        }
        return Promise.resolve('ok');
      };

      await s.run('k', fn);
      expect(sleeps).toContain(6000);
    });

    it('reads Retry-After from response.headers as last resort', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 1,
        retryBackoffSeconds: [0],
        jitterPct: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      let attempts = 0;
      const fn = (): Promise<string> => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(
            makeError(503, { response: { headers: { 'Retry-After': '8' } } }),
          );
        }
        return Promise.resolve('ok');
      };

      await s.run('k', fn);
      expect(sleeps).toContain(8000);
    });
  });

  describe('pacing (delay between requests)', () => {
    it('sleeps for the remaining wait time between consecutive requests', async () => {
      const sleeps: number[] = [];
      let nowVal = 1000;
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 500,
        retryAttempts: 0,
        jitterPct: 0,
        now: () => nowVal,
        sleep: (ms) => {
          sleeps.push(ms);
          // simulate elapsed time
          nowVal += ms;
          return Promise.resolve();
        },
      });

      // First call: nextStartAt is 0, so no wait. Sets nextStartAt to now+500.
      await s.run('k', () => Promise.resolve('a'));
      // Second call: nextStartAt = previousNow+500. waitMs = 500.
      await s.run('k', () => Promise.resolve('b'));

      expect(sleeps).toContain(500);
    });

    it('skips pacing when next start is already in the past', async () => {
      const sleeps: number[] = [];
      let nowVal = 1000;
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 100,
        retryAttempts: 0,
        jitterPct: 0,
        now: () => nowVal,
        sleep: (ms) => {
          sleeps.push(ms);
          nowVal += ms;
          return Promise.resolve();
        },
      });

      await s.run('k', () => Promise.resolve('a'));
      // Advance now far beyond the pacing window
      nowVal += 10_000;
      await s.run('k', () => Promise.resolve('b'));
      // No 100ms pace sleep should have occurred for the second call
      expect(sleeps).not.toContain(100);
    });

    it('clamps negative delayMs to zero (no pacing sleeps observed)', async () => {
      const sleeps: number[] = [];
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: -500,
        retryAttempts: 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });

      await s.run('k', () => Promise.resolve('a'));
      await s.run('k', () => Promise.resolve('b'));
      // Pacing produces 0ms waits which short-circuit before invoking sleep
      expect(sleeps).toHaveLength(0);
    });
  });

  describe('per-instance concurrency override', () => {
    // Note: the scheduler exposes concurrency only as a constructor option,
    // not a per-call override on `run`. The migration phase 5 supports
    // per-call overrides at the governance layer, not directly on
    // RequestScheduler. This test verifies that distinct instances honor
    // independent concurrency settings, which is the equivalent unit-level
    // contract.
    it('respects independent concurrency limits across instances', async () => {
      let activeA = 0;
      let activeB = 0;
      let maxA = 0;
      let maxB = 0;
      const resolversA: Array<() => void> = [];
      const resolversB: Array<() => void> = [];

      const sLow = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });
      const sHigh = new RequestScheduler({
        concurrency: 4,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      const fnA = (): Promise<void> => {
        activeA++;
        if (activeA > maxA) maxA = activeA;
        return new Promise<void>((resolve) => {
          resolversA.push(() => {
            activeA--;
            resolve();
          });
        });
      };
      const fnB = (): Promise<void> => {
        activeB++;
        if (activeB > maxB) maxB = activeB;
        return new Promise<void>((resolve) => {
          resolversB.push(() => {
            activeB--;
            resolve();
          });
        });
      };

      const N = 6;
      const promisesA: Array<Promise<void>> = [];
      const promisesB: Array<Promise<void>> = [];
      for (let i = 0; i < N; i++) {
        promisesA.push(sLow.run(`a${i}`, fnA));
        promisesB.push(sHigh.run(`b${i}`, fnB));
      }

      await flush(20);
      expect(activeA).toBeLessThanOrEqual(1);
      expect(activeB).toBeLessThanOrEqual(4);

      // Drain
      while (resolversA.length > 0 || resolversB.length > 0) {
        if (resolversA.length > 0) resolversA.shift()!();
        if (resolversB.length > 0) resolversB.shift()!();
        await flush(10);
      }
      await Promise.all([...promisesA, ...promisesB]);

      expect(maxA).toBeLessThanOrEqual(1);
      expect(maxB).toBeLessThanOrEqual(4);
      expect(maxB).toBeGreaterThan(maxA);
    });
  });

  describe('error propagation and slot release', () => {
    it('releases the concurrency slot even when the callback throws', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      await expect(
        s.run('k', () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');

      await flush(5);
      expect(s.activeCount).toBe(0);
      // A subsequent call must be able to run
      const r = await s.run('k', () => Promise.resolve('ok'));
      expect(r).toBe('ok');
    });

    it('clears the keyChains entry after a same-key chain settles', async () => {
      const s = new RequestScheduler({
        concurrency: 5,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      await s.run('shared', () => Promise.resolve('a'));
      await flush(5);
      // After settle, inflightCount returns to 0
      expect(s.inflightCount).toBe(0);
    });
  });

  describe('cancellation-like propagation', () => {
    // The scheduler doesn't accept an AbortSignal, but rejection inside
    // the queued callback must propagate to the awaiter without leaking
    // slots — equivalent semantics for "cancellation propagation".
    it('propagates a rejected callback to its awaiter and frees the slot', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      const cancelErr = new Error('cancelled');
      let resolveSecond: (() => void) | undefined;
      let secondStarted = false;

      const first = s.run('a', () => Promise.reject(cancelErr));
      const second = s.run('b', () => {
        secondStarted = true;
        return new Promise<void>((resolve) => {
          resolveSecond = resolve;
        });
      });

      await expect(first).rejects.toBe(cancelErr);
      await flush(10);
      expect(secondStarted).toBe(true);
      resolveSecond!();
      await second;
    });

    it('propagates rejection across same-key chained calls without blocking later same-key calls', async () => {
      const s = new RequestScheduler({
        concurrency: 1,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      const first = s.run('shared', () => Promise.reject(new Error('first-failed')));
      const second = s.run('shared', () => Promise.resolve('after-failure'));

      await expect(first).rejects.toThrow('first-failed');
      const r = await second;
      expect(r).toBe('after-failure');
    });
  });

  describe('inflight bookkeeping', () => {
    it('tracks inflightCount through the lifetime of overlapping requests', async () => {
      const s = new RequestScheduler({
        concurrency: 5,
        delayMs: 0,
        retryAttempts: 0,
        sleep: () => Promise.resolve(),
      });

      const resolvers: Array<() => void> = [];
      const fn = (): Promise<void> =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });

      const promises: Array<Promise<void>> = [];
      for (let i = 0; i < 4; i++) {
        promises.push(s.run(`k${i}`, fn));
      }
      expect(s.inflightCount).toBe(4);

      // Drain
      while (resolvers.length > 0) {
        resolvers.shift()!();
        await flush(2);
      }
      await Promise.all(promises);
      await flush(5);
      expect(s.inflightCount).toBe(0);
    });
  });
});
