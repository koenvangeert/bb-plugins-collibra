import { describe, expect, it } from 'vitest'
import type { ReadSearchPage, SearchPage } from './github'
import { createHealthService, type HealthServiceDependencies } from './healthService'
import { savePullRequests } from './store'
import { HISTORY_DAYS } from './sync'
import { migratedDatabase } from './testDatabase'

const NOW = new Date(2026, 10, 25, 15, 0).getTime()
const emptyPage: SearchPage = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }

function service(
  readPage: ReadSearchPage,
  repos = ['a/one', 'a/two'],
  overrides: Partial<HealthServiceDependencies> = {},
) {
  const db = migratedDatabase()
  let currentRepos = repos
  const health = createHealthService({
    db,
    readPage,
    readTeamMembers: async () => [],
    readViewer: async () => 'me-login',
    readRepos: async () => currentRepos,
    now: () => NOW,
    ...overrides,
  })
  return { db, health, setRepos: (next: string[]) => (currentRepos = next) }
}

const merged = (repo: string, number: number, author = 'dev') => ({
  repo,
  number,
  author,
  createdAt: NOW - 3_600_000,
  mergedAt: NOW - 1_000,
  isBetty: false,
  reviewerComments: 1,
})

describe('health service', () => {
  it('shows one repository when one is picked, and all configured ones otherwise', async () => {
    const { db, health } = service(async () => emptyPage)
    savePullRequests(db, [merged('a/one', 1), merged('a/two', 2), merged('a/gone', 3)])

    const all = await health.dashboard({ windowDays: 7, repo: null, team: null })
    const one = await health.dashboard({ windowDays: 7, repo: 'a/one', team: null })

    expect(all.metrics.all.merged).toBe(2)
    expect(all.byRepo?.map((series) => [series.repo, series.daily.at(-1)!.other])).toEqual([
      ['a/one', 1],
      ['a/two', 1],
    ])
    expect(one.byRepo).toBeNull()
    expect(one.repo).toBe('a/one')
    expect(one.metrics.all.merged).toBe(1)
  })

  it('shows only the pull requests written by members of the picked team', async () => {
    const teams = { 'a/one': [{ team: 'org/ui', login: 'ann' }, { team: 'org/api', login: 'bob' }] }
    const { db, health } = service(async () => emptyPage, ['a/one'], {
      readTeamMembers: async (repo) => teams[repo as keyof typeof teams] ?? [],
    })
    savePullRequests(db, [merged('a/one', 1, 'ann'), merged('a/one', 2, 'bob'), merged('a/one', 3, 'cat')])
    await health.sync()

    const ui = await health.dashboard({ windowDays: 7, repo: null, team: 'org/ui' })

    expect(ui.teams).toEqual(['@me', 'org/api', 'org/ui'])
    expect(ui.baseline?.all.merged).toBe(3)
    expect(ui.team).toBe('org/ui')
    expect(ui.metrics.all.merged).toBe(1)
  })

  it('shows only my pull requests when Me is picked, compared with everyone', async () => {
    const { db, health } = service(async () => emptyPage, ['a/one'])
    savePullRequests(db, [merged('a/one', 1, 'me-login'), merged('a/one', 2, 'bob')])
    await health.sync()

    const mine = await health.dashboard({ windowDays: 7, repo: null, team: '@me' })

    expect(mine.teams[0]).toBe('@me')
    expect(mine.viewer).toBe('me-login')
    expect(mine.metrics.all.merged).toBe(1)
    expect(mine.baseline?.all.merged).toBe(2)
  })

  it('offers no Me filter when the gh user cannot be read', async () => {
    const { health } = service(async () => emptyPage, ['a/one'], {
      readViewer: async () => {
        throw new Error('gh auth login')
      },
    })
    await health.sync()

    expect((await health.dashboard({ windowDays: 7, repo: null, team: null })).teams).toEqual([])
  })

  it('shows every pull request when the picked team is unknown', async () => {
    const { db, health } = service(async () => emptyPage, ['a/one'])
    savePullRequests(db, [merged('a/one', 1)])

    const dashboard = await health.dashboard({ windowDays: 7, repo: null, team: 'org/gone' })

    expect(dashboard.team).toBeNull()
    expect(dashboard.baseline).toBeNull()
    expect(dashboard.metrics.all.merged).toBe(1)
  })

  it('reads teams again only after six hours', async () => {
    let at = NOW
    const reads: string[] = []
    const { health } = service(async () => emptyPage, ['a/one'], {
      now: () => at,
      readTeamMembers: async (repo) => {
        reads.push(repo)
        return []
      },
    })

    await health.sync()
    at += 5 * 3_600_000
    await health.sync()
    at += 3_600_000
    await health.sync()

    expect(reads).toEqual(['a/one', 'a/one'])
  })

  it('still reads pull requests when the teams cannot be read', async () => {
    const { db, health } = service(async () => emptyPage, ['a/one'], {
      readTeamMembers: async () => {
        throw new Error('HTTP 403')
      },
    })

    await health.sync()

    expect((await health.dashboard({ windowDays: 7, repo: null, team: null })).historyDaysRead).toBe(HISTORY_DAYS - 1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_members').all()).toEqual([{ n: 0 }])
  })

  it('reads the work days before the period, so its first days get a full 5-day average', async () => {
    const { db, health } = service(async () => emptyPage, ['a/one'])
    savePullRequests(db, [{ ...merged('a/one', 1), mergedAt: new Date(2026, 10, 17, 12).getTime() }])

    const dashboard = await health.dashboard({ windowDays: 7, repo: null, team: null })

    expect(dashboard.metrics.all.merged).toBe(0)
    expect(dashboard.metrics.daily[0]!.rolling.mergedPerDay).toBe(1 / 5)
  })

  it('falls back to all repositories when the picked one is no longer configured', async () => {
    const { health } = service(async () => emptyPage)

    expect((await health.dashboard({ windowDays: 7, repo: 'a/gone', team: null })).repo).toBeNull()
  })

  it('reports a failing repository and still syncs the others', async () => {
    const { health } = service(async (query) => {
      if (query.startsWith('repo:a/one ')) throw new Error('Could not resolve to a Repository')
      return emptyPage
    })

    await health.sync()
    const dashboard = await health.dashboard({ windowDays: 30, repo: null, team: null })

    expect(dashboard.errors).toEqual([{ repo: 'a/one', message: 'Could not resolve to a Repository' }])
    expect(dashboard.historyDaysRead).toBe(HISTORY_DAYS - 1)
    expect(dashboard.historyDaysTotal).toBe(2 * (HISTORY_DAYS - 1))
  })

  it('clears a repository error after a sync that succeeds', async () => {
    let fail = true
    const { health } = service(async () => {
      if (fail) throw new Error('rate limited')
      return emptyPage
    }, ['a/one'])

    await health.sync()
    fail = false
    await health.sync()

    expect((await health.dashboard({ windowDays: 7, repo: null, team: null })).errors).toEqual([])
  })

  it('does not record an aborted read as a repository error', async () => {
    const controller = new AbortController()
    const { health } = service(async () => {
      controller.abort()
      throw new Error('The operation was aborted')
    })

    await health.sync(controller.signal)

    expect((await health.dashboard({ windowDays: 7, repo: null, team: null })).errors).toEqual([])
  })

  it('syncs with the new signal when a restarted service asks during the old, aborted sync', async () => {
    const old = new AbortController()
    const reads: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { health } = service(async (query) => {
      reads.push(query)
      await gate
      return emptyPage
    }, ['a/one'])

    const first = health.sync(old.signal)
    old.abort()
    const second = health.sync(new AbortController().signal)
    release()
    await Promise.all([first, second])

    expect(reads.length).toBeGreaterThan(1)
  })

  it('syncs again after the current sync when asked during it, so a newly added repository is read', async () => {
    const reads: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { health, setRepos } = service(async (query) => {
      reads.push(query.split(' ')[0]!)
      await gate
      return emptyPage
    }, ['a/one'])

    const first = health.sync()
    setRepos(['a/one', 'a/new'])
    const second = health.sync()
    release()
    await Promise.all([first, second])

    expect(reads).toContain('repo:a/new')
  })
})
