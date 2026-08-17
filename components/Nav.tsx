"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserMenu } from "./UserMenu";

export type NavProps = {
  userEmail: string;
  activeBotRunCount: number;
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

export function Nav({ userEmail, activeBotRunCount }: NavProps) {
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
        <UserMenu userEmail={userEmail} activeBotRunCount={activeBotRunCount} />
      </div>
    </header>
  );
}
