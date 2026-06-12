import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { abortJob, registerJob, unregisterJob } from '@/server/archive/jobControllers';

/**
 * The controller registry is module-level state shared across the whole
 * process — each test uses a unique jobId so registrations never collide.
 */
describe('jobControllers registry', () => {
  it('aborts a registered controller and returns true', () => {
    const id = randomUUID();
    const ctrl = new AbortController();
    registerJob(id, ctrl);
    expect(abortJob(id)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('returns false for an unknown jobId without throwing', () => {
    const id = randomUUID();
    expect(() => abortJob(id)).not.toThrow();
    expect(abortJob(id)).toBe(false);
  });

  it('unregisterJob removes the entry so later abortJob is a no-op', () => {
    const id = randomUUID();
    const ctrl = new AbortController();
    registerJob(id, ctrl);
    unregisterJob(id);
    expect(abortJob(id)).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('allows re-registering the same jobId after unregister', () => {
    const id = randomUUID();
    const first = new AbortController();
    registerJob(id, first);
    unregisterJob(id);

    const second = new AbortController();
    registerJob(id, second);
    expect(abortJob(id)).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });

  it('registerJob replaces an existing controller for the same id', () => {
    const id = randomUUID();
    const first = new AbortController();
    const second = new AbortController();
    registerJob(id, first);
    registerJob(id, second);
    expect(abortJob(id)).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });

  it('tracks multiple concurrent jobs independently', () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    registerJob(idA, ctrlA);
    registerJob(idB, ctrlB);

    expect(abortJob(idA)).toBe(true);
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);

    expect(abortJob(idB)).toBe(true);
    expect(ctrlB.signal.aborted).toBe(true);
  });

  it('abortJob on an already-aborted controller is idempotent', () => {
    const id = randomUUID();
    const ctrl = new AbortController();
    ctrl.abort();
    registerJob(id, ctrl);
    expect(() => abortJob(id)).not.toThrow();
    expect(abortJob(id)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('unregisterJob is safe to call for an unknown id', () => {
    expect(() => unregisterJob(randomUUID())).not.toThrow();
  });
});
