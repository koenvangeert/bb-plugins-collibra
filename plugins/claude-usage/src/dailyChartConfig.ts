import type { CostBreakdown } from './pricing'
import type { DailySpend } from './dashboard'
import { formatDayLabel, formatMoney } from './format'

export const DAILY_SERIES_DAYS = 30

export interface ChartSeries {
  key: keyof CostBreakdown
  label: string
  cssVariable: string
  /** Painted when the theme does not define `cssVariable`, so no segment is ever blank. */
  fallback: string
}

export const CHART_SERIES: readonly ChartSeries[] = [
  { key: 'cacheRead', label: 'Cache read', cssVariable: '--chart-1', fallback: '#3b82f6' },
  { key: 'cacheWrite', label: 'Cache write', cssVariable: '--chart-2', fallback: '#14b8a6' },
  { key: 'output', label: 'Output', cssVariable: '--chart-3', fallback: '#f59e0b' },
  { key: 'input', label: 'Input', cssVariable: '--chart-4', fallback: '#a855f7' },
]

export interface ChartPalette {
  series: Record<string, string>
  text: string
  grid: string
  surface: string
}

export const MERGED_PULL_REQUESTS_LABEL = 'Merged PRs'
export const PULL_REQUEST_AXIS = 'pullRequests'

interface SpendDataset {
  type: 'bar'
  label: string
  data: number[]
  backgroundColor: string
  borderWidth: number
  borderRadius: number
  stack: string
}

interface PullRequestDataset {
  type: 'line'
  label: string
  data: number[]
  borderColor: string
  backgroundColor: string
  borderWidth: number
  pointRadius: number
  yAxisID: string
  order: number
}

export interface DailyChartData {
  labels: string[]
  datasets: Array<SpendDataset | PullRequestDataset>
}

/**
 * Stacked bottom-up, so the series order here is the visual order from the axis
 * upward and reversing it would put the largest slice on top.
 */
export function buildDailyChartData(
  series: DailySpend[],
  palette: ChartPalette,
  showPullRequests: boolean,
): DailyChartData {
  const spend: SpendDataset[] = CHART_SERIES.map((entry) => ({
    type: 'bar',
    label: entry.label,
    data: series.map((day) => day.breakdown[entry.key]),
    backgroundColor: palette.series[entry.key] ?? palette.text,
    borderWidth: 0,
    borderRadius: 2,
    stack: 'spend',
  }))
  const pullRequests: PullRequestDataset = {
    type: 'line',
    label: MERGED_PULL_REQUESTS_LABEL,
    data: series.map((day) => day.mergedPullRequests),
    borderColor: palette.text,
    backgroundColor: palette.text,
    borderWidth: 2,
    pointRadius: 2,
    yAxisID: PULL_REQUEST_AXIS,
    order: -1,
  }
  return {
    labels: series.map((day) => formatDayLabel(day.day)),
    datasets: showPullRequests ? [...spend, pullRequests] : spend,
  }
}

export interface DailyWindow {
  days: DailySpend[]
  windowsBack: number
  hasOlder: boolean
  hasNewer: boolean
}

export function dailyWindow(series: DailySpend[], windowsBack: number): DailyWindow {
  const oldest = Math.max(0, series.length / DAILY_SERIES_DAYS - 1)
  const clamped = Math.min(Math.max(0, windowsBack), oldest)
  const end = series.length - clamped * DAILY_SERIES_DAYS
  return {
    days: series.slice(end - DAILY_SERIES_DAYS, end),
    windowsBack: clamped,
    hasOlder: clamped < oldest,
    hasNewer: clamped > 0,
  }
}

export function dayTotal(series: DailySpend[], index: number): number {
  return series[index]?.total ?? 0
}

export function tooltipTitle(series: DailySpend[], index: number): string {
  const day = series[index]
  if (!day) return ''
  return `${formatDayLabel(day.day)} · ${formatMoney(day.total)}`
}

export function tooltipLine(label: string, value: number, total: number): string {
  if (value <= 0) return ''
  const share = total > 0 ? Math.round((value / total) * 100) : 0
  return `${label}: ${formatMoney(value)} (${share}%)`
}

export function pullRequestTooltipLine(count: number): string {
  return count > 0 ? `${MERGED_PULL_REQUESTS_LABEL}: ${count}` : ''
}
