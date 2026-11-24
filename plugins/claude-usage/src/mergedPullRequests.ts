import { execFile as nodeExecFile } from 'node:child_process'
import { z } from 'zod'
import { localDayOf, type DailySpend } from './dashboard'

const GH_TIMEOUT_MS = 30_000
const SEARCH_LIMIT = 1000
export const MERGED_PULL_REQUESTS_TTL_MS = 10 * 60_000

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void

/** GitHub searches by UTC date, so a local day can start on the UTC day before. */
export function mergedSearchArgs(sinceDay: string): string[] {
  const [year, month, dayOfMonth] = sinceDay.split('-').map(Number)
  const dayBefore = localDayOf(new Date(year!, month! - 1, dayOfMonth! - 1).getTime())
  return [
    'search',
    'prs',
    '--author=@me',
    '--merged',
    `--merged-at=>=${dayBefore}`,
    '--limit',
    String(SEARCH_LIMIT),
    '--json',
    'closedAt',
  ]
}

const searchResult = z.array(z.object({ closedAt: z.string() }))

export function parseMergedAt(stdout: string): number[] {
  return searchResult
    .parse(JSON.parse(stdout))
    .map((entry) => Date.parse(entry.closedAt))
    .filter((timestamp) => !Number.isNaN(timestamp))
}

export function createGhMergedPullRequestLoader(execFile: ExecFile = nodeExecFile as unknown as ExecFile) {
  return (sinceDay: string): Promise<number[]> =>
    new Promise((resolve, reject) => {
      execFile(
        'gh',
        mergedSearchArgs(sinceDay),
        { timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(String(stderr).trim() || error.message))
          try {
            resolve(parseMergedAt(String(stdout)))
          } catch (cause) {
            reject(cause)
          }
        },
      )
    })
}

export function withMergedPullRequests(series: DailySpend[], mergedAt: readonly number[] | null): DailySpend[] {
  if (!mergedAt) return series
  const perDay = new Map<string, number>()
  for (const timestamp of mergedAt) {
    const day = localDayOf(timestamp)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }
  return series.map((day) => ({ ...day, mergedPullRequests: perDay.get(day.day) ?? 0 }))
}

export interface MergedPullRequestCacheDependencies {
  load(sinceDay: string): Promise<number[]>
  now(): number
  onError?(message: string, error: unknown): void
}

/** `gh search` takes seconds per page, so a dashboard read never waits for it. */
export function createMergedPullRequestCache(dependencies: MergedPullRequestCacheDependencies) {
  let cached: { sinceDay: string; mergedAt: number[] | null; loadedAt: number } | null = null
  let inFlight: Promise<void> | null = null

  function reload(sinceDay: string): void {
    inFlight ??= dependencies
      .load(sinceDay)
      .then(
        (mergedAt) => {
          cached = { sinceDay, mergedAt, loadedAt: dependencies.now() }
        },
        (error) => {
          dependencies.onError?.('failed to read merged pull requests', error)
          cached = cached
            ? { ...cached, loadedAt: dependencies.now() }
            : { sinceDay, mergedAt: null, loadedAt: dependencies.now() }
        },
      )
      .finally(() => {
        inFlight = null
      })
  }

  return {
    mergedSince(sinceDay: string): number[] | null {
      const covers = cached !== null && cached.sinceDay <= sinceDay
      const fresh = covers && dependencies.now() - cached!.loadedAt < MERGED_PULL_REQUESTS_TTL_MS
      if (!fresh) reload(sinceDay)
      return cached?.mergedAt ?? null
    },
  }
}
