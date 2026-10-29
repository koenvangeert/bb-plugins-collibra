export const RUN_OUTCOMES = [
  'running',
  'watching_ci',
  'waiting',
  'needs_decision',
  'succeeded',
  'partially_succeeded',
  'failed',
  'cancelled',
] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number] | 'unknown'

export const NODE_STATUSES = ['pending', 'running', 'suspended', 'succeeded', 'skipped', 'failed', 'cancelled'] as const
export type NodeStatus = (typeof NODE_STATUSES)[number] | 'unknown'

export const PULL_REQUEST_STATES = ['draft', 'open', 'merged', 'closed'] as const
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number] | 'unknown'

export type Executor = 'agent' | 'script' | 'publisher' | (string & {})

export type PullRequestAction = {
  kind: string
  name: string
  taskId: string
  url?: string
  predicted: boolean
}

export type PullRequest = {
  number: number
  url: string
  state: PullRequestState
  base: string
  head: string
  repo: string
  actedOnBy: PullRequestAction[]
}

export type RunSummary = {
  runId: string
  title: string
  outcome: RunOutcome
  ownerDev: string
  progress: { nodesDone: number; nodesTotal: number }
  costUsd: number
  lastStatusChangeAt: string
  finishedAt?: string
  pullRequests: PullRequest[]
}

export type RunList = {
  runs: RunSummary[]
  beyondLimit: number
  matched: number
}

export type RunNode = {
  taskId: string
  name: string
  executor: Executor
  status: NodeStatus
  dependsOn: string[]
  when?: string
  alwaysRun: boolean
  skipped: boolean
  costUsd: number
  budgetUsd: number | null
  startedAt?: string
  completedAt?: string
}

export type RunDetail = {
  runId: string
  totalCostUsd: number
  nodes: RunNode[]
  pullRequests: PullRequest[]
}

export type Artifact = {
  artifactId: string
  kind: string
  contentType: string
  sizeBytes: number
  content: string
}
