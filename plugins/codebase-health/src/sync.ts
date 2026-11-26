import { ROLLING_LEAD_DAYS, WINDOW_DAYS } from './metrics'
import type { SqlDatabase } from './database'
import { fetchMergedOn, type ReadSearchPage } from './github'
import { markDaySynced, savePullRequests, syncedDays } from './store'

const DAY_MS = 86_400_000
/** The longest window, its rolling lead days, and one more: a local day east of UTC starts on the UTC day before. */
export const HISTORY_DAYS = Math.max(...WINDOW_DAYS) + ROLLING_LEAD_DAYS + 1
/** Reviewers still comment for a while after a merge, so the newest days are read again. */
export const REREAD_DAYS = 3

export function utcDayOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function historyDays(now: number): string[] {
  return Array.from({ length: HISTORY_DAYS }, (_, back) => utcDayOf(now - back * DAY_MS))
}

/** A day still in progress is never marked read, or merges after the read would be lost once it leaves the re-read days. */
export function dayIsOver(utcDay: string, now: number): boolean {
  return Date.parse(`${utcDay}T00:00:00Z`) + DAY_MS <= now
}

/** Newest first, so a first sync fills the recent part of the dashboard before the old part. */
export function daysToFetch(synced: ReadonlySet<string>, now: number): string[] {
  return historyDays(now).filter((day, back) => back < REREAD_DAYS || !synced.has(day))
}

export async function syncRepository(options: {
  db: SqlDatabase
  readPage: ReadSearchPage
  repo: string
  now: number
  signal?: AbortSignal
}): Promise<void> {
  const { db, readPage, repo, now, signal } = options
  for (const day of daysToFetch(syncedDays(db, repo), now)) {
    if (signal?.aborted) return
    const merged = await fetchMergedOn(readPage, repo, day, signal)
    if (signal?.aborted) return
    db.exec('BEGIN')
    try {
      savePullRequests(db, merged)
      if (dayIsOver(day, now)) markDaySynced(db, repo, day)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
