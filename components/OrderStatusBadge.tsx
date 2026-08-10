import type { OrderStatus } from "@/lib/db/portfolio";

const STATUS_DISPLAY: Record<OrderStatus, { label: string; glyph: string; className: string }> = {
  filled: { label: "Filled", glyph: "●", className: "text-fg" },
  rejected: { label: "Rejected", glyph: "✕", className: "text-loss" },
  cancelled: { label: "Cancelled", glyph: "○", className: "text-muted" },
  pending: { label: "Pending", glyph: "◷", className: "text-warn" },
  // A limit order the worker swept at market close, still unfilled - day
  // orders only. Distinct glyph/muted color from "cancelled": this wasn't
  // a user action, it just ran out of trading day.
  expired: { label: "Expired", glyph: "◌", className: "text-muted" },
};

export type OrderStatusBadgeProps = {
  status: OrderStatus;
};

// Status is never color alone - every state pairs a glyph with the color,
// same discipline as gain/loss (see trading-ui-design skill).
export function OrderStatusBadge({ status }: OrderStatusBadgeProps) {
  const { label, glyph, className } = STATUS_DISPLAY[status];

  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${className}`}>
      <span aria-hidden>{glyph}</span>
      {label}
    </span>
  );
}
