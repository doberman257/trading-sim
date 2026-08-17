"use server";

import { revalidatePath } from "next/cache";
import { resetAccount } from "@/lib/db/accounts";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// A Server Action, not a Route Handler - unlike placing an order or
// starting a bot run, there's no bot/API-key use case for wiping an
// account's own trading history, so this doesn't need the Route-Handler-
// first treatment those do. Thin, per CLAUDE.md: resolve the user, delegate
// to lib/db/accounts.ts, revalidate - no business logic here.
export async function resetAccountAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("Not authenticated");
  }

  await resetAccount(user.id);

  revalidatePath("/dashboard");
}
