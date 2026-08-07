"use client";

import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { getBarsForSymbol } from "@/app/actions/bars";
import type { BarTimeframe } from "@/lib/market/alpaca";
import {
  CHART_RANGES,
  isValidTimeframeForRange,
  nearestValidTimeframe,
  TIMEFRAME_ORDER,
  type ChartRange,
} from "@/lib/market/chart-timeframes";
import { DEFAULT_RSI_PERIOD, ema, rsi, sma } from "@/lib/trading/indicators";
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

const DEFAULT_SMA_PERIOD = 20;
const DEFAULT_EMA_PERIOD = 20;
const MIN_PERIOD = 2;
const MAX_PERIOD = 500;

function clampPeriod(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SMA_PERIOD;
  return Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, Math.round(value)));
}

type IndicatorToggleProps = {
  label: string;
  enabled: boolean;
  period: number;
  activeColorClassName: string;
  onToggle: () => void;
  onPeriodChange: (period: number) => void;
};

// One toggle + period pair, shared markup for SMA/EMA/RSI - a restrained
// toggle list, not a trading terminal's full indicator dialog (no style
// pickers, no per-indicator color choice, no add/remove list).
function IndicatorToggle({
  label,
  enabled,
  period,
  activeColorClassName,
  onToggle,
  onPeriodChange,
}: IndicatorToggleProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onToggle}
        className={
          enabled
            ? `bg-selected rounded px-2 py-1 text-xs font-medium ${activeColorClassName}`
            : "text-muted hover:text-fg rounded px-2 py-1 text-xs transition-colors"
        }
      >
        {label}
      </button>
      <input
        type="number"
        value={period}
        disabled={!enabled}
        onChange={(event) => onPeriodChange(clampPeriod(Number(event.target.value)))}
        min={MIN_PERIOD}
        max={MAX_PERIOD}
        className="border-default bg-elevated text-fg w-12 rounded border px-1 py-1 text-xs tabular-nums disabled:opacity-40"
      />
    </div>
  );
}

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

  const [smaEnabled, setSmaEnabled] = useState(false);
  const [smaPeriod, setSmaPeriod] = useState(DEFAULT_SMA_PERIOD);
  const [emaEnabled, setEmaEnabled] = useState(false);
  const [emaPeriod, setEmaPeriod] = useState(DEFAULT_EMA_PERIOD);
  const [rsiEnabled, setRsiEnabled] = useState(false);
  const [rsiPeriod, setRsiPeriod] = useState(DEFAULT_RSI_PERIOD);
  const [logScale, setLogScale] = useState(false);

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
  const smaReadoutRef = useRef<HTMLSpanElement>(null);
  const emaReadoutRef = useRef<HTMLSpanElement>(null);
  const rsiReadoutRef = useRef<HTMLSpanElement>(null);

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
    const subtle = readThemeColor("--color-subtle");
    const fg = readThemeColor("--color-fg");
    const gridLine = readThemeColor("--color-default");
    const accent = readThemeColor("--color-accent");
    const smaColor = readThemeColor("--color-chart-line-1");
    const emaColor = readThemeColor("--color-chart-line-2");

    // The pane is vertically split by named price scales confined via
    // scaleMargins (the same overlay technique volume already uses, not
    // lightweight-charts' newer separate-pane API - see the volume series
    // below). RSI needs its own 0-100 scale, so enabling it re-partitions
    // the split three ways instead of two.
    const priceScaleMargins = rsiEnabled ? { top: 0.05, bottom: 0.4 } : { top: 0.1, bottom: 0.3 };
    const volumeScaleMargins = rsiEnabled ? { top: 0.6, bottom: 0.25 } : { top: 0.75, bottom: 0 };

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
        scaleMargins: priceScaleMargins,
        // Log scale applies only to the main price scale, never to volume
        // or RSI - both are already bounded/normalized (volume by its own
        // "volume" price format, RSI by its fixed 0-100 range), so a log
        // transform has no meaningful effect on either and would only
        // distort the small values near zero that both can legitimately hit.
        mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
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
      scaleMargins: volumeScaleMargins,
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

    // Indicators are computed from the same closing prices already loaded
    // for the candles - no separate fetch, per lib/trading/indicators.ts
    // being pure functions with no fetching of their own.
    const closesCents = bars.map((bar) => BigInt(bar.closeCents));
    const smaValues = smaEnabled ? sma(closesCents, smaPeriod) : null;
    const emaValues = emaEnabled ? ema(closesCents, emaPeriod) : null;
    const rsiValues = rsiEnabled ? rsi(closesCents, rsiPeriod) : null;

    if (smaValues) {
      const smaSeries = chart.addSeries(LineSeries, {
        color: smaColor,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      // Points with no value yet (the first `period - 1` bars) are omitted
      // entirely rather than plotted as 0 - the line simply starts once
      // there's enough data, same "null means unknown" convention the
      // indicator functions themselves use.
      smaSeries.setData(
        bars
          .map((bar, i) => ({ time: barChartTime(bar.timestamp, timeframe), value: smaValues[i] }))
          .filter((point): point is { time: Time; value: number } => point.value !== null)
          .map((point) => ({ time: point.time, value: point.value / 100 })),
      );
    }

    if (emaValues) {
      const emaSeries = chart.addSeries(LineSeries, {
        color: emaColor,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      emaSeries.setData(
        bars
          .map((bar, i) => ({ time: barChartTime(bar.timestamp, timeframe), value: emaValues[i] }))
          .filter((point): point is { time: Time; value: number } => point.value !== null)
          .map((point) => ({ time: point.time, value: point.value / 100 })),
      );
    }

    if (rsiValues) {
      const rsiSeries = chart.addSeries(LineSeries, {
        color: fg,
        lineWidth: 1,
        priceScaleId: "rsi",
        priceLineVisible: false,
        lastValueVisible: false,
        // RSI's own scale is fixed 0-100, not auto-fit to the visible
        // data's range - a flat run near 50 shouldn't zoom in and look
        // like it's swinging wildly between two nearly-identical values.
        // This is a series option, not a price-scale option, despite
        // configuring the scale's own behavior.
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: 0, maxValue: 100 },
        }),
      });
      chart.priceScale("rsi").applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
        visible: false,
      });
      rsiSeries.setData(
        bars
          .map((bar, i) => ({ time: barChartTime(bar.timestamp, timeframe), value: rsiValues[i] }))
          .filter((point): point is { time: Time; value: number } => point.value !== null),
      );
      // Conventional overbought/oversold reference lines, not interactive -
      // kept to two thin dashed lines, not shaded zones, per "keep the UI
      // restrained."
      rsiSeries.createPriceLine({
        price: 70,
        color: subtle,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });
      rsiSeries.createPriceLine({
        price: 30,
        color: subtle,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
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
    const byTime = new Map<string | number, number>(
      bars.map((bar, i) => [barChartTime(bar.timestamp, timeframe) as string | number, i]),
    );

    function renderReadout(bar: StockChartBar, index: number) {
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
      if (smaReadoutRef.current) {
        const value = smaValues?.[index];
        smaReadoutRef.current.textContent = value != null ? (value / 100).toFixed(2) : "—";
      }
      if (emaReadoutRef.current) {
        const value = emaValues?.[index];
        emaReadoutRef.current.textContent = value != null ? (value / 100).toFixed(2) : "—";
      }
      if (rsiReadoutRef.current) {
        const value = rsiValues?.[index];
        rsiReadoutRef.current.textContent = value != null ? value.toFixed(1) : "—";
      }
    }

    const lastIndex = bars.length - 1;
    const lastBar = bars[lastIndex];
    if (lastBar) renderReadout(lastBar, lastIndex);

    chart.subscribeCrosshairMove((param) => {
      const key = param.time !== undefined ? normalizeChartTime(param.time) : undefined;
      const index = key !== undefined ? byTime.get(key) : undefined;
      if (index !== undefined) {
        renderReadout(bars[index]!, index);
      } else if (lastBar) {
        renderReadout(lastBar, lastIndex);
      }
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
  }, [
    bars,
    timeframe,
    avgCostCents,
    trades,
    smaEnabled,
    smaPeriod,
    emaEnabled,
    emaPeriod,
    rsiEnabled,
    rsiPeriod,
    logScale,
  ]);

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
        <button
          type="button"
          onClick={() => setLogScale((v) => !v)}
          title="Log scale shows percentage moves correctly over a long range; linear exaggerates recent absolute moves"
          className={segmentedButtonClassName(logScale, false)}
        >
          Log
        </button>
      </div>

      <div className="border-default flex flex-wrap items-center gap-3 border-b px-3 py-2">
        <span className="text-subtle text-xs">Indicators</span>
        <IndicatorToggle
          label="SMA"
          enabled={smaEnabled}
          period={smaPeriod}
          activeColorClassName="text-chart-line-1"
          onToggle={() => setSmaEnabled((v) => !v)}
          onPeriodChange={setSmaPeriod}
        />
        <IndicatorToggle
          label="EMA"
          enabled={emaEnabled}
          period={emaPeriod}
          activeColorClassName="text-chart-line-2"
          onToggle={() => setEmaEnabled((v) => !v)}
          onPeriodChange={setEmaPeriod}
        />
        <IndicatorToggle
          label="RSI"
          enabled={rsiEnabled}
          period={rsiPeriod}
          activeColorClassName="text-fg"
          onToggle={() => setRsiEnabled((v) => !v)}
          onPeriodChange={setRsiPeriod}
        />
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
            {smaEnabled && (
              <span className="text-chart-line-1">
                SMA <span ref={smaReadoutRef} className="font-mono tabular-nums" />
              </span>
            )}
            {emaEnabled && (
              <span className="text-chart-line-2">
                EMA <span ref={emaReadoutRef} className="font-mono tabular-nums" />
              </span>
            )}
            {rsiEnabled && (
              <span className="text-muted">
                RSI <span ref={rsiReadoutRef} className="text-fg font-mono tabular-nums" />
              </span>
            )}
          </div>
          <div ref={containerRef} />
        </div>
      )}
    </div>
  );
}
