import type { NodeStatus, PullRequestState, RunDetail } from './pesto/types'

export const RUN_STATUSES = ['needs_decision', 'running', 'failed', 'cancelled', 'succeeded', 'unknown'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export type RunChip = { status: RunStatus; nodesDone: number; nodesTotal: number; costUsd: number }

export type RunPullRequest = { number: number; url: string; state: PullRequestState; repo: string }

export type ThreadRun =
  | { kind: 'none'; ticketKey: string | null }
  | { kind: 'linked'; runId: string; chip: RunChip | null; pullRequests: RunPullRequest[]; error: string | null }

const STATUS_BY_PRIORITY: readonly [RunStatus, readonly NodeStatus[]][] = [
  ['needs_decision', ['suspended']],
  ['running', ['running']],
  ['failed', ['failed']],
  ['cancelled', ['cancelled']],
  ['running', ['pending']],
]

const DONE_NODE_STATUSES: readonly NodeStatus[] = ['succeeded', 'skipped', 'failed', 'cancelled']

const STATUS_LABEL: Record<RunStatus, string> = {
  needs_decision: 'Needs decision',
  running: 'Running',
  failed: 'Failed',
  cancelled: 'Cancelled',
  succeeded: 'Succeeded',
  unknown: 'Status unknown',
}

export function runStatus(nodes: readonly { status: NodeStatus }[]): RunStatus {
  const match = STATUS_BY_PRIORITY.find(([, statuses]) => nodes.some((node) => statuses.includes(node.status)))
  if (match) return match[0]
  const finished = nodes.length > 0 && nodes.every((node) => node.status === 'succeeded' || node.status === 'skipped')
  return finished ? 'succeeded' : 'unknown'
}

export function runChip(run: RunDetail): RunChip {
  return {
    status: runStatus(run.nodes),
    nodesDone: run.nodes.filter((node) => DONE_NODE_STATUSES.includes(node.status)).length,
    nodesTotal: run.nodes.length,
    costUsd: run.totalCostUsd,
  }
}

export function chipLabel(chip: RunChip | null): string {
  if (!chip) return 'BETTY · unknown'
  return `BETTY · ${STATUS_LABEL[chip.status]} · ${chip.nodesDone}/${chip.nodesTotal} · $${chip.costUsd.toFixed(2)}`
}
