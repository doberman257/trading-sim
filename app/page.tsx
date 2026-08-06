import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// This route never renders anything of its own - it's a router, not a
// page. Same reasoning as app/dashboard/page.tsx's own force-dynamic: the
// cookies() call inside createSupabaseServerClient already forces dynamic
// rendering, this is just explicit about it.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? "/dashboard" : "/login");
}
