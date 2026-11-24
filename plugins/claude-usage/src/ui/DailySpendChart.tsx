import { useEffect, useRef } from "react";
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from "chart.js";
import type { DailySpend } from "../dashboard";
import {
  buildDailyChartData,
  CHART_SERIES,
  dayTotal,
  PULL_REQUEST_AXIS,
  pullRequestTooltipLine,
  tooltipLine,
  tooltipTitle,
  type ChartPalette,
} from "../dailyChartConfig";
import { formatMoney } from "../format";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip);

function readPalette(element: HTMLElement): ChartPalette {
  const styles = getComputedStyle(element);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    series: Object.fromEntries(CHART_SERIES.map((entry) => [entry.key, read(entry.cssVariable, entry.fallback)])),
    text: read("--foreground", "#1f2937"),
    grid: read("--border", "#e5e7eb"),
    surface: read("--background", "#ffffff"),
  };
}

function configuration(
  series: DailySpend[],
  palette: ChartPalette,
  showPullRequests: boolean,
): ChartConfiguration<"bar" | "line"> {
  const muted = `color-mix(in oklab, ${palette.text} 55%, transparent)`;
  return {
    type: "bar",
    data: buildDailyChartData(series, palette, showPullRequests),
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { color: palette.grid },
          ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 8 },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: palette.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: muted, font: { size: 10 }, padding: 6, callback: (value) => formatMoney(Number(value)) },
        },
        [PULL_REQUEST_AXIS]: {
          display: showPullRequests,
          position: "right",
          beginAtZero: true,
          grid: { display: false },
          border: { display: false },
          ticks: { color: muted, font: { size: 10 }, padding: 6, precision: 0 },
        },
      },
      plugins: {
        tooltip: {
          backgroundColor: palette.surface,
          titleColor: palette.text,
          bodyColor: palette.text,
          borderColor: palette.grid,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            title: (items) => tooltipTitle(series, items[0]?.dataIndex ?? -1),
            label: (item) =>
              item.dataset.yAxisID === PULL_REQUEST_AXIS
                ? pullRequestTooltipLine(item.parsed.y ?? 0)
                : tooltipLine(item.dataset.label ?? "", item.parsed.y ?? 0, dayTotal(series, item.dataIndex)),
          },
          filter: (item) => (item.parsed.y ?? 0) > 0,
        },
      },
    },
  };
}

export function DailySpendChart({
  series,
  label,
  showPullRequests,
}: {
  series: DailySpend[];
  label: string;
  showPullRequests: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target?.getContext("2d")) return;
    const chart = new Chart(target, configuration(series, readPalette(target), showPullRequests));
    return () => chart.destroy();
  }, [series, showPullRequests]);
  return (
    <div className="relative h-60">
      <canvas ref={canvas} aria-label={label} />
    </div>
  );
}
