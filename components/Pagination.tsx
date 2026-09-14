"use client";

// Shared numbered pager for every list panel in this app - see
// trading-ui-design skill's Buttons/Motion sections for the ghost-button and
// no-entrance-animation conventions this follows. Deliberately dumb: it only
// knows the current page and how many pages exist, and calls back on click -
// the actual slicing lives in lib/pagination.ts, and each panel owns its own
// page state (this never fetches, never resets itself).
export type PaginationProps = {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
};

// A small, bounded window of page numbers around the current one, plus the
// first/last page and ellipses when they're not already adjacent - the same
// shape as every mainstream paginator, kept simple since no list in this app
// realistically grows past a handful of pages.
function pageWindow(page: number, pageCount: number): (number | "ellipsis")[] {
  const window = 1;
  const pages = new Set<number>();
  pages.add(1);
  pages.add(pageCount);
  for (let p = page - window; p <= page + window; p++) {
    if (p >= 1 && p <= pageCount) pages.add(p);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const result: (number | "ellipsis")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    if (current === undefined) continue;
    const previous = sorted[i - 1];
    if (previous !== undefined && current - previous > 1) {
      result.push("ellipsis");
    }
    result.push(current);
  }
  return result;
}

export function Pagination({ page, pageCount, onPageChange }: PaginationProps) {
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label="Pagination"
      className="border-default mt-3 flex items-center justify-center gap-1 border-t pt-3"
    >
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
        className="text-muted hover:text-fg rounded-md px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
      >
        Prev
      </button>

      {pageWindow(page, pageCount).map((entry, index) =>
        entry === "ellipsis" ? (
          <span key={`ellipsis-${index}`} className="text-subtle px-1.5 text-xs">
            …
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            onClick={() => onPageChange(entry)}
            aria-current={entry === page ? "page" : undefined}
            className={
              entry === page
                ? "bg-selected text-fg min-w-6 rounded-md px-2 py-1 font-mono text-xs tabular-nums"
                : "text-muted hover:text-fg min-w-6 rounded-md px-2 py-1 font-mono text-xs tabular-nums"
            }
          >
            {entry}
          </button>
        ),
      )}

      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= pageCount}
        aria-label="Next page"
        className="text-muted hover:text-fg rounded-md px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </nav>
  );
}
