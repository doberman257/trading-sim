import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { getOrCreateAccount } from "@/lib/db/accounts";
import { getActiveBotRunCount } from "@/lib/db/bot-runs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Shared shell for every authenticated, signed-in page (dashboard, discover,
// stock detail) - the auth redirect lives here once instead of being
// repeated at the top of each page. Also where the header's "N active bot
// runs" count is fetched, for the same reason: the header itself renders on
// every one of these pages, not just the dashboard, so this is the one
// place that count can be loaded once for all of them.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const account = await getOrCreateAccount(user.id);
  const activeBotRunCount = await getActiveBotRunCount(account.id);

  return (
    <>
      <Nav userEmail={user.email ?? ""} activeBotRunCount={activeBotRunCount} />
      {children}
    </>
  );
}
