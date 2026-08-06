"use client";

import { CandlestickSeries, createChart, type IChartApi } from "lightweight-charts";
import { useEffect, useRef } from "react";

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
};

export type StockChartProps = {
  bars: StockChartBar[];
};

function readThemeColor(variable: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

const CHART_HEIGHT = 300;

export function StockChart({ bars }: StockChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

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

    const chart = createChart(container, {
      width: container.clientWidth,
      height: CHART_HEIGHT,
      layout: { background: { color: "transparent" }, textColor: muted },
      grid: {
        vertLines: { color: gridLine },
        horzLines: { color: gridLine },
      },
      timeScale: { borderColor: gridLine },
      rightPriceScale: { borderColor: gridLine },
    });
    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: gain,
      downColor: loss,
      borderVisible: false,
      wickUpColor: gain,
      wickDownColor: loss,
    });

    series.setData(
      bars.map((bar) => ({
        time: bar.date,
        open: Number(BigInt(bar.openCents)) / 100,
        high: Number(BigInt(bar.highCents)) / 100,
        low: Number(BigInt(bar.lowCents)) / 100,
        close: Number(BigInt(bar.closeCents)) / 100,
      })),
    );

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
  }, [bars]);

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

  return <div ref={containerRef} className="border-default bg-panel rounded-lg border" />;
}
