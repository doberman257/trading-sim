// Source: https://www.nyse.com/markets/hours-calendars - NYSE publishes
// roughly three years ahead. This list is verified against that page
// (cross-checked by hand, not rule-derived) and currently covers dates
// through HOLIDAY_DATA_VALID_THROUGH below. Extend it - don't recompute
// existing entries - once NYSE publishes further out.
//
// This is deliberately plain data, not a "landed on a weekend -> shift to
// the nearest weekday" rule applied at runtime. Three real NYSE exceptions
// prove that rule isn't safe to automate:
//   - Jul 3, 2026 is a FULL closure (the Jul 4 Saturday holiday observed
//     early), not a 1:00pm early close - early closes only happen on Jul 3
//     when Jul 4 is a Tuesday (see 2028 below).
//   - Dec 24, 2027 is a FULL closure (Christmas observed, since Dec 25 is a
//     Saturday), not the usual Christmas Eve early close.
//   - New Year's Day 2028 (Jan 1, a Saturday) is NOT observed on the
//     preceding Friday at all - it's simply skipped that year.
// `date` is always the actual Eastern calendar date the market is closed
// on, with any such observed-date wrinkle already baked in.
export const HOLIDAY_DATA_VALID_THROUGH = "2028-12-31";

export type MarketHoliday = { date: string; name: string };

export const NYSE_HOLIDAYS: readonly MarketHoliday[] = [
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-01-19", name: "Martin Luther King, Jr. Day" },
  { date: "2026-02-16", name: "Washington's Birthday" },
  { date: "2026-04-03", name: "Good Friday" },
  { date: "2026-05-25", name: "Memorial Day" },
  { date: "2026-06-19", name: "Juneteenth National Independence Day" },
  { date: "2026-07-03", name: "Independence Day (observed - Jul 4 is a Saturday)" },
  { date: "2026-09-07", name: "Labor Day" },
  { date: "2026-11-26", name: "Thanksgiving Day" },
  { date: "2026-12-25", name: "Christmas Day" },
  { date: "2027-01-01", name: "New Year's Day" },
  { date: "2027-01-18", name: "Martin Luther King, Jr. Day" },
  { date: "2027-02-15", name: "Washington's Birthday" },
  { date: "2027-03-26", name: "Good Friday" },
  { date: "2027-05-31", name: "Memorial Day" },
  {
    date: "2027-06-18",
    name: "Juneteenth National Independence Day (observed - Jun 19 is a Saturday)",
  },
  { date: "2027-07-05", name: "Independence Day (observed - Jul 4 is a Sunday)" },
  { date: "2027-09-06", name: "Labor Day" },
  { date: "2027-11-25", name: "Thanksgiving Day" },
  { date: "2027-12-24", name: "Christmas Day (observed - Dec 25 is a Saturday)" },
  // No New Year's Day 2028 entry: Jan 1, 2028 is a Saturday, and unlike
  // every other holiday here, NYSE does not observe it on the preceding
  // Friday (Dec 31, 2027) - that day and Mon Jan 3, 2028 are both normal
  // trading days. See the regression test for this in market-hours.test.ts.
  { date: "2028-01-17", name: "Martin Luther King, Jr. Day" },
  { date: "2028-02-21", name: "Washington's Birthday" },
  { date: "2028-04-14", name: "Good Friday" },
  { date: "2028-05-29", name: "Memorial Day" },
  { date: "2028-06-19", name: "Juneteenth National Independence Day" },
  { date: "2028-07-04", name: "Independence Day" },
  { date: "2028-09-04", name: "Labor Day" },
  { date: "2028-11-23", name: "Thanksgiving Day" },
  { date: "2028-12-25", name: "Christmas Day" },
];

// Early-close days: the market closes at 1:00pm ET instead of 4:00pm.
export type EarlyCloseDay = { date: string; name: string };

export const NYSE_EARLY_CLOSE_DAYS: readonly EarlyCloseDay[] = [
  { date: "2026-11-27", name: "Day after Thanksgiving" },
  { date: "2026-12-24", name: "Christmas Eve" },
  { date: "2027-11-26", name: "Day after Thanksgiving" },
  // No 2027 Christmas Eve early close: Dec 25, 2027 is a Saturday, so the
  // observed holiday falls on Dec 24 itself (full close, see NYSE_HOLIDAYS)
  // rather than Dec 24 being a separate early-close eve.
  // No Jul 3 early close in 2026 or 2027: in 2026 Jul 3 is the observed
  // Independence Day holiday itself (full close); in 2027 Jul 3 is a
  // Saturday (already a weekend).
  { date: "2028-07-03", name: "Day before Independence Day (Jul 4 is a Tuesday)" },
  { date: "2028-11-24", name: "Day after Thanksgiving" },
  // Dec 24, 2028 is itself a Sunday (already closed as a weekend day, not
  // an early-close candidate). NYSE sometimes gives an early close on the
  // last trading day before Christmas when Christmas Eve falls on a
  // weekend, which would make Fri Dec 22, 2028 the candidate here - but do
  // NOT assume that without confirming it against
  // https://www.nyse.com/markets/hours-calendars closer to the date.
];

export type MarketClosedReason = "weekend" | "holiday" | "before_open" | "after_close";

export type MarketStatus = {
  open: boolean;
  reason?: MarketClosedReason;
  nextOpen: Date;
  // Only set when open: true. Today's actual close time, accounting for
  // early-close days - exposed here so callers displaying "closes at X"
  // never need to re-derive whether today is an early close themselves.
  closesAt?: Date;
  // Only set when open: true. Lets a caller say "(early close)" without
  // re-deriving it from closesAt's wall-clock hour.
  isEarlyCloseToday?: boolean;
  // Only set when reason === "holiday". The specific holiday's name, so a
  // caller can say "closed for Independence Day" instead of just "holiday".
  holidayName?: string;
  // Only set when open: false. True when nextOpen falls on the very next
  // calendar date (ET), so a caller can say "opens tomorrow" instead of
  // "opens Wednesday" when today already is the day before that open -
  // saying the weekday name in that case reads as if it were a different,
  // later Wednesday.
  nextOpenIsTomorrow?: boolean;
};

const REGULAR_OPEN_MINUTES = 9 * 60 + 30; // 9:30am ET
const REGULAR_CLOSE_MINUTES = 16 * 60; // 4:00pm ET
const EARLY_CLOSE_MINUTES = 13 * 60; // 1:00pm ET

type EasternParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday .. 6 = Saturday
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// hourCycle "h23" is important: it gives plain 0-23 hours with no AM/PM part
// and avoids the ICU quirk where some hour cycles render midnight as "24".
const EASTERN_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

// Deriving the Eastern wall-clock time this way - via Intl and the IANA
// "America/New_York" zone - is the whole point: the ICU/tzdata behind Intl
// already knows exactly when US DST starts and ends each year (2nd Sunday
// of March / 1st Sunday of November), including years where that differs
// from EU DST rules. A hardcoded UTC-4/UTC-5 offset would silently be wrong
// for anyone running this outside those exact dates.
function getEasternParts(date: Date): EasternParts {
  const parts = EASTERN_PARTS_FORMATTER.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    weekday: WEEKDAY_INDEX[lookup.weekday ?? ""] ?? 0,
  };
}

function dateKey(parts: Pick<EasternParts, "year" | "month" | "day">): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

// The Eastern trading-day date ("YYYY-MM-DD") a UTC instant falls on -
// e.g. for mapping an order's UTC filledAt onto the daily bar it belongs to.
// Bar dates from Alpaca (lib/market/alpaca.ts's fetchDailyBars) are already
// in this exact form, confirmed empirically to be DST-correct on Alpaca's
// side (the bar's own UTC hour shifts between 04:00 and 05:00 across the
// year so its date portion always lands on the right Eastern calendar day).
// An order's filledAt has no such guarantee - a naive `.toISOString().slice(0,
// 10)` happens to agree with this function for any fill during regular
// market hours (9:30am-4pm ET never crosses a UTC midnight boundary), but
// depending on that coincidence instead of doing the real conversion is
// exactly the kind of thing that quietly breaks the day extended-hours
// trading is ever added.
export function toExchangeDateKey(date: Date): string {
  return dateKey(getEasternParts(date));
}

// The UTC instant of midnight, Eastern time, on the trading day `date`
// falls on - the boundary between "today's still-forming bar" and every
// completed day before it. Used to split a completed/live bars fetch (see
// lib/market/alpaca.ts) at exactly the right instant regardless of DST.
export function startOfExchangeDay(date: Date): Date {
  const parts = getEasternParts(date);
  return easternWallClockToUtc(parts.year, parts.month, parts.day, 0, 0);
}

// The UTC instant of midnight, Eastern time, on the Monday of the trading
// week `date` falls on. Weeks start Monday, matching how markets and
// weekly bars are conventionally aligned - not the Intl/ISO default of
// Sunday or Monday-varies-by-locale.
export function startOfExchangeWeek(date: Date): Date {
  const parts = getEasternParts(date);
  // Sunday (weekday 0) is 6 days after the preceding Monday; every other
  // weekday is (weekday - 1) days after its own week's Monday.
  const daysSinceMonday = parts.weekday === 0 ? 6 : parts.weekday - 1;

  // Subtract whole calendar days in an abstract UTC calendar (noon, to stay
  // clear of any day-boundary edge case), then convert the resulting
  // calendar date to a real instant once, at the end - rather than
  // subtracting milliseconds from an already-DST-resolved Eastern instant,
  // which would need a case-by-case argument for why that's still safe
  // across a week containing a DST transition Sunday. This construction
  // doesn't need that argument: only easternWallClockToUtc ever has to
  // reason about DST, and it does so for the exact calendar date being
  // asked about, not for a date arrived at by subtracting real time.
  const abstractMonday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  abstractMonday.setUTCDate(abstractMonday.getUTCDate() - daysSinceMonday);

  return easternWallClockToUtc(
    abstractMonday.getUTCFullYear(),
    abstractMonday.getUTCMonth() + 1,
    abstractMonday.getUTCDate(),
    0,
    0,
  );
}

// Converts an Eastern wall-clock time back into a precise UTC instant.
// America/New_York is always exactly UTC-5 (EST) or UTC-4 (EDT), never
// anything else, so guessing EST and checking the round trip through
// getEasternParts (which is DST-aware) either confirms the guess or shows
// it's off by exactly one hour - at which point we know EDT was actually in
// effect and correct for it. This never hardcodes which dates are DST.
function easternWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
  const parts = getEasternParts(guess);

  if (parts.day === day && parts.hour === hour && parts.minute === minute) {
    return guess;
  }

  return new Date(guess.getTime() - 60 * 60 * 1000);
}

function findHoliday(key: string): MarketHoliday | undefined {
  return NYSE_HOLIDAYS.find((holiday) => holiday.date === key);
}

function isHoliday(key: string): boolean {
  return findHoliday(key) !== undefined;
}

function findEarlyClose(key: string): EarlyCloseDay | undefined {
  return NYSE_EARLY_CLOSE_DAYS.find((day) => day.date === key);
}

// The next 9:30am ET on a trading day strictly after `fromParts`'s date.
// Steps forward one Eastern calendar day at a time, anchored at noon UTC so
// the step itself can never be shifted onto the wrong day by a DST jump.
function nextTradingDayOpen(fromParts: Pick<EasternParts, "year" | "month" | "day">): Date {
  let cursor = new Date(Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day + 1, 12));

  for (let i = 0; i < 14; i++) {
    const parts = getEasternParts(cursor);
    const isWeekend = parts.weekday === 0 || parts.weekday === 6;

    if (!isWeekend && !isHoliday(dateKey(parts))) {
      return easternWallClockToUtc(parts.year, parts.month, parts.day, 9, 30);
    }

    cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12));
  }

  throw new Error(
    "Could not find the next market open within 14 days - check NYSE_HOLIDAYS for a gap",
  );
}

export function getMarketStatus(now: Date): MarketStatus {
  const parts = getEasternParts(now);
  const key = dateKey(parts);
  const isWeekend = parts.weekday === 0 || parts.weekday === 6;
  const holiday = isHoliday(key);
  const earlyClose = findEarlyClose(key);
  const minutesNow = parts.hour * 60 + parts.minute;
  const closeMinutes = earlyClose ? EARLY_CLOSE_MINUTES : REGULAR_CLOSE_MINUTES;

  const isTradingDay = !isWeekend && !holiday;
  const beforeOpen = isTradingDay && minutesNow < REGULAR_OPEN_MINUTES;
  const open = isTradingDay && !beforeOpen && minutesNow < closeMinutes;

  if (open) {
    const closesAt = easternWallClockToUtc(
      parts.year,
      parts.month,
      parts.day,
      Math.floor(closeMinutes / 60),
      closeMinutes % 60,
    );
    return {
      open: true,
      nextOpen: nextTradingDayOpen(parts),
      closesAt,
      isEarlyCloseToday: earlyClose !== undefined,
    };
  }

  let reason: MarketClosedReason;
  if (isWeekend) {
    reason = "weekend";
  } else if (holiday) {
    reason = "holiday";
  } else if (beforeOpen) {
    reason = "before_open";
  } else {
    reason = "after_close";
  }

  const nextOpen = beforeOpen
    ? easternWallClockToUtc(parts.year, parts.month, parts.day, 9, 30)
    : nextTradingDayOpen(parts);

  const tomorrow = getEasternParts(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12)),
  );
  const nextOpenIsTomorrow = dateKey(getEasternParts(nextOpen)) === dateKey(tomorrow);

  return {
    open: false,
    reason,
    nextOpen,
    nextOpenIsTomorrow,
    holidayName: reason === "holiday" ? findHoliday(key)?.name : undefined,
  };
}

export function isMarketOpen(now: Date): boolean {
  return getMarketStatus(now).open;
}
