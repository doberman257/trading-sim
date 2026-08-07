"use client";

import { useState, type ReactNode } from "react";

export type StockDetailTabsProps = {
  chart: ReactNode;
  position: ReactNode;
  orders: ReactNode;
};

const TABS = [
  { id: "chart", label: "Chart" },
  { id: "position", label: "Position" },
  { id: "orders", label: "Orders" },
] as const;

type TabId = (typeof TABS)[number]["id"];

// Price and spread (StockQuoteCard) render above this, outside the tabs -
// the one piece of content the task explicitly said must stay always
// visible, never hidden behind a click. Everything else this page has
// accumulated splits three ways: visualize (Chart), act (Position - your
// holding plus the buy/sell ticket, since placing a trade is the thing
// you'd naturally do from your position in this symbol), review (Orders -
// this symbol's own fill history, not the dashboard's all-symbols one).
//
// An underline style, not the segmented "chip" buttons StockChart's own
// Interval/Range/Indicators controls use - a deliberate visual distinction
// between page-level navigation and in-panel controls, not an
// inconsistency.
export function StockDetailTabs({ chart, position, orders }: StockDetailTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>("chart");

  const content: Record<TabId, ReactNode> = { chart, position, orders };

  return (
    <div>
      <div className="border-default flex gap-4 border-b" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={
              activeTab === tab.id
                ? "border-fg text-fg -mb-px border-b-2 px-1 py-2 text-sm font-medium"
                : "text-muted hover:text-fg -mb-px border-b-2 border-transparent px-1 py-2 text-sm transition-colors"
            }
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pt-3">{content[activeTab]}</div>
    </div>
  );
}
