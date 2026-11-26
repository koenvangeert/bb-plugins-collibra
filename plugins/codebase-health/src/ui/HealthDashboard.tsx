import { useCallback, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { deviationBadge, formatDayLabel, formatDecimal, formatHours, formatShare, type Badge, type Tone } from "../format";
import { WINDOW_DAYS, type GroupStats, type WindowDays } from "../metrics";
import { ME } from "../me";
import type { Dashboard, rpcContract } from "../rpc";
import {
  BASELINE_LABEL,
  CHART_VIEWS,
  DAILY_LABEL,
  DailyChart,
  MERGED_SERIES,
  repoColor,
  repoName,
  ROLLING_LABEL,
  TREND_FALLBACK,
  type ChartMetric,
} from "./DailyChart";
import { usePolled } from "./usePolled";

function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        {aside ? <div className="text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  better: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  worse: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  neutral: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

function DeviationBadge({ badge }: { badge: Badge }) {
  return (
    <span
      data-tone={badge.tone}
      className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${TONE_CLASS[badge.tone]}`}
    >
      {badge.arrow ? <span aria-hidden>{badge.arrow}</span> : null}
      {badge.text}
    </span>
  );
}

function Tiles({
  dashboard,
  chart,
  onChart,
}: {
  dashboard: Dashboard;
  chart: ChartMetric;
  onChart(metric: ChartMetric): void;
}) {
  const { metrics, baseline } = dashboard;
  const points = (share: number) => `${Math.round(share * 100)} pts`;
  const tiles: { metric: ChartMetric; label: string; value: string; note: string; badge: Badge | null }[] = [
    {
      metric: "merged",
      label: "Merged per work day",
      value: formatDecimal(metrics.mergedPerDay),
      note: `${metrics.all.merged} merged`,
      badge: baseline?.all.merged
        ? { text: `${formatShare(metrics.all.merged / baseline.all.merged)} of all merges`, tone: "neutral", arrow: null }
        : null,
    },
    {
      metric: "comments",
      label: "Reviewer comments per PR",
      value: formatDecimal(metrics.all.avgReviewerComments),
      note: "Not by bots or the author",
      badge: baseline
        ? deviationBadge(metrics.all.avgReviewerComments, baseline.all.avgReviewerComments, "lower", formatDecimal)
        : null,
    },
    {
      metric: "timeToMerge",
      label: "Time to merge",
      value: formatHours(metrics.all.medianHoursToMerge),
      note: `Median · mean ${formatHours(metrics.all.avgHoursToMerge)}`,
      badge: baseline
        ? deviationBadge(metrics.all.medianHoursToMerge, baseline.all.medianHoursToMerge, "lower", formatHours)
        : null,
    },
    {
      metric: "bettyShare",
      label: "Made by BETTY",
      value: formatShare(metrics.bettyShare),
      note: `${metrics.betty.merged} of ${metrics.all.merged}`,
      badge: baseline ? deviationBadge(metrics.bettyShare, baseline.bettyShare, "higher", points, formatShare) : null,
    },
  ];
  return (
    <section aria-label="Totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <button
          key={tile.metric}
          type="button"
          aria-pressed={tile.metric === chart}
          onClick={() => onChart(tile.metric)}
          className={`cursor-pointer rounded-lg border bg-card p-4 text-left hover:bg-accent/40 ${
            tile.metric === chart ? "border-primary ring-1 ring-primary" : "border-border"
          }`}
        >
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{tile.label}</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{tile.value}</div>
          {tile.badge ? <DeviationBadge badge={tile.badge} /> : null}
          <div className="mt-1 text-xs text-muted-foreground">{tile.note}</div>
        </button>
      ))}
    </section>
  );
}

const COMPARISON_ROWS: {
  label: string;
  value: (stats: GroupStats) => string;
}[] = [
  { label: "Pull requests merged", value: (stats) => String(stats.merged) },
  {
    label: "Reviewer comments per PR",
    value: (stats) => formatDecimal(stats.avgReviewerComments),
  },
  {
    label: "Median time to merge",
    value: (stats) => formatHours(stats.medianHoursToMerge),
  },
  {
    label: "Mean time to merge",
    value: (stats) => formatHours(stats.avgHoursToMerge),
  },
];

function Comparison({ dashboard }: { dashboard: Dashboard }) {
  const columns = [
    { label: "BETTY", stats: dashboard.metrics.betty },
    { label: "Others", stats: dashboard.metrics.other },
    { label: "All", stats: dashboard.metrics.all },
  ];
  return (
    <Panel title="BETTY against others">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-1 font-medium" />
            {columns.map((column) => (
              <th key={column.label} className="py-1 text-right font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARISON_ROWS.map((row) => (
            <tr key={row.label} className="border-t border-border">
              <th scope="row" className="py-1.5 text-left font-normal">
                {row.label}
              </th>
              {columns.map((column) => (
                <td key={column.label} className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {row.value(column.stats)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

const SWATCH = "size-2.5 rounded-sm";
const LINE = "h-0.5 w-3 rounded-full";
const trendColor = `var(--chart-1, ${TREND_FALLBACK})`;

type LegendEntry = { label: string; className: string; style?: CSSProperties };

const repoSwatch = (index: number) => ({ background: `var(${repoColor(index).cssVariable}, ${repoColor(index).fallback})` });

function legendOf(chart: ChartMetric, team: string | null, repos: string[] | null): LegendEntry[] {
  const baselineEntry = team
    ? [{ label: BASELINE_LABEL, className: "w-3 border-t-2 border-dashed border-muted-foreground" }]
    : [];
  if (repos && chart === "merged") {
    return [
      ...repos.map((repo, index) => ({ label: repoName(repo), className: SWATCH, style: repoSwatch(index) })),
      { label: ROLLING_LABEL, className: `${LINE} bg-foreground` },
    ];
  }
  if (repos) {
    return [
      ...repos.map((repo, index) => ({
        label: `${repoName(repo)}: ${ROLLING_LABEL}`,
        className: "h-1 w-3 rounded-full",
        style: repoSwatch(index),
      })),
      { label: `${DAILY_LABEL} (faint)`, className: `${LINE} bg-muted-foreground opacity-40` },
      ...baselineEntry,
    ];
  }
  if (chart === "merged") {
    return [
      ...MERGED_SERIES.map((series) => ({
        label: series.label,
        className: SWATCH,
        style: { background: `var(${series.cssVariable}, ${series.fallback})` },
      })),
      { label: ROLLING_LABEL, className: `${LINE} bg-foreground` },
    ];
  }
  const ofTeam = (label: string) => (team ? `${team}: ${label}` : label);
  return [
    { label: ofTeam(DAILY_LABEL), className: `${LINE} opacity-40`, style: { background: trendColor } },
    { label: ofTeam(ROLLING_LABEL), className: "h-1 w-3 rounded-full", style: { background: trendColor } },
    ...baselineEntry,
  ];
}

function teamLabel(team: string, viewer: string | null): string {
  return team === ME ? `Me (${viewer})` : team.split("/").at(-1)!;
}

function DailyPanel({ dashboard, chart }: { dashboard: Dashboard; chart: ChartMetric }) {
  const { daily } = dashboard.metrics;
  const { title } = CHART_VIEWS[chart];
  const range = daily.length ? `${formatDayLabel(daily[0]!.day)} to ${formatDayLabel(daily.at(-1)!.day)}` : "";
  return (
    <Panel title={title} aside={range}>
      <DailyChart
        daily={daily}
        baseline={dashboard.baseline?.daily ?? null}
        byRepo={dashboard.byRepo}
        metric={chart}
        label={`${title} from ${range}`}
      />
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        {legendOf(
          chart,
          dashboard.team && dashboard.baseline ? teamLabel(dashboard.team, dashboard.viewer) : null,
          dashboard.byRepo?.map((series) => series.repo) ?? null,
        ).map((entry) => (
          <span key={entry.label} className="flex items-center gap-1.5">
            <span className={entry.className} style={entry.style} />
            {entry.label}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function Controls({
  dashboard,
  windowDays,
  onWindowDays,
  onRepo,
  onTeam,
}: {
  dashboard: Dashboard | null;
  windowDays: WindowDays;
  onWindowDays(days: WindowDays): void;
  onRepo(repo: string | null): void;
  onTeam(team: string | null): void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex gap-1" role="group" aria-label="Period">
        {WINDOW_DAYS.map((days) => (
          <Button
            key={days}
            size="sm"
            variant={days === windowDays ? "secondary" : "ghost"}
            aria-pressed={days === windowDays}
            onClick={() => onWindowDays(days)}
          >
            {`${days} days`}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {dashboard && dashboard.teams.length > 0 ? (
          <select
            aria-label="Team"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={dashboard.team ?? ""}
            onChange={(event) => onTeam(event.target.value || null)}
          >
            <option value="">All teams</option>
            {dashboard.teams.map((team) => (
              <option key={team} value={team}>
                {teamLabel(team, dashboard.viewer)}
              </option>
            ))}
          </select>
        ) : null}
        {dashboard && dashboard.repos.length > 1 ? (
          <select
            aria-label="Repository"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={dashboard.repo ?? ""}
            onChange={(event) => onRepo(event.target.value || null)}
          >
            <option value="">All repositories</option>
            {dashboard.repos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-muted-foreground">{dashboard?.repos[0]}</span>
        )}
      </div>
    </div>
  );
}

function SyncNotes({ dashboard }: { dashboard: Dashboard }) {
  const complete = dashboard.historyDaysRead >= dashboard.historyDaysTotal;
  return (
    <>
      {dashboard.errors.map((error) => (
        <p key={error.repo} role="alert" className="m-0 text-sm text-destructive">
          Cannot read {error.repo} from GitHub: {error.message}
        </p>
      ))}
      {complete ? null : (
        <p role="status" className="m-0 text-sm text-muted-foreground">
          {`Reading history from GitHub: ${dashboard.historyDaysRead} of ${dashboard.historyDaysTotal} days. Older days fill in as they arrive.`}
        </p>
      )}
    </>
  );
}

export function HealthDashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const [repo, setRepo] = useState<string | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartMetric>("merged");
  const load = useCallback(() => rpc.call("dashboard", { windowDays, repo, team }), [rpc, windowDays, repo, team]);
  const { value: dashboard, error } = usePolled(load);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border flex w-full max-w-6xl flex-col gap-6 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <Controls
          dashboard={dashboard}
          windowDays={windowDays}
          onWindowDays={setWindowDays}
          onRepo={setRepo}
          onTeam={setTeam}
        />
        {error !== null ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            Cannot load codebase health: {error}
          </p>
        ) : null}
        {dashboard === null ? (
          error === null ? (
            <p role="status" className="m-0 text-sm text-muted-foreground">
              Loading codebase health…
            </p>
          ) : null
        ) : (
          <>
            <SyncNotes dashboard={dashboard} />
            <Tiles dashboard={dashboard} chart={chart} onChart={setChart} />
            <DailyPanel dashboard={dashboard} chart={chart} />
            <Comparison dashboard={dashboard} />
            <p className="m-0 text-xs text-muted-foreground">
              Merged pull requests only. A BETTY pull request has the betty-pr-factory-app label. Reviewer comments
              count conversation comments, review summaries and inline comments, but not those of bots or of the author.
              A team is a GitHub team named in the repository's CODEOWNERS; its pull requests are those its members
              wrote. Time to merge runs from opening to merge, without weekend hours.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
