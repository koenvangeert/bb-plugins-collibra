import { execFile as nodeExecFile } from 'node:child_process'
import { z } from 'zod'
import { localDayOf, type DailySpend } from './dashboard'

const GH_TIMEOUT_MS = 30_000
const SEARCH_LIMIT = 1000
export const OPENED_PULL_REQUESTS_TTL_MS = 10 * 60_000

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void

/** GitHub searches by UTC date, so a local day can start on the UTC day before. */
export function openedSearchArgs(sinceDay: string): string[] {
  const [year, month, dayOfMonth] = sinceDay.split('-').map(Number)
  const dayBefore = localDayOf(new Date(year!, month! - 1, dayOfMonth! - 1).getTime())
  return [
    'search',
    'prs',
    '--author=@me',
    `--created=>=${dayBefore}`,
    '--limit',
    String(SEARCH_LIMIT),
    '--json',
    'createdAt',
  ]
}

const searchResult = z.array(z.object({ createdAt: z.string() }))

export function parseCreatedAt(stdout: string): number[] {
  return searchResult
    .parse(JSON.parse(stdout))
    .map((entry) => Date.parse(entry.createdAt))
    .filter((timestamp) => !Number.isNaN(timestamp))
}

export function createGhOpenedPullRequestLoader(execFile: ExecFile = nodeExecFile as unknown as ExecFile) {
  return (sinceDay: string): Promise<number[]> =>
    new Promise((resolve, reject) => {
      execFile(
        'gh',
        openedSearchArgs(sinceDay),
        { timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(String(stderr).trim() || error.message))
          try {
            resolve(parseCreatedAt(String(stdout)))
          } catch (cause) {
            reject(cause)
          }
        },
      )
    })
}

export function withOpenedPullRequests(series: DailySpend[], openedAt: readonly number[] | null): DailySpend[] {
  if (!openedAt) return series
  const perDay = new Map<string, number>()
  for (const timestamp of openedAt) {
    const day = localDayOf(timestamp)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }
  return series.map((day) => ({ ...day, openedPullRequests: perDay.get(day.day) ?? 0 }))
}

export interface OpenedPullRequestCacheDependencies {
  load(sinceDay: string): Promise<number[]>
  now(): number
  onError?(message: string, error: unknown): void
}

/** `gh search` takes seconds per page, so a dashboard read never waits for it. */
export function createOpenedPullRequestCache(dependencies: OpenedPullRequestCacheDependencies) {
  let cached: { sinceDay: string; openedAt: number[] | null; loadedAt: number } | null = null
  let inFlight: Promise<void> | null = null

  function reload(sinceDay: string): void {
    inFlight ??= dependencies
      .load(sinceDay)
      .then(
        (openedAt) => {
          cached = { sinceDay, openedAt, loadedAt: dependencies.now() }
        },
        (error) => {
          dependencies.onError?.('failed to read opened pull requests', error)
          cached = cached
            ? { ...cached, loadedAt: dependencies.now() }
            : { sinceDay, openedAt: null, loadedAt: dependencies.now() }
        },
      )
      .finally(() => {
        inFlight = null
      })
  }

  return {
    openedSince(sinceDay: string): number[] | null {
      const covers = cached !== null && cached.sinceDay <= sinceDay
      const fresh = covers && dependencies.now() - cached!.loadedAt < OPENED_PULL_REQUESTS_TTL_MS
      if (!fresh) reload(sinceDay)
      return cached?.openedAt ?? null
    },
  }
}
