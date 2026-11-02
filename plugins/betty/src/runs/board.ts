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

export const OUTCOME_STYLE: Record<RunOutcome, { label: string; className: string }> = {
  needs_decision: { label: 'Needs a decision', className: 'text-amber-600' },
  running: { label: 'Running', className: 'text-blue-600' },
  watching_ci: { label: 'Watching CI', className: 'text-violet-600' },
  waiting: { label: 'Waiting', className: 'text-slate-500' },
  unknown: { label: 'Unknown', className: 'text-muted-foreground' },
  succeeded: { label: 'Succeeded', className: 'text-green-600' },
  partially_succeeded: { label: 'Partly succeeded', className: 'text-orange-600' },
  failed: { label: 'Failed', className: 'text-red-600' },
  cancelled: { label: 'Cancelled', className: 'text-gray-500' },
}

export const PR_STATE_STYLE: Record<PullRequestState, { label: string; className: string }> = {
  open: { label: 'open', className: 'border-green-600 text-green-600' },
  draft: { label: 'draft', className: 'border-gray-500 text-gray-500' },
  merged: { label: 'merged', className: 'border-purple-600 text-purple-600' },
  closed: { label: 'closed', className: 'border-red-600 text-red-600' },
  unknown: { label: 'unknown', className: 'border-border text-muted-foreground' },
}

export type RunGroup = { id: RunGroupId; label: string; runs: RunSummary[] }

export function board(runs: readonly RunSummary[]): { groups: RunGroup[]; spendUsd: number } {
  return {
    groups: RUN_GROUPS.map((group) => ({ ...group, runs: runs.filter((run) => RUN_GROUP[run.outcome] === group.id) })),
    spendUsd: runs.reduce((sum, run) => sum + run.costUsd, 0),
  }
}
