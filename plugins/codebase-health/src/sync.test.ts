import { describe, expect, it } from 'vitest'
import type { SearchPage } from './github'
import { pullRequestsMergedSince, syncedDays } from './store'
import { daysToFetch, HISTORY_DAYS, syncRepository } from './sync'
import { migratedDatabase } from './testDatabase'

const NOW = Date.parse('2026-11-25T10:00:00Z')

function pageWith(number: number, mergedAt: string): SearchPage {
  return {
    issueCount: 1,
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      {
        number,
        createdAt: '2026-11-01T00:00:00Z',
        mergedAt,
        author: { login: 'dev' },
        labels: { nodes: [] },
        comments: { nodes: [] },
        reviews: { nodes: [] },
      },
    ],
  }
}

const emptyPage: SearchPage = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }

describe('daysToFetch', () => {
  it('reads the whole history newest first on the first sync', () => {
    const days = daysToFetch(new Set(), NOW)

    expect(days).toHaveLength(HISTORY_DAYS)
    expect(days.slice(0, 2)).toEqual(['2026-11-25', '2026-11-24'])
  })

  it('reads only the last three days again once history is synced', () => {
    const synced = new Set(daysToFetch(new Set(), NOW))

    expect(daysToFetch(synced, NOW)).toEqual(['2026-11-25', '2026-11-24', '2026-11-23'])
  })
})

describe('syncRepository', () => {
  it('stores the pull requests of each day and marks the day read', async () => {
    const db = migratedDatabase()
    const readPage = async (query: string) =>
      query.endsWith('merged:2026-11-24') ? pageWith(7, '2026-11-24T12:00:00Z') : emptyPage

    await syncRepository({ db, readPage, repo: 'a/b', now: NOW })

    expect(pullRequestsMergedSince(db, ['a/b'], 0).map((pr) => pr.number)).toEqual([7])
    expect(syncedDays(db, 'a/b').size).toBe(HISTORY_DAYS - 1)
    expect(syncedDays(db, 'a/b').has('2026-11-25')).toBe(false)
  })

  it('leaves a failed day unread so the next sync tries it again', async () => {
    const db = migratedDatabase()
    const readPage = async (query: string) => {
      if (query.endsWith('merged:2026-11-23')) throw new Error('rate limited')
      return emptyPage
    }

    await expect(syncRepository({ db, readPage, repo: 'a/b', now: NOW })).rejects.toThrow('rate limited')

    expect([...syncedDays(db, 'a/b')]).toEqual(['2026-11-24'])
  })

  it('replaces a pull request read again instead of counting it twice', async () => {
    const db = migratedDatabase()
    const readPage = async () => pageWith(7, '2026-11-25T08:00:00Z')

    await syncRepository({ db, readPage, repo: 'a/b', now: NOW })
    await syncRepository({ db, readPage, repo: 'a/b', now: NOW })

    expect(pullRequestsMergedSince(db, ['a/b'], 0)).toHaveLength(1)
  })

  it('rolls back a day that fails to save, so the next sync can write again', async () => {
    const db = migratedDatabase()
    const readPage = async () => pageWith(7, '2026-11-25T08:00:00Z')
    db.exec('ALTER TABLE pull_requests RENAME TO moved')

    await expect(syncRepository({ db, readPage, repo: 'a/b', now: NOW })).rejects.toThrow()
    db.exec('ALTER TABLE moved RENAME TO pull_requests')
    await syncRepository({ db, readPage, repo: 'a/b', now: NOW })

    expect(pullRequestsMergedSince(db, ['a/b'], 0)).toHaveLength(1)
  })

  it('reads a day again after downtime when it was read while still in progress', async () => {
    const db = migratedDatabase()
    let lateMerge = false
    const readPage = async (query: string) =>
      lateMerge && query.endsWith('merged:2026-11-25') ? pageWith(8, '2026-11-25T22:00:00Z') : emptyPage

    await syncRepository({ db, readPage, repo: 'a/b', now: NOW })
    lateMerge = true
    await syncRepository({ db, readPage, repo: 'a/b', now: NOW + 4 * 86_400_000 })

    expect(pullRequestsMergedSince(db, ['a/b'], 0).map((pr) => pr.number)).toEqual([8])
  })

  it('saves nothing for a day whose read was aborted', async () => {
    const db = migratedDatabase()
    const controller = new AbortController()
    let reads = 0
    const readPage = async () => {
      reads += 1
      if (reads === 3) controller.abort()
      return pageWith(reads, '2026-11-24T12:00:00Z')
    }

    await syncRepository({ db, readPage, repo: 'a/b', now: NOW, signal: controller.signal })

    expect([...syncedDays(db, 'a/b')]).toEqual(['2026-11-24'])
    expect(pullRequestsMergedSince(db, ['a/b'], 0).map((pr) => pr.number).sort()).toEqual([1, 2])
  })
})
