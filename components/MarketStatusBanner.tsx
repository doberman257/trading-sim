import type { MarketStatus } from "@/lib/trading/market-hours";

// Both are display formatting only, not trading rules - they stay local to
// this component rather than living in lib/trading/market-hours.ts.
function formatEasternTime(date: Date): string {
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)} ET`;
}

function formatEasternWeekday(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
  }).format(date);
}

// Exported (not just used internally) so the message text itself is
// unit-testable without a DOM/render setup, which this project doesn't have
// - see MarketStatusBanner.test.ts.
export function openMessage(status: MarketStatus): string {
  if (!status.closesAt) {
    return "Market open";
  }

  const early = status.isEarlyCloseToday ? " (early close)" : "";
  return `Market open · closes at ${formatEasternTime(status.closesAt)}${early}`;
}

// Builds the closed-state message from data the pure getMarketStatus
// already computed (nextOpenIsTomorrow, holidayName) rather than re-deriving
// any of that here - this function only chooses wording, never business
// logic. Exhaustive over MarketClosedReason so a new reason added later
// fails the build here instead of silently falling through to nothing.
export function closedMessage(status: MarketStatus): string {
  const time = formatEasternTime(status.nextOpen);

  switch (status.reason) {
    case "before_open":
      return `Market opens at ${time}.`;
    case "after_close": {
      const day = status.nextOpenIsTomorrow ? "tomorrow" : formatEasternWeekday(status.nextOpen);
      return `Market closed — opens ${day} at ${time}.`;
    }
    case "weekend":
      return `Market closed for the weekend — opens ${formatEasternWeekday(status.nextOpen)} at ${time}.`;
    case "holiday":
      return `Market closed for ${status.holidayName ?? "a market holiday"} — opens ${formatEasternWeekday(status.nextOpen)} at ${time}.`;
    case undefined:
      return `Market closed — opens ${time}.`;
    default: {
      const _exhaustive: never = status.reason;
      return _exhaustive;
    }
  }
}

export type MarketStatusBannerProps = {
  status: MarketStatus;
};

export function MarketStatusBanner({ status }: MarketStatusBannerProps) {
  if (status.open) {
    return (
      <div className="text-muted flex items-center gap-2 text-xs">
        <span className="bg-gain size-1.5 rounded-full" />
        {openMessage(status)}
      </div>
    );
  }

  return (
    <div className="border-warn/30 bg-warn/5 text-warn flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
      <span className="bg-warn size-1.5 rounded-full" />
      {closedMessage(status)} Prices shown are from the last close.
    </div>
  );
}
