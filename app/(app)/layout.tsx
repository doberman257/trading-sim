import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Shared shell for every authenticated, signed-in page (dashboard, discover,
// stock detail) - the auth redirect lives here once instead of being
// repeated at the top of each page.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <>
      <Nav userEmail={user.email ?? ""} />
      {children}
    </>
  );
}
