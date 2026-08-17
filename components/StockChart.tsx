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
  timeframeIncompatibilityReason,
  type ChartRange,
} from "@/lib/market/chart-timeframes";
import { DEFAULT_RSI_PERIOD, ema, rsi, sma } from "@/lib/trading/indicators";
import {
  barChartTime,
  buildLineSeriesData,
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
//
// The toggle always carries a visible border and an explicit filled/empty
// dot, in both states - not just muted text that happens to be clickable.
// A control that looks identical to a static label when off isn't
// discoverable as a toggle at all, which is exactly the gap a real user
// hit: the period input next to it looks like "the" control, and there was
// nothing about the off-state button to suggest it does anything.
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
        aria-pressed={enabled}
        className={
          enabled
            ? `border-strong bg-selected flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium ${activeColorClassName}`
            : "border-default text-muted hover:text-fg hover:border-strong flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors"
        }
      >
        <span aria-hidden>{enabled ? "●" : "○"}</span>
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

    // Volume and RSI each get a genuinely separate pane (lightweight-charts'
    // own multi-pane support), not a second/third named price scale
    // squeezed into the same pane via scaleMargins - that overlay approach
    // was this component's first attempt, and a real screenshot showed why
    // it doesn't hold up: the volume series' own last-value label rendered
    // inside the price pane's own value band instead of staying confined to
    // volume's intended sliver, because a hidden (`visible: false`) price
    // scale's last-value badge doesn't respect the same scaleMargins
    // confinement its histogram bars do. Separate panes have no such shared-
    // coordinate-space subtlety: each pane is its own independent value
    // axis, which is what real chart panes are for. Panes share the same
    // time axis automatically, so the crosshair/timeScale code below needs
    // no changes for this.
    const priceHeight = 260;
    const volumeHeight = 80;
    const rsiHeight = 90;
    const totalHeight = priceHeight + volumeHeight + (rsiEnabled ? rsiHeight : 0);

    const chart = createChart(container, {
      width: container.clientWidth,
      height: totalHeight,
      // Without this, the time-axis tick formatter falls back to the
      // browser's own navigator.language, which produces mixed-language
      // labels (e.g. "Sep, Nov, 2026, Mär, Mai, Jul" on a 1Y range) whenever
      // that resolves inconsistently across ticks. Force it to match the
      // rest of the app, which is English-only.
      localization: { locale: "en-US" },
      layout: {
        background: { color: "transparent" },
        textColor: muted,
        // The library's own docs for this option are explicit: the
        // interactive logo exists specifically to satisfy the Apache-2.0
        // license's attribution requirement (their NOTICE file: a link to
        // https://www.tradingview.com/) - disabling it here is only
        // license-compliant because the static, non-interactive credit
        // below the chart (not layered on top of the candles/markers)
        // keeps that same link intact. Removing both would drop the
        // required attribution entirely, not just tidy up the UI.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: gridLine },
        horzLines: { color: gridLine },
      },
      timeScale: { borderColor: gridLine },
      rightPriceScale: {
        borderColor: gridLine,
        // Log scale applies only to the main price pane, never to volume
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

    // Pane 1 - its own independent value axis, not a second price scale
    // sharing pane 0's coordinate space (see the note above createChart).
    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" } }, 1);
    chart.panes()[1]?.setHeight(volumeHeight);
    chart.priceScale("right", 1).applyOptions({ borderColor: gridLine });

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
      // No axis label here - that badge is what collided with a recent
      // trade marker in a real screenshot (a sell near the current price
      // puts its "S 20" marker right where the avg-cost axis label also
      // renders, both fighting for the same on-canvas space around the
      // same price level). The dashed line itself stays as visual context;
      // the actual "Avg cost $X" text now lives in the fixed top-left
      // overlay below (avgCostReadout), which is plain HTML outside the
      // canvas entirely and so can never overlap a marker no matter where
      // in time or price that marker falls.
      candleSeries.createPriceLine({
        price: centsToDollars(avgCostCents),
        color: accent,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
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
      // buildLineSeriesData (tested in stockChartFormat.test.ts, including
      // this exact shape of case - a short valid run over a long bar array)
      // is what actually reaches lightweight-charts here, not a parallel
      // inline copy of the same logic. Points with no value yet are
      // omitted entirely, not plotted as 0 - the line starts once there's
      // enough data, same "null means unknown" convention indicators.ts uses.
      smaSeries.setData(
        buildLineSeriesData(bars, smaValues, timeframe).map((point) => ({
          time: point.time,
          value: point.value / 100,
        })),
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
        buildLineSeriesData(bars, emaValues, timeframe).map((point) => ({
          time: point.time,
          value: point.value / 100,
        })),
      );
    }

    if (rsiValues) {
      // Pane 2 - its own independent value axis, same reasoning as volume's
      // pane 1 above. Only created when RSI is actually enabled, which is
      // why totalHeight above only reserves space for it conditionally.
      const rsiSeries = chart.addSeries(
        LineSeries,
        {
          color: fg,
          lineWidth: 1,
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
        },
        2,
      );
      chart.panes()[2]?.setHeight(rsiHeight);
      chart.priceScale("right", 2).applyOptions({ borderColor: gridLine });
      // RSI is already 0-100, no /100 conversion needed - unlike SMA/EMA above.
      rsiSeries.setData(buildLineSeriesData(bars, rsiValues, timeframe));
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
              let title: string | undefined;
              if (disabled) {
                const reason =
                  timeframeIncompatibilityReason(range, tf) === "too-few-bars"
                    ? "too few bars to be useful"
                    : "too many bars to be useful";
                title = `${TIMEFRAME_LABELS[tf]} bars aren't shown over a ${range} range - ${reason}`;
              }
              return (
                <button
                  key={tf}
                  type="button"
                  disabled={disabled}
                  onClick={() => setTimeframe(tf)}
                  title={title}
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
          {isLoading && (
            <div
              className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
              aria-hidden
            >
              <div className="border-subtle border-t-accent size-6 animate-spin rounded-full border-2" />
            </div>
          )}
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
            {avgCostCents != null && (
              <span className="text-accent">
                Avg cost{" "}
                <span className="font-mono tabular-nums">${formatDollars(avgCostCents)}</span>
              </span>
            )}
          </div>
          <div ref={containerRef} />
        </div>
      )}
      {/* Apache-2.0 attribution for lightweight-charts: the interactive
          logo is turned off above (it was overlapping trade markers on the
          canvas), but the library's license still requires a link back to
          TradingView somewhere in the app - this static, non-canvas credit
          is that link, kept deliberately small and outside the chart area
          rather than removed outright. */}
      <div className="border-default border-t px-3 py-1 text-right">
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-subtle hover:text-muted text-[10px]"
        >
          Charts by TradingView
        </a>
      </div>
    </div>
  );
}
