import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AuthResult = { ok: true; userId: string } | { ok: false };

// The single entry point every Route Handler under app/api/ uses to answer
// "who is making this request" - built this way from the start because
// Route Handlers, unlike Server Actions, are meant to be callable directly
// by a future bot/API-key client, not just by this app's own browser
// session. Today there is exactly one branch: the Supabase session cookie,
// read the same way app/actions/trade.ts already does. A future API-key
// branch (checking `req.headers.get("authorization")` against a stored,
// hashed key and resolving it to a userId) slots in here as an additional
// check, tried alongside or before the session check - no Route Handler
// that already calls this function needs to change when that lands. `req`
// is accepted now, even though this first branch doesn't need it, so that
// addition doesn't change this function's signature later.
export async function getAuthenticatedUserId(req: Request): Promise<AuthResult> {
  void req;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return { ok: false };
  }

  return { ok: true, userId: user.id };
}
