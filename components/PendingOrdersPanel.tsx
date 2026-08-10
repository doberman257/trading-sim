"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatCents } from "@/lib/trading/money";
import type { CancelOrderReason, Side } from "@/lib/trading/types";

export type PendingOrderItem = {
  id: string;
  symbol: string;
  side: Side;
  quantity: number;
  // Crosses the Server -> Client Component boundary as a string, same
  // convention as every other money value in this app (see OrderTicket's
  // cashCentsString) - never a raw bigint.
  limitPriceCents: string;
};

export type PendingOrdersPanelProps = {
  orders: PendingOrderItem[];
  // True when the worker that would fill or expire these hasn't run
  // recently, given whether the market is currently open - see
  // lib/trading/worker-staleness.ts. Deliberately a prop, not fetched by
  // this component itself: the page already has to load the market status
  // and the worker's last run for its own reasons, so this stays a plain
  // display component instead of a second data-fetching path.
  workerStale: boolean;
};

function cancelReasonMessage(reason: CancelOrderReason): string {
  switch (reason) {
    case "already_filled":
      return "This order filled just before it could be cancelled.";
    case "not_cancellable":
      return "This order is no longer pending - it was already cancelled or expired.";
    case "not_found":
      return "This order could not be found.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

// Deliberately separate from RecentOrdersPanel: that one is a general
// history of every status, with no action attached to any row. This is
// specifically "what's still resting on the book right now, and here's how
// to take it back" - mixing the two would bury the one row type a user can
// actually act on inside a list of ones they can't.
export function PendingOrdersPanel({ orders, workerStale }: PendingOrdersPanelProps) {
  const router = useRouter();
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [errorByOrderId, setErrorByOrderId] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  function handleCancel(orderId: string) {
    setCancellingId(orderId);
    setErrorByOrderId((prev) => {
      const next = { ...prev };
      delete next[orderId];
      return next;
    });

    startTransition(async () => {
      try {
        const response = await fetch(`/api/orders/${orderId}/cancel`, { method: "POST" });
        const body: { ok: true } | { ok: false; reason: CancelOrderReason } = await response.json();

        if (!body.ok) {
          setErrorByOrderId((prev) => ({ ...prev, [orderId]: cancelReasonMessage(body.reason) }));
        }

        // A plain fetch to a Route Handler, unlike a Server Action, has no
        // automatic client Router Cache invalidation tied to it - the
        // route's own revalidatePath call only marks the server-side cache
        // stale. This is what actually makes the page re-fetch and show
        // the order's new state.
        router.refresh();
      } catch {
        setErrorByOrderId((prev) => ({
          ...prev,
          [orderId]: "Something went wrong cancelling this order. Try again.",
        }));
      } finally {
        setCancellingId(null);
      }
    });
  }

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Pending limit orders</h2>
      </header>
      {orders.length > 0 && workerStale && (
        <div
          role="alert"
          className="border-warn/30 bg-warn/5 text-warn border-b px-4 py-2 text-xs leading-snug"
        >
          The background worker that fills or expires these hasn&apos;t run recently - these orders
          may not be actively watched right now.
        </div>
      )}
      <div className="p-4">
        {orders.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">No pending limit orders.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {orders.map((order) => (
              <div
                key={order.id}
                className="border-default bg-elevated flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div>
                  <div className="text-fg text-sm font-medium">
                    {/* Not gain/loss colored - buy/sell side isn't itself a
                        financial direction, same convention as
                        RecentOrdersPanel's Side column. */}
                    <span className="capitalize">{order.side}</span> {order.quantity} {order.symbol}{" "}
                    @ ${formatCents(BigInt(order.limitPriceCents))}
                  </div>
                  {errorByOrderId[order.id] && (
                    <p className="text-warn mt-1 text-xs">{errorByOrderId[order.id]}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleCancel(order.id)}
                  disabled={cancellingId === order.id}
                  className="border-default hover:bg-selected shrink-0 rounded-md border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cancellingId === order.id ? "Cancelling…" : "Cancel"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
