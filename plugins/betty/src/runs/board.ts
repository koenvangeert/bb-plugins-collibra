import type { PullRequestState, RunOutcome, RunSummary } from '../pesto/types'

export type RunGroupId = 'needs-decision' | 'in-flight' | 'finished'

export const RUN_GROUP: Record<RunOutcome, RunGroupId> = {
  needs_decision: 'needs-decision',
  running: 'in-flight',
  watching_ci: 'in-flight',
  waiting: 'in-flight',
  unknown: 'in-flight',
  succeeded: 'finished',
  partially_succeeded: 'finished',
  failed: 'finished',
  cancelled: 'finished',
}

export const RUN_GROUPS: readonly { id: RunGroupId; label: string }[] = [
  { id: 'needs-decision', label: 'Needs a decision' },
  { id: 'in-flight', label: 'In flight' },
  { id: 'finished', label: 'Finished' },
]

export const OUTCOME_STYLE: Record<RunOutcome, { label: string; text: string; fill: string }> = {
  needs_decision: { label: 'Needs a decision', text: 'text-amber-600', fill: 'bg-amber-500' },
  running: { label: 'Running', text: 'text-blue-600', fill: 'bg-blue-500' },
  watching_ci: { label: 'Watching CI', text: 'text-violet-600', fill: 'bg-violet-500' },
  waiting: { label: 'Waiting', text: 'text-slate-500', fill: 'bg-slate-400' },
  unknown: { label: 'Unknown', text: 'text-muted-foreground', fill: 'bg-gray-300' },
  succeeded: { label: 'Succeeded', text: 'text-green-600', fill: 'bg-green-500' },
  partially_succeeded: { label: 'Partly succeeded', text: 'text-orange-600', fill: 'bg-orange-500' },
  failed: { label: 'Failed', text: 'text-red-600', fill: 'bg-red-500' },
  cancelled: { label: 'Cancelled', text: 'text-gray-500', fill: 'bg-gray-400' },
}

export const OUTCOME_ORDER: readonly RunOutcome[] = [
  'needs_decision',
  'running',
  'watching_ci',
  'waiting',
  'unknown',
  'succeeded',
  'partially_succeeded',
  'failed',
  'cancelled',
]

export const PR_STATE_STYLE: Record<PullRequestState, { label: string; className: string }> = {
  open: { label: 'open', className: 'border-green-600 text-green-600' },
  draft: { label: 'draft', className: 'border-gray-500 text-gray-500' },
  merged: { label: 'merged', className: 'border-purple-600 text-purple-600' },
  closed: { label: 'closed', className: 'border-red-600 text-red-600' },
  unknown: { label: 'unknown', className: 'border-border text-muted-foreground' },
}

export type TileId = 'needs-decision' | 'in-flight' | 'shipped' | 'broke'

export const TILES: readonly { id: TileId; label: string; text: string; outcomes: readonly RunOutcome[] }[] = [
  { id: 'needs-decision', label: 'Needs a decision', text: 'text-amber-600', outcomes: ['needs_decision'] },
  { id: 'in-flight', label: 'In flight', text: 'text-blue-600', outcomes: ['running', 'watching_ci', 'waiting', 'unknown'] },
  { id: 'shipped', label: 'Shipped', text: 'text-green-600', outcomes: ['succeeded'] },
  { id: 'broke', label: 'Broke', text: 'text-red-600', outcomes: ['failed', 'partially_succeeded'] },
]

export type RunGroup = { id: RunGroupId; label: string; runs: RunSummary[] }

export function groupRuns(runs: readonly RunSummary[]): RunGroup[] {
  return RUN_GROUPS.map((group) => ({ ...group, runs: runs.filter((run) => RUN_GROUP[run.outcome] === group.id) }))
}

export function inTile(tile: TileId, run: RunSummary): boolean {
  return TILES.find((entry) => entry.id === tile)!.outcomes.includes(run.outcome)
}

export type Day = { day: string; runs: number; spendUsd: number; byOutcome: Partial<Record<RunOutcome, number>> }

export type Overview = {
  tiles: Record<TileId, number>
  cancelled: number
  successRate: number | null
  spendUsd: number
  spendPerRunUsd: number | null
  pullRequests: Record<PullRequestState, number>
  outcomes: { outcome: RunOutcome; count: number }[]
  days: Day[]
}

const DAY_MS = 24 * 60 * 60 * 1000

export function localDay(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function overview(runs: readonly RunSummary[], now: number, dayCount: number): Overview {
  const count = (outcomes: readonly RunOutcome[]) => runs.filter((run) => outcomes.includes(run.outcome)).length
  const tiles = Object.fromEntries(TILES.map((tile) => [tile.id, count(tile.outcomes)])) as Record<TileId, number>
  const ended = tiles.shipped + tiles.broke
  const spendUsd = runs.reduce((sum, run) => sum + run.costUsd, 0)

  const pullRequests: Record<PullRequestState, number> = { open: 0, draft: 0, merged: 0, closed: 0, unknown: 0 }
  for (const pr of runs.flatMap((run) => run.pullRequests)) pullRequests[pr.state] += 1

  const days: Day[] = Array.from({ length: dayCount }, (_, index) => ({
    day: localDay(now - (dayCount - 1 - index) * DAY_MS),
    runs: 0,
    spendUsd: 0,
    byOutcome: {},
  }))
  const byDay = new Map(days.map((day) => [day.day, day]))
  for (const run of runs) {
    const day = byDay.get(localDay(Date.parse(run.lastStatusChangeAt)))
    if (!day) continue
    day.runs += 1
    day.spendUsd += run.costUsd
    day.byOutcome[run.outcome] = (day.byOutcome[run.outcome] ?? 0) + 1
  }

  return {
    tiles,
    cancelled: count(['cancelled']),
    successRate: ended === 0 ? null : tiles.shipped / ended,
    spendUsd,
    spendPerRunUsd: runs.length === 0 ? null : spendUsd / runs.length,
    pullRequests,
    outcomes: OUTCOME_ORDER.map((outcome) => ({ outcome, count: count([outcome]) })).filter((entry) => entry.count > 0),
    days,
  }
}
