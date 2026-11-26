import type { MergedPullRequest } from './pullRequest'

export const WINDOW_DAYS = [7, 30, 90] as const
export type WindowDays = (typeof WINDOW_DAYS)[number]

export interface GroupStats {
  merged: number
  avgReviewerComments: number | null
  medianHoursToMerge: number | null
  avgHoursToMerge: number | null
}

export interface RollingFigures {
  mergedPerDay: number
  avgReviewerComments: number | null
  medianHoursToMerge: number | null
  bettyShare: number | null
}

export interface DailyFigures {
  day: string
  betty: number
  other: number
  avgReviewerComments: number | null
  medianHoursToMerge: number | null
  /** Over the last `ROLLING_WORK_DAYS` work days, this one included. */
  rolling: RollingFigures
}

export interface HealthMetrics {
  daily: DailyFigures[]
  mergedPerDay: number
  bettyShare: number | null
  all: GroupStats
  betty: GroupStats
  other: GroupStats
}

const HOUR_MS = 3_600_000

const isWeekend = (date: Date) => date.getDay() === 0 || date.getDay() === 6

/** Weekend hours are left out, or every pull request open over a weekend makes Monday look slow. */
export function workHoursBetween(start: number, end: number): number {
  let workMs = 0
  for (let cursor = start; cursor < end; ) {
    const date = new Date(cursor)
    const nextMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
    const segmentEnd = Math.min(nextMidnight, end)
    if (!isWeekend(date)) workMs += segmentEnd - cursor
    cursor = segmentEnd
  }
  return workMs / HOUR_MS
}

export function localDayOf(timestamp: number): string {
  const date = new Date(timestamp)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function windowStart(now: number, windowDays: number): number {
  const today = new Date(now)
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - (windowDays - 1)).getTime()
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function groupStats(pullRequests: readonly MergedPullRequest[]): GroupStats {
  const hoursToMerge = pullRequests.map((pr) => workHoursBetween(pr.createdAt, pr.mergedAt))
  return {
    merged: pullRequests.length,
    avgReviewerComments: mean(pullRequests.map((pr) => pr.reviewerComments)),
    medianHoursToMerge: median(hoursToMerge),
    avgHoursToMerge: mean(hoursToMerge),
  }
}

/** One work week. */
export const ROLLING_WORK_DAYS = 5
/** Calendar days before the window that hold the first rolling window's earlier work days. */
export const ROLLING_LEAD_DAYS = 7

/** The pull requests `buildMetrics` needs start this early, so the first days get a full rolling window. */
export function metricsStart(now: number, windowDays: number): number {
  return windowStart(now, windowDays + ROLLING_LEAD_DAYS)
}

function figuresOf(merged: readonly MergedPullRequest[]): Omit<DailyFigures, 'day' | 'rolling'> {
  const stats = groupStats(merged)
  const betty = merged.filter((pr) => pr.isBetty).length
  return {
    betty,
    other: merged.length - betty,
    avgReviewerComments: stats.avgReviewerComments,
    medianHoursToMerge: stats.medianHoursToMerge,
  }
}

export function buildMetrics(pullRequests: readonly MergedPullRequest[], now: number, windowDays: number): HealthMetrics {
  const start = windowStart(now, windowDays)
  const inWindow = pullRequests.filter((pr) => pr.mergedAt >= start && pr.mergedAt <= now)
  const leadDate = new Date(metricsStart(now, windowDays))
  const mergedByDay = new Map<string, MergedPullRequest[]>()
  for (const pr of pullRequests.filter((entry) => entry.mergedAt <= now)) {
    const day = localDayOf(pr.mergedAt)
    mergedByDay.set(day, [...(mergedByDay.get(day) ?? []), pr])
  }
  const allWorkDays = Array.from(
    { length: windowDays + ROLLING_LEAD_DAYS },
    (_, offset) => new Date(leadDate.getFullYear(), leadDate.getMonth(), leadDate.getDate() + offset),
  )
    .filter((date) => !isWeekend(date))
    .map((date) => localDayOf(date.getTime()))
  const firstShown = allWorkDays.findIndex((day) => day >= localDayOf(start))
  const daily: DailyFigures[] = allWorkDays.slice(firstShown).map((day, offset) => {
    const index = firstShown + offset
    const rollingDays = allWorkDays.slice(Math.max(0, index - ROLLING_WORK_DAYS + 1), index + 1)
    const rollingMerged = rollingDays.flatMap((rollingDay) => mergedByDay.get(rollingDay) ?? [])
    const rolling = figuresOf(rollingMerged)
    return {
      day,
      ...figuresOf(mergedByDay.get(day) ?? []),
      rolling: {
        mergedPerDay: rollingMerged.length / rollingDays.length,
        avgReviewerComments: rolling.avgReviewerComments,
        medianHoursToMerge: rolling.medianHoursToMerge,
        bettyShare: rollingMerged.length === 0 ? null : rolling.betty / rollingMerged.length,
      },
    }
  })
  const workDays = daily.length
  const betty = inWindow.filter((pr) => pr.isBetty)
  const other = inWindow.filter((pr) => !pr.isBetty)
  return {
    daily,
    mergedPerDay: workDays === 0 ? 0 : inWindow.length / workDays,
    bettyShare: inWindow.length === 0 ? null : betty.length / inWindow.length,
    all: groupStats(inWindow),
    betty: groupStats(betty),
    other: groupStats(other),
  }
}
