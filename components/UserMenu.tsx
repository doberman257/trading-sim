"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { logout } from "@/app/(auth)/actions";
import { resetAccountAction } from "@/app/actions/reset-account";

export type UserMenuProps = {
  userEmail: string;
  // Fetched once in app/(app)/layout.tsx (not by this component) and
  // threaded down through Nav - the header renders on every authenticated
  // page, but the bot panels themselves only render on the dashboard, so
  // this is the one place a user browsing Discover or a stock page can see
  // whether a run is still working without navigating back.
  activeBotRunCount: number;
};

function botStatusLabel(activeBotRunCount: number): string {
  if (activeBotRunCount === 0) return "No active bot runs";
  const noun = activeBotRunCount === 1 ? "run" : "runs";
  return `${activeBotRunCount} active bot ${noun}`;
}

// A round avatar button (the user's own initial, not an icon library this
// app has no other use for) opening a dropdown - same click-outside-closes
// pattern SymbolAutocomplete already established (a containerRef + a
// document-level mousedown listener), reused here rather than a second
// implementation of the same interaction.
export function UserMenu({ userEmail, activeBotRunCount }: UserMenuProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  const initial = userEmail.trim().charAt(0).toUpperCase() || "?";

  function closeMenu() {
    setIsOpen(false);
    setConfirmingReset(false);
    setError(null);
  }

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  function handleResetConfirm() {
    setError(null);
    startTransition(async () => {
      try {
        await resetAccountAction();
        closeMenu();
        router.refresh();
      } catch {
        setError("Something went wrong resetting your account. Try again.");
      }
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Account menu"
        className="bg-accent text-on-fg flex size-8 items-center justify-center rounded-full text-sm font-medium"
      >
        {initial}
      </button>

      {isOpen && (
        <div
          role="menu"
          className="border-default bg-panel absolute right-0 z-20 mt-2 w-64 rounded-md border py-1 shadow-none"
        >
          <div className="text-subtle border-default truncate border-b px-3 py-2 text-xs">
            {userEmail}
          </div>

          <Link
            href="/dashboard#bot"
            role="menuitem"
            onClick={closeMenu}
            className="text-fg hover:bg-elevated border-default block w-full border-b px-3 py-2 text-left text-sm transition-colors"
          >
            {botStatusLabel(activeBotRunCount)}
          </Link>

          {confirmingReset ? (
            <div className="px-3 py-2">
              <p className="text-warn text-xs leading-snug">
                Delete every order, transaction, position, and bot run, and restore your starting
                $100,000.00 balance? Your watchlist is not affected. This cannot be undone.
              </p>
              {error && <p className="text-warn mt-1 text-xs">{error}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleResetConfirm}
                  disabled={isPending}
                  className="bg-loss text-on-fg rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPending ? "Resetting…" : "Confirm reset"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  disabled={isPending}
                  className="border-default hover:bg-selected rounded-md border px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setConfirmingReset(true)}
              className="text-warn hover:bg-elevated block w-full px-3 py-2 text-left text-sm transition-colors"
            >
              Reset account
            </button>
          )}

          <form action={logout}>
            <button
              type="submit"
              role="menuitem"
              className="text-fg hover:bg-elevated border-default block w-full border-t px-3 py-2 text-left text-sm transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
