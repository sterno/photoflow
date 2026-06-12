/**
 * In-process registry that maps archive job IDs to their AbortController so
 * the cancel API can signal the running worker. The bridge from "user
 * clicks cancel" (HTTP request) to "worker stops" (async iterator).
 */
import 'server-only';

/**
 * Per-process registry of AbortControllers for in-flight archive jobs.
 * Used by the cancel API route to signal the worker to stop. Single-instance
 * only (Railway today); if we ever scale horizontally, add a DB-poll
 * fallback so a cancel write on instance A reaches a worker on instance B.
 */
const controllers = new Map<string, AbortController>();

export function registerJob(jobId: string, controller: AbortController): void {
  controllers.set(jobId, controller);
}

export function unregisterJob(jobId: string): void {
  controllers.delete(jobId);
}

/** Signal cancel to the worker. Returns false if no live worker is registered. */
export function abortJob(jobId: string): boolean {
  const controller = controllers.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}
