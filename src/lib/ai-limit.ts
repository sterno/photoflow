// Process-wide concurrency gate for outbound Claude API calls.
//
// Bound concurrent Claude calls so a burst of uploads doesn't fan out N
// simultaneous AI requests and trip the Haiku rate limit. Lives in module
// scope so it's shared across all upload requests handled by the same
// Node process. Note: not cross-process — a multi-replica deployment would
// need a shared coordinator (Redis, etc.) to enforce a global cap.

const MAX_CONCURRENT = 3;
let inflight = 0;
// FIFO queue of runners waiting for a slot. Each runner resolves/rejects the
// outer promise the caller is awaiting.
const queue: Array<() => void> = [];

/**
 * Run `work` under the AI concurrency cap. Resolves/rejects with whatever
 * `work()` returns; on completion the next queued caller is woken up.
 * Use to wrap any call into the Claude API from the upload pipeline.
 */
export function withAiSlot<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      inflight++;
      try {
        resolve(await work());
      } catch (err) {
        reject(err);
      } finally {
        inflight--;
        // Hand the just-freed slot to the next waiter, if any.
        const nextWaiter = queue.shift();
        if (nextWaiter) nextWaiter();
      }
    };
    if (inflight < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}
