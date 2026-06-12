/**
 * Next.js instrumentation hook — runs once per server-process startup.
 * Used here only to clean up archive jobs orphaned by a crash or redeploy
 * mid-run. We're on Railway (long-lived Node); if we ever move to serverless
 * this hook fires per cold start which is still fine, but the orphan-detection
 * window may need tightening.
 */
export async function register() {
  // Only run in Node runtime (skip Edge / build-time invocations).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Skip during `next build` static analysis — DATABASE_URL might be missing,
  // and orphan recovery has nothing useful to do at build time.
  if (!process.env.DATABASE_URL) return;

  try {
    const { failOrphanArchiveJobs } = await import('@/server/archive/failOrphanJobs');
    await failOrphanArchiveJobs();
  } catch (err) {
    // Never block server startup on this; just log.
    console.error('[instrumentation] failOrphanArchiveJobs failed:', err);
  }
}
