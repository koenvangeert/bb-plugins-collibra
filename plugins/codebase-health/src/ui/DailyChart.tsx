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
import { formatDecimal, formatHours, formatShare, formatWeekdayLabel } from "../format";
import { ROLLING_WORK_DAYS, type DailyFigures } from "../metrics";

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
);

export const ROLLING_LABEL = `${ROLLING_WORK_DAYS}-day average`;
export const BASELINE_LABEL = `All teams, ${ROLLING_LABEL}`;
export const DAILY_LABEL = "Daily";
export const TREND_FALLBACK = "#3b82f6";

export type ChartMetric = "merged" | "comments" | "timeToMerge" | "bettyShare";

export const REPO_COLORS = [
  { cssVariable: "--chart-1", fallback: "#3b82f6" },
  { cssVariable: "--chart-3", fallback: "#f59e0b" },
  { cssVariable: "--chart-2", fallback: "#14b8a6" },
  { cssVariable: "--chart-4", fallback: "#a855f7" },
  { cssVariable: "--chart-5", fallback: "#ef4444" },
] as const;

export interface RepoSeries {
  repo: string;
  daily: DailyFigures[];
}

export const repoName = (repo: string) => repo.split("/").at(-1)!;
export const repoColor = (index: number) => REPO_COLORS[index % REPO_COLORS.length]!;

export const MERGED_SERIES = [
  { key: "other", label: "Others", cssVariable: "--chart-1", fallback: "#3b82f6" },
  { key: "betty", label: "BETTY", cssVariable: "--chart-2", fallback: "#14b8a6" },
] as const satisfies readonly { key: "betty" | "other"; label: string; cssVariable: string; fallback: string }[];

type TrendView = {
  kind: "trend";
  title: string;
  value(day: DailyFigures): number | null;
  rolling(day: DailyFigures): number | null;
  format(value: number): string;
  max?: number;
};

export const CHART_VIEWS: Record<ChartMetric, { kind: "merged"; title: string } | TrendView> = {
  merged: { kind: "merged", title: "Merged pull requests per day" },
  comments: {
    kind: "trend",
    title: "Reviewer comments per PR, by day of merge",
    value: (day) => day.avgReviewerComments,
    rolling: (day) => day.rolling.avgReviewerComments,
    format: formatDecimal,
  },
  timeToMerge: {
    kind: "trend",
    title: "Median time to merge, by day of merge",
    value: (day) => day.medianHoursToMerge,
    rolling: (day) => day.rolling.medianHoursToMerge,
    format: formatHours,
  },
  bettyShare: {
    kind: "trend",
    title: "Share made by BETTY, by day of merge",
    value: (day) => (day.betty + day.other === 0 ? null : day.betty / (day.betty + day.other)),
    rolling: (day) => day.rolling.bettyShare,
    format: formatShare,
    max: 1,
  },
};

export interface Palette {
  read(name: string, fallback: string): string;
  text: string;
  grid: string;
  surface: string;
  muted: string;
}

function readPalette(element: HTMLElement): Palette {
  const styles = getComputedStyle(element);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const text = read("--foreground", "#1f2937");
  return {
    read,
    text,
    grid: read("--border", "#e5e7eb"),
    surface: read("--background", "#ffffff"),
    muted: `color-mix(in oklab, ${text} 55%, transparent)`,
  };
}

const mergedCount = (day: DailyFigures | undefined) => (day ? day.betty + day.other : 0);

export function chartConfiguration(
  daily: DailyFigures[],
  metric: ChartMetric,
  palette: Palette,
  baseline: DailyFigures[] | null = null,
  byRepo: RepoSeries[] | null = null,
): ChartConfiguration<"bar" | "line"> {
  const view = CHART_VIEWS[metric];
  const stacked = view.kind === "merged";
  const tooltip = {
    backgroundColor: palette.surface,
    titleColor: palette.text,
    bodyColor: palette.text,
    footerColor: palette.text,
    borderColor: palette.grid,
    borderWidth: 1,
    padding: 10,
  };
  const axes = {
    x: {
      stacked,
      grid: { display: false },
      border: { color: palette.grid },
      ticks: { color: palette.muted, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 8 },
    },
    y: {
      stacked,
      beginAtZero: true,
      max: stacked ? undefined : view.max,
      grid: { color: palette.grid, drawTicks: false },
      border: { display: false },
      ticks: {
        color: palette.muted,
        font: { size: 10 },
        padding: 6,
        precision: stacked ? 0 : undefined,
        callback: (value: string | number) => (stacked ? String(value) : view.format(Number(value))),
      },
    },
  };
  const labels = daily.map((entry) => formatWeekdayLabel(entry.day));
  if (view.kind === "merged") {
    return {
      type: "bar",
      data: {
        labels,
        datasets: [
          ...(byRepo
            ? byRepo.map((series, index) => ({
                label: repoName(series.repo),
                data: series.daily.map((entry) => entry.betty + entry.other),
                color: palette.read(repoColor(index).cssVariable, repoColor(index).fallback),
              }))
            : MERGED_SERIES.map((series) => ({
                label: series.label,
                data: daily.map((entry) => entry[series.key]),
                color: palette.read(series.cssVariable, series.fallback),
              }))
          ).map((series) => ({
            label: series.label,
            data: series.data,
            backgroundColor: series.color,
            borderColor: palette.surface,
            borderWidth: { top: 2 },
            borderRadius: 4,
            borderSkipped: "bottom" as const,
            type: "bar" as const,
            maxBarThickness: 24,
            order: 2,
          })),
          {
            type: "line" as const,
            label: ROLLING_LABEL,
            data: daily.map((entry) => entry.rolling.mergedPerDay),
            borderColor: palette.text,
            backgroundColor: palette.text,
            borderWidth: 2,
            pointRadius: 0,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: { mode: "index", intersect: false },
        scales: axes,
        plugins: {
          tooltip: {
            ...tooltip,
            callbacks: {
              label: (item) =>
                `${item.dataset.label}: ${item.dataset.type === "line" ? formatDecimal(item.parsed.y ?? 0) : item.parsed.y}`,
              footer: (items) => `Total: ${mergedCount(daily[items[0]?.dataIndex ?? -1])}`,
            },
          },
        },
      },
    };
  }
  const lines = (byRepo ?? [{ repo: "", daily }]).flatMap((series, index) => {
    const color = byRepo
      ? palette.read(repoColor(index).cssVariable, repoColor(index).fallback)
      : palette.read("--chart-1", TREND_FALLBACK);
    const faded = `color-mix(in oklab, ${color} 40%, transparent)`;
    const named = (label: string) => (byRepo ? `${repoName(series.repo)}: ${label}` : label);
    return [
      {
        label: named(DAILY_LABEL),
        data: series.daily.map(view.value),
        borderColor: faded,
        backgroundColor: faded,
        borderWidth: 1,
        pointRadius: 3,
        spanGaps: true,
      },
      {
        label: named(ROLLING_LABEL),
        data: series.daily.map(view.rolling),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 3,
        pointRadius: 0,
        spanGaps: true,
      },
    ];
  });
  const baselineLine = baseline
    ? [
        {
          label: BASELINE_LABEL,
          data: baseline.map(view.rolling),
          borderColor: palette.muted,
          backgroundColor: palette.muted,
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 0,
          spanGaps: true,
        },
      ]
    : [];
  return {
    type: "line",
    data: {
      labels,
      datasets: [...lines, ...baselineLine],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      interaction: { mode: "index", intersect: false },
      scales: axes,
      plugins: {
        tooltip: {
          ...tooltip,
          callbacks: {
            label: (item) => `${item.dataset.label}: ${view.format(item.parsed.y ?? 0)}`,
            footer: (items) => `${mergedCount(daily[items[0]?.dataIndex ?? -1])} merged`,
          },
        },
      },
    },
  };
}

export function DailyChart({
  daily,
  baseline,
  byRepo,
  metric,
  label,
}: {
  daily: DailyFigures[];
  baseline: DailyFigures[] | null;
  byRepo: RepoSeries[] | null;
  metric: ChartMetric;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target?.getContext("2d")) return;
    const chart = new Chart(target, chartConfiguration(daily, metric, readPalette(target), baseline, byRepo));
    return () => chart.destroy();
  }, [daily, metric, baseline, byRepo]);
  return (
    <div className="relative h-60">
      <canvas ref={canvas} aria-label={label} />
    </div>
  );
}
