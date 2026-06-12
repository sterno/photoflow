import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the process-wide AI concurrency limiter.
 *
 * `withAiSlot` caps in-flight AI calls at MAX_CONCURRENT (3) using
 * module-level `inflight` and `queue` state. There is no public reset
 * hook, so each test re-imports the module via `vi.resetModules()` +
 * dynamic `import()` to get a fresh limiter with a clean queue and
 * inflight=0. Timing is controlled with manual deferred promises rather
 * than real timers, so each test can deterministically hold a slot,
 * observe queueing, and then release.
 *
 * The contract under test:
 *   - up to 3 callbacks run concurrently
 *   - additional callers queue FIFO and start when a slot frees
 *   - resolved / rejected results are forwarded to the caller
 *   - slots are released on both fulfillment and rejection, including
 *     synchronous throws inside the callback
 */

type WithAiSlot = <T>(work: () => Promise<T>) => Promise<T>;

async function loadFresh(): Promise<{ withAiSlot: WithAiSlot }> {
  vi.resetModules();
  return import('@/lib/ai-limit');
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush pending microtasks so any then-callbacks queued by `withAiSlot`
// (the inner `run` IIFE bumping `inflight`, the post-`await` slot release,
// or the next-in-queue dispatch) have a chance to settle before we assert.
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// Tracks whether a promise has settled without awaiting it (which would
// deadlock when the answer is "no, it's still pending").
function track<T>(p: Promise<T>): {
  settled: () => boolean;
  value: () => T | undefined;
  error: () => unknown;
} {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      error = e;
    },
  );
  return {
    settled: () => done,
    value: () => value,
    error: () => error,
  };
}

describe('withAiSlot', () => {
  let withAiSlot: WithAiSlot;

  beforeEach(async () => {
    ({ withAiSlot } = await loadFresh());
  });

  describe('under the cap', () => {
    it('runs a single callback immediately and forwards its resolution', async () => {
      let started = false;
      const result = await withAiSlot(async () => {
        started = true;
        return 'ok';
      });
      expect(started).toBe(true);
      expect(result).toBe('ok');
    });

    it('runs up to 3 callbacks concurrently without queueing', async () => {
      const d1 = deferred<string>();
      const d2 = deferred<string>();
      const d3 = deferred<string>();

      const started = [false, false, false];
      const p1 = withAiSlot(async () => {
        started[0] = true;
        return d1.promise;
      });
      const p2 = withAiSlot(async () => {
        started[1] = true;
        return d2.promise;
      });
      const p3 = withAiSlot(async () => {
        started[2] = true;
        return d3.promise;
      });

      await flushMicrotasks();

      // All three started immediately — none queued.
      expect(started).toEqual([true, true, true]);

      d1.resolve('a');
      d2.resolve('b');
      d3.resolve('c');

      await expect(p1).resolves.toBe('a');
      await expect(p2).resolves.toBe('b');
      await expect(p3).resolves.toBe('c');
    });
  });

  describe('over the cap', () => {
    it('queues the 4th caller until one of the first three resolves', async () => {
      const held = [deferred<string>(), deferred<string>(), deferred<string>()];
      let fourthStarted = false;

      const p1 = withAiSlot(() => held[0].promise);
      const p2 = withAiSlot(() => held[1].promise);
      const p3 = withAiSlot(() => held[2].promise);
      const p4 = withAiSlot(async () => {
        fourthStarted = true;
        return 'fourth';
      });

      await flushMicrotasks();
      // Three slots are full; the 4th must be waiting.
      expect(fourthStarted).toBe(false);

      // Release one — the queued caller should now acquire the freed slot.
      held[0].resolve('first');
      await expect(p1).resolves.toBe('first');
      await flushMicrotasks();
      expect(fourthStarted).toBe(true);

      await expect(p4).resolves.toBe('fourth');

      // Cleanup so dangling held promises don't linger.
      held[1].resolve('b');
      held[2].resolve('c');
      await Promise.all([p2, p3]);
    });

    it('dispatches queued callers in FIFO order as slots free', async () => {
      const held = [deferred<void>(), deferred<void>(), deferred<void>()];
      const startOrder: number[] = [];

      // Fill the three slots.
      const p1 = withAiSlot(() => held[0].promise);
      const p2 = withAiSlot(() => held[1].promise);
      const p3 = withAiSlot(() => held[2].promise);

      // Queue four more callers, tagging the order in which they actually start.
      const queuedDeferreds = [
        deferred<void>(),
        deferred<void>(),
        deferred<void>(),
        deferred<void>(),
      ];
      const queued = queuedDeferreds.map((d, idx) =>
        withAiSlot(async () => {
          startOrder.push(idx);
          await d.promise;
        }),
      );

      await flushMicrotasks();
      expect(startOrder).toEqual([]);

      // Release the three held slots one at a time. Each release should
      // let exactly one queued caller start, in the order they enqueued.
      held[0].resolve();
      await p1;
      await flushMicrotasks();
      expect(startOrder).toEqual([0]);

      held[1].resolve();
      await p2;
      await flushMicrotasks();
      expect(startOrder).toEqual([0, 1]);

      held[2].resolve();
      await p3;
      await flushMicrotasks();
      expect(startOrder).toEqual([0, 1, 2]);

      // The 4th queued caller had to wait for one of the queued runners
      // to finish — release the first queued one to give it a slot.
      queuedDeferreds[0].resolve();
      await queued[0];
      await flushMicrotasks();
      expect(startOrder).toEqual([0, 1, 2, 3]);

      queuedDeferreds[1].resolve();
      queuedDeferreds[2].resolve();
      queuedDeferreds[3].resolve();
      await Promise.all(queued);
    });
  });

  describe('slot release', () => {
    it('releases the slot when the callback rejects, letting a queued caller run', async () => {
      const held = [deferred<void>(), deferred<void>(), deferred<void>()];

      const p1 = withAiSlot(() => held[0].promise);
      const p2 = withAiSlot(() => held[1].promise);
      const p3 = withAiSlot(() => held[2].promise);

      let fourthStarted = false;
      const p4 = withAiSlot(async () => {
        fourthStarted = true;
        return 'after-rejection';
      });

      await flushMicrotasks();
      expect(fourthStarted).toBe(false);

      const boom = new Error('boom');
      held[0].reject(boom);

      await expect(p1).rejects.toBe(boom);
      await flushMicrotasks();
      expect(fourthStarted).toBe(true);
      await expect(p4).resolves.toBe('after-rejection');

      held[1].resolve();
      held[2].resolve();
      await Promise.all([p2, p3]);
    });

    it('releases the slot when the callback throws synchronously', async () => {
      const held = [deferred<void>(), deferred<void>()];

      // Two slots held, then a synchronously-throwing callback takes the
      // third slot. The throw must release that slot so a queued caller
      // can run before either held slot frees.
      const p1 = withAiSlot(() => held[0].promise);
      const p2 = withAiSlot(() => held[1].promise);

      const boom = new Error('sync-boom');
      // The callback type expects `Promise<T>` but `withAiSlot` wraps the
      // call in an `async` IIFE, so a synchronous throw still surfaces as
      // a rejection via the try/catch around `await work()`.
      const pThrower = withAiSlot<string>((() => {
        throw boom;
      }) as () => Promise<string>);

      let nextStarted = false;
      const pNext = withAiSlot(async () => {
        nextStarted = true;
        return 'next';
      });

      await expect(pThrower).rejects.toBe(boom);
      await flushMicrotasks();
      expect(nextStarted).toBe(true);
      await expect(pNext).resolves.toBe('next');

      held[0].resolve();
      held[1].resolve();
      await Promise.all([p1, p2]);
    });

    it('does not leak slots across many sequential rejections', async () => {
      // If the limiter forgot to decrement `inflight` on rejection, after
      // 3 rejected calls the limiter would be wedged and a 4th call would
      // never start. Run a long sequence and assert each call still resolves.
      for (let i = 0; i < 10; i++) {
        await expect(
          withAiSlot(async () => {
            throw new Error(`iter-${i}`);
          }),
        ).rejects.toThrow(`iter-${i}`);
      }

      // After all those rejections, normal calls must still work.
      await expect(withAiSlot(async () => 'still-alive')).resolves.toBe(
        'still-alive',
      );
    });
  });

  describe('result forwarding', () => {
    it('forwards the callback return value to the caller', async () => {
      await expect(withAiSlot(async () => 42)).resolves.toBe(42);
      await expect(
        withAiSlot(async () => ({ shape: 'object' })),
      ).resolves.toEqual({ shape: 'object' });
    });

    it('forwards the callback error to the caller unchanged', async () => {
      const err = new Error('forwarded');
      await expect(
        withAiSlot(async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    });
  });

  describe('cap = 3 specifically', () => {
    it('starts the 3rd caller but holds the 4th', async () => {
      const held = [
        deferred<void>(),
        deferred<void>(),
        deferred<void>(),
        deferred<void>(),
      ];
      const trackers = held.map((d, i) =>
        track(
          withAiSlot(async () => {
            await d.promise;
            return i;
          }),
        ),
      );

      // Let each `withAiSlot` advance through its initial microtask chain
      // (acquire slot, kick off `work()`).
      await flushMicrotasks();

      // The first three should be running (their underlying work promise
      // is still pending, so the outer promise is unsettled — but it's
      // not waiting in the queue). The 4th is queued, also unsettled, but
      // for a different reason. We can distinguish by resolving the 3rd
      // held promise and confirming p3 settles while p4 stays pending.
      expect(trackers[3].settled()).toBe(false);

      held[2].resolve();
      await flushMicrotasks();
      expect(trackers[2].settled()).toBe(true);
      // The 4th now has a slot and is running, but its `held[3]` is still
      // unresolved, so it remains unsettled.
      expect(trackers[3].settled()).toBe(false);

      held[3].resolve();
      await flushMicrotasks();
      expect(trackers[3].settled()).toBe(true);
      expect(trackers[3].value()).toBe(3);

      held[0].resolve();
      held[1].resolve();
      await flushMicrotasks();
    });
  });
});
