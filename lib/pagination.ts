// Generic client-side pagination over an already-loaded array - shared by
// every list panel (Positions, Recent orders, Bot runs, Pending orders,
// Popular, Watchlist, per-symbol order history). Not trading domain logic,
// so this deliberately lives outside lib/trading/ rather than alongside
// money/order-execution rules.
export const DEFAULT_PAGE_SIZE = 7;

export function getPageCount(itemCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(itemCount / pageSize));
}

// A page number from stale state (e.g. the list just got shorter after a
// filter change or a row was removed) is clamped back into range rather
// than shown as an accidentally-blank page.
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(page, 1), pageCount);
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const clampedPage = clampPage(page, getPageCount(items.length, pageSize));
  const start = (clampedPage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
