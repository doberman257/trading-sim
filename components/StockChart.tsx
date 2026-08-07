"use client";

import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import {
  centsToDollars,
  formatDollars,
  isUpBar,
  timeToDateKey,
  withAlpha,
} from "./stockChartFormat";

export type StockChartBar = {
  date: string;
  // Crosses the Server -> Client Component boundary as strings, not
  // bigints - same reasoning as OrderTicket's cashCentsString. Reconstructed
  // to bigint, then converted to a plain dollar float only here, at the
  // point this data leaves this app's money model to feed a charting
  // library that has no concept of bigint cents.
  openCents: string;
  highCents: string;
  lowCents: string;
  closeCents: string;
  volume: number;
};

export type StockChartTrade = {
  // Already the Eastern trading-day date ("YYYY-MM-DD") the fill belongs to
  // - see toExchangeDateKey in lib/trading/market-hours.ts. This component
  // never touches raw UTC timestamps, on purpose: that conversion is the
  // one place an off-by-one-day bug would be easy to introduce and hard to
  // notice, so it happens once, server-side, with its own tests.
  date: string;
  side: "buy" | "sell";
  quantity: number;
  priceCents: string;
};

export type StockChartProps = {
  bars: StockChartBar[];
  /** Null when no position is held - no line is drawn. */
  avgCostCents?: string | null;
  trades?: StockChartTrade[];
};

function readThemeColor(variable: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

const CHART_HEIGHT = 340;

export function StockChart({ bars, avgCostCents, trades = [] }: StockChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const dateReadoutRef = useRef<HTMLSpanElement>(null);
  const openReadoutRef = useRef<HTMLSpanElement>(null);
  const highReadoutRef = useRef<HTMLSpanElement>(null);
  const lowReadoutRef = useRef<HTMLSpanElement>(null);
  const closeReadoutRef = useRef<HTMLSpanElement>(null);
  const volumeReadoutRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || bars.length === 0) return;

    // Read the real design tokens from globals.css at runtime rather than
    // hardcoding a second copy of the same hex values here - this is a
    // canvas library with no CSS access, not a styling exception to the
    // "semantic tokens only" rule, so it reads the one source of truth
    // instead of drifting from it if the palette ever changes.
    const gain = readThemeColor("--color-gain");
    const loss = readThemeColor("--color-loss");
    const muted = readThemeColor("--color-muted");
    const gridLine = readThemeColor("--color-default");
    const accent = readThemeColor("--color-accent");

    const chart = createChart(container, {
      width: container.clientWidth,
      height: CHART_HEIGHT,
      layout: { background: { color: "transparent" }, textColor: muted },
      grid: {
        vertLines: { color: gridLine },
        horzLines: { color: gridLine },
      },
      timeScale: { borderColor: gridLine },
      rightPriceScale: {
        borderColor: gridLine,
        // Leave the bottom ~28% of the pane clear for the volume overlay
        // below, so candles and volume bars never visually collide.
        scaleMargins: { top: 0.1, bottom: 0.3 },
      },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: gain,
      downColor: loss,
      borderVisible: false,
      wickUpColor: gain,
      wickDownColor: loss,
    });

    candleSeries.setData(
      bars.map((bar) => ({
        time: bar.date,
        open: centsToDollars(bar.openCents),
        high: centsToDollars(bar.highCents),
        low: centsToDollars(bar.lowCents),
        close: centsToDollars(bar.closeCents),
      })),
    );

    // Volume as an overlay on the same pane, not lightweight-charts' newer
    // separate-pane API - this is the long-established, extensively
    // documented pattern (a dedicated price scale confined to the bottom of
    // the pane via scaleMargins) and the safer choice to get right without
    // a browser available to visually confirm a newer API's behavior.
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
      visible: false,
    });

    const upVolumeColor = withAlpha(gain, "80");
    const downVolumeColor = withAlpha(loss, "80");

    volumeSeries.setData(
      bars.map((bar) => ({
        time: bar.date,
        value: bar.volume,
        // Colored by the same bar's own direction (close vs. its own open),
        // matching the candle it sits under - not the more elaborate
        // vs.-previous-close convention some charts use.
        color: isUpBar(bar.openCents, bar.closeCents) ? upVolumeColor : downVolumeColor,
      })),
    );

    if (avgCostCents != null) {
      candleSeries.createPriceLine({
        price: centsToDollars(avgCostCents),
        color: accent,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Avg cost",
      });
    }

    if (trades.length > 0) {
      const barDates = new Set(bars.map((bar) => bar.date));
      const markers: SeriesMarker<Time>[] = trades
        // A trade older than this chart's lookback window has no bar to
        // anchor a marker to - lightweight-charts has no "off-chart"
        // marker, so it's silently omitted rather than misplaced.
        .filter((trade) => barDates.has(trade.date))
        .map((trade) => ({
          time: trade.date,
          position: trade.side === "buy" ? "belowBar" : "aboveBar",
          color: trade.side === "buy" ? gain : loss,
          shape: trade.side === "buy" ? "arrowUp" : "arrowDown",
          text: `${trade.side === "buy" ? "B" : "S"} ${trade.quantity}`,
        }));
      createSeriesMarkers(candleSeries, markers);
    }

    // The crosshair readout reads from `bars`/`byDate` directly, not from
    // the values lightweight-charts hands back in the crosshair-move
    // callback - both represent the same data, but going through the
    // library's own float round-trip a second time for display has no
    // benefit and only risks a subtly different rounding from what's
    // actually plotted.
    const byDate = new Map(bars.map((bar) => [bar.date, bar]));

    function renderReadout(bar: StockChartBar) {
      if (dateReadoutRef.current) dateReadoutRef.current.textContent = bar.date;
      if (openReadoutRef.current) openReadoutRef.current.textContent = formatDollars(bar.openCents);
      if (highReadoutRef.current) highReadoutRef.current.textContent = formatDollars(bar.highCents);
      if (lowReadoutRef.current) lowReadoutRef.current.textContent = formatDollars(bar.lowCents);
      if (closeReadoutRef.current)
        closeReadoutRef.current.textContent = formatDollars(bar.closeCents);
      if (volumeReadoutRef.current)
        volumeReadoutRef.current.textContent = bar.volume.toLocaleString("en-US");
    }

    const lastBar = bars.at(-1);
    if (lastBar) renderReadout(lastBar);

    chart.subscribeCrosshairMove((param) => {
      const dateKey = param.time !== undefined ? timeToDateKey(param.time) : undefined;
      const hovered = dateKey !== undefined ? byDate.get(dateKey) : undefined;
      renderReadout(hovered ?? lastBar!);
    });

    chart.timeScale().fitContent();

    const handleResize = () => {
      chart.applyOptions({ width: container.clientWidth });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, avgCostCents, trades]);

  if (bars.length === 0) {
    return (
      <div
        className="border-default bg-panel text-muted flex items-center justify-center rounded-lg border text-sm"
        style={{ height: CHART_HEIGHT }}
      >
        No chart data available for this symbol yet.
      </div>
    );
  }

  return (
    <div className="border-default bg-panel relative rounded-lg border">
      <div
        className="pointer-events-none absolute top-2 left-3 z-10 flex flex-wrap items-baseline gap-x-3 text-xs"
        aria-hidden
      >
        <span ref={dateReadoutRef} className="text-fg font-medium" />
        <span className="text-muted">
          O <span ref={openReadoutRef} className="text-fg font-mono tabular-nums" />
        </span>
        <span className="text-muted">
          H <span ref={highReadoutRef} className="text-fg font-mono tabular-nums" />
        </span>
        <span className="text-muted">
          L <span ref={lowReadoutRef} className="text-fg font-mono tabular-nums" />
        </span>
        <span className="text-muted">
          C <span ref={closeReadoutRef} className="text-fg font-mono tabular-nums" />
        </span>
        <span className="text-muted">
          Vol <span ref={volumeReadoutRef} className="text-fg font-mono tabular-nums" />
        </span>
      </div>
      <div ref={containerRef} />
    </div>
  );
}
