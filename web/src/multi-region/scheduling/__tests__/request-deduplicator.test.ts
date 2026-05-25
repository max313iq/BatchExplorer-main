import { RequestDeduplicator } from '../request-deduplicator';

describe('RequestDeduplicator', () => {
  let dedup: RequestDeduplicator;

  beforeEach(() => {
    dedup = new RequestDeduplicator();
  });

  describe('deduplicate', () => {
    it('returns the same in-flight promise for the same key', async () => {
      let callCount = 0;
      let resolveFn: ((v: string) => void) | undefined;
      const fn = (): Promise<string> => {
        callCount++;
        return new Promise<string>((resolve) => {
          resolveFn = resolve;
        });
      };

      const p1 = dedup.deduplicate('key-a', fn);
      const p2 = dedup.deduplicate('key-a', fn);

      expect(p1).toBe(p2);
      expect(callCount).toBe(1);
      expect(dedup.isInflight('key-a')).toBe(true);
      expect(dedup.size).toBe(1);
      expect(dedup.pendingCount).toBe(1);

      resolveFn!('done');
      await expect(p1).resolves.toBe('done');
      await expect(p2).resolves.toBe('done');
    });

    it('starts independent promises for different keys', async () => {
      let countA = 0;
      let countB = 0;
      const fnA = (): Promise<string> => {
        countA++;
        return Promise.resolve('a');
      };
      const fnB = (): Promise<string> => {
        countB++;
        return Promise.resolve('b');
      };

      const pA = dedup.deduplicate('key-a', fnA);
      const pB = dedup.deduplicate('key-b', fnB);

      expect(pA).not.toBe(pB);
      expect(dedup.size).toBe(2);

      await expect(pA).resolves.toBe('a');
      await expect(pB).resolves.toBe('b');
      expect(countA).toBe(1);
      expect(countB).toBe(1);
    });

    it('frees the key for re-execution after the promise resolves', async () => {
      let callCount = 0;
      const fn = (): Promise<number> => {
        callCount++;
        return Promise.resolve(callCount);
      };

      const first = await dedup.deduplicate('key', fn);
      expect(first).toBe(1);
      expect(dedup.isInflight('key')).toBe(false);
      expect(dedup.size).toBe(0);

      const second = await dedup.deduplicate('key', fn);
      expect(second).toBe(2);
      expect(callCount).toBe(2);
    });

    it('frees the key for re-execution after the promise rejects', async () => {
      let callCount = 0;
      const fn = (): Promise<string> => {
        callCount++;
        return Promise.reject(new Error(`failure-${callCount}`));
      };

      await expect(dedup.deduplicate('key', fn)).rejects.toThrow('failure-1');
      expect(dedup.isInflight('key')).toBe(false);

      await expect(dedup.deduplicate('key', fn)).rejects.toThrow('failure-2');
      expect(callCount).toBe(2);
    });

    it('propagates errors to all callers waiting on the dedupd key', async () => {
      let rejectFn: ((e: Error) => void) | undefined;
      let callCount = 0;
      const fn = (): Promise<string> => {
        callCount++;
        return new Promise<string>((_, reject) => {
          rejectFn = reject;
        });
      };

      const p1 = dedup.deduplicate('key', fn);
      const p2 = dedup.deduplicate('key', fn);
      const p3 = dedup.deduplicate('key', fn);

      expect(callCount).toBe(1);
      const err = new Error('boom');
      rejectFn!(err);

      await expect(p1).rejects.toBe(err);
      await expect(p2).rejects.toBe(err);
      await expect(p3).rejects.toBe(err);
      expect(dedup.isInflight('key')).toBe(false);
    });

    it('returns the same resolved value to all dedupd callers', async () => {
      let resolveFn: ((v: number) => void) | undefined;
      const fn = (): Promise<number> => {
        return new Promise<number>((resolve) => {
          resolveFn = resolve;
        });
      };

      const p1 = dedup.deduplicate('shared', fn);
      const p2 = dedup.deduplicate('shared', fn);

      resolveFn!(42);
      const [v1, v2] = await Promise.all([p1, p2]);
      expect(v1).toBe(42);
      expect(v2).toBe(42);
    });

    it('handles synchronous throws in fn by rejecting and freeing the key', async () => {
      const fn = (): Promise<string> => {
        return Promise.reject(new Error('sync-style'));
      };

      await expect(dedup.deduplicate('k', fn)).rejects.toThrow('sync-style');
      expect(dedup.isInflight('k')).toBe(false);
      expect(dedup.size).toBe(0);
    });
  });

  describe('isInflight', () => {
    it('returns false for unknown keys', () => {
      expect(dedup.isInflight('nope')).toBe(false);
    });

    it('returns true while a request is in flight and false after settling', async () => {
      let resolveFn: ((v: string) => void) | undefined;
      const promise = dedup.deduplicate('k', () => {
        return new Promise<string>((resolve) => {
          resolveFn = resolve;
        });
      });

      expect(dedup.isInflight('k')).toBe(true);
      resolveFn!('ok');
      await promise;
      expect(dedup.isInflight('k')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all in-flight entries from the map without canceling promises', async () => {
      let resolveA: ((v: string) => void) | undefined;
      let resolveB: ((v: string) => void) | undefined;
      const pA = dedup.deduplicate(
        'a',
        () =>
          new Promise<string>((resolve) => {
            resolveA = resolve;
          }),
      );
      const pB = dedup.deduplicate(
        'b',
        () =>
          new Promise<string>((resolve) => {
            resolveB = resolve;
          }),
      );

      expect(dedup.size).toBe(2);
      dedup.clear();
      expect(dedup.size).toBe(0);
      expect(dedup.isInflight('a')).toBe(false);
      expect(dedup.isInflight('b')).toBe(false);

      // Underlying promises remain — clear does not cancel them.
      resolveA!('A');
      resolveB!('B');
      await expect(pA).resolves.toBe('A');
      await expect(pB).resolves.toBe('B');
    });

    it('after clear, a same-key call starts a fresh request even while the first is still pending', async () => {
      let firstCount = 0;
      let secondCount = 0;
      const first = dedup.deduplicate('k', () => {
        firstCount++;
        return new Promise<string>(() => {
          /* never settles */
        });
      });
      void first;

      expect(dedup.size).toBe(1);
      dedup.clear();
      expect(dedup.size).toBe(0);

      const second = dedup.deduplicate('k', () => {
        secondCount++;
        return Promise.resolve('fresh');
      });

      await expect(second).resolves.toBe('fresh');
      expect(firstCount).toBe(1);
      expect(secondCount).toBe(1);
    });
  });

  describe('size and pendingCount', () => {
    it('both reflect the number of in-flight entries', async () => {
      expect(dedup.size).toBe(0);
      expect(dedup.pendingCount).toBe(0);

      let resolveFn: ((v: string) => void) | undefined;
      const promise = dedup.deduplicate(
        'k',
        () =>
          new Promise<string>((resolve) => {
            resolveFn = resolve;
          }),
      );

      expect(dedup.size).toBe(1);
      expect(dedup.pendingCount).toBe(1);

      resolveFn!('done');
      await promise;

      expect(dedup.size).toBe(0);
      expect(dedup.pendingCount).toBe(0);
    });
  });
});
