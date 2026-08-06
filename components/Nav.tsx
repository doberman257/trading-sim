"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/(auth)/actions";

export type NavProps = {
  userEmail: string;
};

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/discover", label: "Discover" },
] as const;

// Highlights Discover for /stock/[symbol] too - a stock detail page is only
// ever reached by browsing from Discover, so that's the section it belongs
// to even though the URL isn't nested under /discover.
function isLinkActive(pathname: string, href: string): boolean {
  if (href === "/discover") {
    return pathname.startsWith("/discover") || pathname.startsWith("/stock/");
  }
  return pathname.startsWith(href);
}

export function Nav({ userEmail }: NavProps) {
  const pathname = usePathname();

  return (
    <header className="border-default bg-panel border-b">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between px-3 py-2.5">
        <nav className="flex items-center gap-4">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={
                isLinkActive(pathname, link.href)
                  ? "text-fg text-sm font-medium"
                  : "text-muted hover:text-fg text-sm transition-colors"
              }
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <span className="text-muted text-xs">{userEmail}</span>
          <form action={logout}>
            <button type="submit" className="text-muted hover:text-fg text-xs transition-colors">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
