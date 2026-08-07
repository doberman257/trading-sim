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
import { useEffect, useRef, useState } from "react";
import { getBarsForSymbol } from "@/app/actions/bars";
import {
  CHART_RANGES,
  isValidTimeframeForRange,
  nearestValidTimeframe,
  TIMEFRAME_ORDER,
  type ChartRange,
} from "@/lib/market/chart-timeframes";
import type { BarTimeframe } from "@/lib/market/alpaca";
import {
  barChartTime,
  centsToDollars,
  findBarIndexAtOrBefore,
  formatDollars,
  isUpBar,
  normalizeChartTime,
  withAlpha,
} from "./stockChartFormat";

export type StockChartBar = {
  timestamp: string;
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
  // The fill's own UTC instant, not a pre-computed date key - this
  // component maps it onto whichever bar it belongs to itself (see
  // findBarIndexAtOrBefore), which works the same way regardless of
  // timeframe granularity, intraday or daily.
  timestamp: string;
  side: "buy" | "sell";
  quantity: number;
  priceCents: string;
};

export type StockChartProps = {
  symbol: string;
  initialBars: StockChartBar[];
  initialTimeframe: BarTimeframe;
  initialRange: ChartRange;
  /** Null when no position is held - no line is drawn. */
  avgCostCents?: string | null;
  trades?: StockChartTrade[];
};

function readThemeColor(variable: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

const CHART_HEIGHT = 340;

const TIMEFRAME_LABELS: Record<BarTimeframe, string> = {
  "15Min": "15m",
  "1Hour": "1h",
  "1Day": "1D",
  "1Week": "1W",
};

const segmentedButtonClassName = (active: boolean, disabled: boolean) => {
  if (disabled) return "text-subtle cursor-not-allowed px-2 py-1 text-xs";
  if (active) return "bg-selected text-fg rounded px-2 py-1 text-xs font-medium";
  return "text-muted hover:text-fg rounded px-2 py-1 text-xs transition-colors";
};

export function StockChart({
  symbol,
  initialBars,
  initialTimeframe,
  initialRange,
  avgCostCents,
  trades = [],
}: StockChartProps) {
  const [range, setRange] = useState<ChartRange>(initialRange);
  const [timeframe, setTimeframe] = useState<BarTimeframe>(initialTimeframe);
  const [bars, setBars] = useState<StockChartBar[]>(initialBars);
  const [isLoading, setIsLoading] = useState(false);
  const hasMountedRef = useRef(false);

  // Skips the fetch on the very first render - initialBars already matches
  // initialTimeframe/initialRange, fetched server-side with the page's own
  // render. Only a subsequent user-driven change to either control should
  // trigger a new request.
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    getBarsForSymbol(symbol, timeframe, range)
      .then((fetchedBars) => {
        if (!cancelled) setBars(fetchedBars);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, range]);

  function handleRangeChange(newRange: ChartRange) {
    setRange(newRange);
    // Never leaves the range/timeframe pair invalid - if the currently
    // selected timeframe doesn't survive the new range, this deterministically
    // picks a replacement rather than requiring a second click.
    setTimeframe((current) => nearestValidTimeframe(newRange, current));
  }

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
        time: barChartTime(bar.timestamp, timeframe),
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
        time: barChartTime(bar.timestamp, timeframe),
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
      const barTimestamps = bars.map((bar) => bar.timestamp);
      const markers: SeriesMarker<Time>[] = trades
        .map((trade) => {
          const barIndex = findBarIndexAtOrBefore(barTimestamps, trade.timestamp);
          // A trade older than this chart's loaded range has no bar to
          // anchor a marker to - lightweight-charts has no "off-chart"
          // marker, so it's omitted rather than misplaced.
          if (barIndex < 0) return null;
          return {
            time: barChartTime(bars[barIndex]!.timestamp, timeframe),
            position: trade.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
            color: trade.side === "buy" ? gain : loss,
            shape: trade.side === "buy" ? ("arrowUp" as const) : ("arrowDown" as const),
            text: `${trade.side === "buy" ? "B" : "S"} ${trade.quantity}`,
          };
        })
        .filter((marker) => marker !== null);
      createSeriesMarkers(candleSeries, markers);
    }

    // The crosshair readout reads from `bars`/`byTime` directly, not from
    // the values lightweight-charts hands back in the crosshair-move
    // callback - both represent the same data, but going through the
    // library's own float round-trip a second time for display has no
    // benefit and only risks a subtly different rounding from what's
    // actually plotted.
    // barChartTime only ever returns a string or a UTCTimestamp number in
    // practice (never a BusinessDay object) - the cast reflects that, since
    // Time's type alone doesn't let TS narrow it automatically.
    const byTime = new Map<string | number, StockChartBar>(
      bars.map((bar) => [barChartTime(bar.timestamp, timeframe) as string | number, bar]),
    );

    function renderReadout(bar: StockChartBar) {
      const label =
        timeframe === "1Day" || timeframe === "1Week"
          ? bar.timestamp.slice(0, 10)
          : new Date(bar.timestamp).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            });
      if (dateReadoutRef.current) dateReadoutRef.current.textContent = label;
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
      const key = param.time !== undefined ? normalizeChartTime(param.time) : undefined;
      const hovered = key !== undefined ? byTime.get(key) : undefined;
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
  }, [bars, timeframe, avgCostCents, trades]);

  return (
    <div className="border-default bg-panel rounded-lg border">
      <div className="border-default flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-subtle text-xs">Interval</span>
          <div className="flex gap-0.5">
            {TIMEFRAME_ORDER.map((tf) => {
              const disabled = !isValidTimeframeForRange(range, tf);
              return (
                <button
                  key={tf}
                  type="button"
                  disabled={disabled}
                  onClick={() => setTimeframe(tf)}
                  title={
                    disabled
                      ? `${TIMEFRAME_LABELS[tf]} bars aren't shown over a ${range} range - too many bars to be useful`
                      : undefined
                  }
                  className={segmentedButtonClassName(tf === timeframe, disabled)}
                >
                  {TIMEFRAME_LABELS[tf]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-subtle text-xs">Range</span>
          <div className="flex gap-0.5">
            {CHART_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => handleRangeChange(r)}
                className={segmentedButtonClassName(r === range, false)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {bars.length === 0 && !isLoading ? (
        <div
          className="text-muted flex items-center justify-center text-sm"
          style={{ height: CHART_HEIGHT }}
        >
          No chart data available for this symbol yet.
        </div>
      ) : (
        <div className={`relative ${isLoading ? "opacity-60" : ""}`}>
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
      )}
    </div>
  );
}
