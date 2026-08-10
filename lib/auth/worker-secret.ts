import "server-only";

// The limit-order worker (app/api/worker/limit-orders/route.ts) has no user
// in the loop - it's invoked by a scheduler (GitHub Actions today, Vercel
// Cron later), not a browser with a session cookie. A shared secret
// compared against the Authorization header is the right primitive here,
// the same tradeoff app/api/check-db/route.ts's own comment already
// weighs for exactly this "no browser session available" case. Kept
// separate from lib/auth/session.ts deliberately: that function answers
// "which user is this," which has no meaning for a scheduler invoking a
// route on behalf of no one.
export function isAuthorizedWorkerRequest(req: Request): boolean {
  const secret = process.env.LIMIT_ORDER_WORKER_SECRET;

  // Never silently authorize when misconfigured - an unset secret must
  // reject every request, not accidentally accept every request because
  // an empty expected value happens to equal a missing header.
  if (!secret) {
    return false;
  }

  return req.headers.get("authorization") === `Bearer ${secret}`;
}
