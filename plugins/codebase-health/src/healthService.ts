import type { SqlDatabase } from './database'
import type { ReadSearchPage } from './github'
import { buildMetrics, metricsStart, type DailyFigures, type HealthMetrics, type WindowDays } from './metrics'
import { pullRequestsMergedSince, saveTeamMembers, syncedDays, teamMembers } from './store'
import { ME } from './me'
import type { TeamMember } from './teams'
import { dayIsOver, historyDays, syncRepository } from './sync'

const TEAMS_REFRESH_MS = 6 * 3_600_000

export interface DashboardInput {
  windowDays: WindowDays
  repo: string | null
  team: string | null
}

export interface HealthDashboard {
  repos: string[]
  repo: string | null
  teams: string[]
  team: string | null
  viewer: string | null
  windowDays: WindowDays
  metrics: HealthMetrics
  /** The same figures for every team, so a picked team can be compared with them. */
  baseline: HealthMetrics | null
  /** Each repository's own daily figures, when all of several repositories are shown. */
  byRepo: { repo: string; daily: DailyFigures[] }[] | null
  syncing: boolean
  historyDaysRead: number
  historyDaysTotal: number
  errors: { repo: string; message: string }[]
  syncedAt: number | null
}

export interface HealthServiceDependencies {
  db: SqlDatabase
  readPage: ReadSearchPage
  readTeamMembers(repo: string, signal?: AbortSignal): Promise<TeamMember[]>
  readViewer(signal?: AbortSignal): Promise<string>
  readRepos(): Promise<string[]>
  now(): number
  onError?(message: string, error: unknown): void
}

export function createHealthService(dependencies: HealthServiceDependencies) {
  const { db, readPage, readTeamMembers, readViewer, readRepos, now, onError } = dependencies
  let viewer: string | null = null
  const errors = new Map<string, string>()
  const teamsReadAt = new Map<string, number>()
  let syncedAt: number | null = null
  let running: Promise<void> | null = null
  let rerun = false
  let latestSignal: AbortSignal | undefined

  async function syncTeams(repo: string, signal?: AbortSignal): Promise<void> {
    if (now() - (teamsReadAt.get(repo) ?? -Infinity) < TEAMS_REFRESH_MS) return
    try {
      saveTeamMembers(db, repo, await readTeamMembers(repo, signal))
      teamsReadAt.set(repo, now())
    } catch (error) {
      if (!signal?.aborted) onError?.(`failed to read the teams of ${repo}`, error)
    }
  }

  async function syncOnce(signal?: AbortSignal): Promise<void> {
    if (viewer === null) {
      try {
        viewer = await readViewer(signal)
      } catch (error) {
        if (!signal?.aborted) onError?.('failed to read the gh user', error)
      }
    }
    for (const repo of await readRepos()) {
      if (signal?.aborted) return
      await syncTeams(repo, signal)
      try {
        await syncRepository({ db, readPage, repo, now: now(), signal })
        errors.delete(repo)
      } catch (error) {
        if (signal?.aborted) return
        errors.set(repo, error instanceof Error ? error.message : String(error))
        onError?.(`failed to read pull requests of ${repo}`, error)
      }
    }
    syncedAt = now()
  }

  /**
   * A request during a sync runs one more sync after it, so a repository added mid-sync is read too.
   * The rerun takes the newest signal: after a service restart, the old run's signal is already aborted.
   */
  function sync(signal?: AbortSignal): Promise<void> {
    latestSignal = signal
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      do {
        rerun = false
        await syncOnce(latestSignal)
      } while (rerun && !latestSignal?.aborted)
    })().finally(() => {
      running = null
    })
    return running
  }

  async function dashboard(input: DashboardInput): Promise<HealthDashboard> {
    const repos = await readRepos()
    const repo = input.repo !== null && repos.includes(input.repo) ? input.repo : null
    const selected = repo ? [repo] : repos
    const at = now()
    const history = new Set(historyDays(at).filter((day) => dayIsOver(day, at)))
    const historyDaysRead = selected.reduce(
      (sum, name) => sum + [...syncedDays(db, name)].filter((day) => history.has(day)).length,
      0,
    )
    const teams = teamMembers(db, selected)
    if (viewer !== null) teams.set(ME, new Set([viewer]))
    const members = input.team === null ? undefined : teams.get(input.team)
    const everyone = pullRequestsMergedSince(db, selected, metricsStart(at, input.windowDays))
    const pullRequests = members ? everyone.filter((pr) => members.has(pr.author)) : everyone
    return {
      repos,
      repo,
      teams: [...teams.keys()].sort((a, b) => Number(b === ME) - Number(a === ME)),
      viewer,
      team: members ? input.team : null,
      windowDays: input.windowDays,
      metrics: buildMetrics(pullRequests, at, input.windowDays),
      baseline: members ? buildMetrics(everyone, at, input.windowDays) : null,
      byRepo:
        selected.length > 1
          ? selected.map((name) => ({
              repo: name,
              daily: buildMetrics(
                pullRequests.filter((pr) => pr.repo === name),
                at,
                input.windowDays,
              ).daily,
            }))
          : null,
      syncing: running !== null,
      historyDaysRead,
      historyDaysTotal: history.size * selected.length,
      errors: selected.flatMap((name) => (errors.has(name) ? [{ repo: name, message: errors.get(name)! }] : [])),
      syncedAt,
    }
  }

  return { sync, dashboard }
}

export type HealthService = ReturnType<typeof createHealthService>
