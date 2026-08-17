"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { resetAccountAction } from "@/app/actions/reset-account";

// A two-step confirm, not a native confirm() dialog - this app has no
// modal component anywhere, and a browser-native confirm() would be the
// one place in the whole UI that breaks the custom dark theme. Deliberately
// more friction than PendingOrdersPanel's plain one-click Cancel: this
// deletes an account's ENTIRE trading history at once (orders,
// transactions, positions, bot runs), not one resting order, and that
// difference in blast radius should read as a difference in the UI, not
// just in what the button happens to be labeled.
export function ResetAccountButton() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleReset() {
    setError(null);
    startTransition(async () => {
      try {
        await resetAccountAction();
        setConfirming(false);
        router.refresh();
      } catch {
        setError("Something went wrong resetting your account. Try again.");
      }
    });
  }

  return (
    <section className="border-warn/30 bg-warn/5 rounded-lg border p-4">
      <h2 className="text-fg text-sm font-medium">Reset account</h2>
      <p className="text-subtle mt-1 text-xs leading-snug">
        Deletes every order, transaction, position, and bot run on this account and restores your
        starting $100,000.00 balance. Your watchlist is not affected. This cannot be undone.
      </p>
      {error && <p className="text-warn mt-2 text-xs">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              onClick={handleReset}
              disabled={isPending}
              className="bg-loss text-on-fg rounded-md px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Resetting…" : "Confirm reset - delete everything"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={isPending}
              className="border-default hover:bg-selected rounded-md border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="border-warn/40 text-warn hover:bg-warn/10 rounded-md border px-3 py-1.5 text-xs font-medium"
          >
            Reset account
          </button>
        )}
      </div>
    </section>
  );
}
