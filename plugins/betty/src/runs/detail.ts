import type { NodeStatus, PullRequest, PullRequestAction, RunNode } from '../pesto/types'

export function dagColumns(nodes: readonly RunNode[]): RunNode[][] {
  const byName = new Map(nodes.map((node) => [node.name, node]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()

  const columnOf = (node: RunNode): number => {
    const known = depth.get(node.name)
    if (known !== undefined) return known
    visiting.add(node.name)
    let column = 0
    for (const name of node.dependsOn) {
      const dep = byName.get(name)
      if (dep && !visiting.has(name)) column = Math.max(column, columnOf(dep) + 1)
    }
    visiting.delete(node.name)
    depth.set(node.name, column)
    return column
  }

  const columns: RunNode[][] = []
  for (const node of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    ;(columns[columnOf(node)] ??= []).push(node)
  }
  return columns
}

type StepStatusStyle = { label: string; icon: string; text: string; border: string; fill: string; spin?: boolean }

export const STEP_STATUS_STYLE: Record<NodeStatus, StepStatusStyle> = {
  pending: { label: 'Pending', icon: 'Circle', text: 'text-slate-500 dark:text-slate-400', border: 'border-l-slate-300 dark:border-l-slate-600', fill: 'bg-slate-300 dark:bg-slate-600' },
  running: { label: 'Running', icon: 'Loading', text: 'text-blue-600 dark:text-blue-400', border: 'border-l-blue-500', fill: 'bg-blue-500', spin: true },
  suspended: { label: 'Needs a decision', icon: 'Pause', text: 'text-amber-600 dark:text-amber-400', border: 'border-l-amber-500', fill: 'bg-amber-500' },
  succeeded: { label: 'Done', icon: 'CircleCheck', text: 'text-green-600 dark:text-green-400', border: 'border-l-green-500', fill: 'bg-green-500' },
  skipped: { label: 'Skipped', icon: 'ArrowTurnForward', text: 'text-muted-foreground', border: 'border-l-slate-300 dark:border-l-slate-600', fill: 'bg-slate-300 dark:bg-slate-600' },
  failed: { label: 'Failed', icon: 'CircleX', text: 'text-red-600 dark:text-red-400', border: 'border-l-red-500', fill: 'bg-red-500' },
  cancelled: { label: 'Cancelled', icon: 'Unavailable', text: 'text-gray-500 dark:text-gray-400', border: 'border-l-gray-400', fill: 'bg-gray-400' },
  unknown: { label: 'Unknown', icon: 'CircleQuestion', text: 'text-muted-foreground', border: 'border-l-border', fill: 'bg-muted' },
}

const FINISHED: ReadonlySet<NodeStatus> = new Set(['succeeded', 'skipped', 'failed', 'cancelled'])

export function stepProgress(nodes: readonly RunNode[]): { done: number; total: number } {
  return { done: nodes.filter((node) => FINISHED.has(node.status)).length, total: nodes.length }
}

export type NextAction =
  | { kind: 'decide'; step: string }
  | { kind: 'failed'; step: string }
  | { kind: 'running'; steps: string[] }
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'waiting' }

export function nextAction(nodes: readonly RunNode[]): NextAction {
  const named = (status: NodeStatus) =>
    nodes
      .filter((node) => node.status === status)
      .map((node) => node.name)
      .sort()
  const [suspended] = named('suspended')
  if (suspended) return { kind: 'decide', step: suspended }
  const [failed] = named('failed')
  if (failed) return { kind: 'failed', step: failed }
  const running = named('running')
  if (running.length > 0) return { kind: 'running', steps: running }
  if (nodes.length > 0 && nodes.every((node) => node.status === 'succeeded' || node.status === 'skipped')) return { kind: 'done' }
  if (nodes.length > 0 && nodes.every((node) => FINISHED.has(node.status))) return { kind: 'cancelled' }
  return { kind: 'waiting' }
}

const NEEDS_ATTENTION: ReadonlySet<NodeStatus> = new Set(['suspended', 'failed', 'running'])

export function attentionFirst(nodes: readonly RunNode[]): RunNode[] {
  const ordered = dagColumns(nodes).flat()
  return [...ordered.filter((node) => NEEDS_ATTENTION.has(node.status)), ...ordered.filter((node) => !NEEDS_ATTENTION.has(node.status))]
}

export type StepCondition = { kind: 'when'; expression: string } | { kind: 'always' } | { kind: 'after'; steps: string[] } | { kind: 'first' }

export function stepConditions(node: RunNode): StepCondition[] {
  const conditions: StepCondition[] = [
    ...(node.when === undefined ? [] : [{ kind: 'when', expression: node.when } as const]),
    ...(node.alwaysRun ? [{ kind: 'always' } as const] : []),
  ]
  if (conditions.length > 0) return conditions
  return [node.dependsOn.length === 0 ? { kind: 'first' } : { kind: 'after', steps: node.dependsOn }]
}

const NOT_STARTED: ReadonlySet<NodeStatus> = new Set(['pending', 'skipped', 'unknown'])

function cleanRunSkips(nodes: readonly RunNode[]): Set<string> {
  const byName = new Map(nodes.map((node) => [node.name, node]))
  const gated = new Map<string, boolean>()
  const visiting = new Set<string>()

  const isGated = (node: RunNode): boolean => {
    const known = gated.get(node.name)
    if (known !== undefined) return known
    visiting.add(node.name)
    const gatedDeps = node.dependsOn
      .map((name) => byName.get(name))
      .filter((dep): dep is RunNode => dep !== undefined && !visiting.has(dep.name) && isGated(dep))
    visiting.delete(node.name)
    const toleratesSkip = !NOT_STARTED.has(node.status) && gatedDeps.some((dep) => dep.status === 'skipped')
    const result = node.when !== undefined || (!node.alwaysRun && gatedDeps.length > 0 && !toleratesSkip)
    gated.set(node.name, result)
    return result
  }

  return new Set(nodes.filter(isGated).map((node) => node.name))
}

export function spendCeilings(nodes: readonly RunNode[]): { cleanRunUsd: number; worstCaseUsd: number } {
  const total = (steps: readonly RunNode[]) => steps.reduce((sum, node) => sum + (node.budgetUsd ?? 0), 0)
  const skips = cleanRunSkips(nodes)
  return { cleanRunUsd: total(nodes.filter((node) => !skips.has(node.name))), worstCaseUsd: total(nodes) }
}

const ACTION_KIND = new Map([
  ['post_review', { label: 'Review', icon: 'MessageSquare' }],
  ['remediation_comment', { label: 'Remediation', icon: 'Toolbox' }],
  ['ci_watch', { label: 'CI watch', icon: 'Eye' }],
])
const ACTION_ORDER = [...ACTION_KIND.keys()]

export function actionLabel(kind: string): string {
  return ACTION_KIND.get(kind)?.label ?? kind.replaceAll('_', ' ')
}

export function actionIcon(kind: string): string {
  return ACTION_KIND.get(kind)?.icon ?? 'Circle'
}

export function orderedActions(actions: readonly PullRequestAction[]): PullRequestAction[] {
  const rank = (kind: string) => {
    const index = ACTION_ORDER.indexOf(kind)
    return index === -1 ? ACTION_ORDER.length : index
  }
  return [...actions].sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name))
}

export type SpendMeter = { tone: 'clean' | 'over-clean' | 'over-worst'; spentShare: number; cleanShare: number }

export function spendMeter(spentUsd: number, ceilings: { cleanRunUsd: number; worstCaseUsd: number }): SpendMeter {
  const scale = Math.max(ceilings.worstCaseUsd, spentUsd)
  const share = (usd: number) => (scale === 0 ? 0 : usd / scale)
  const tone = spentUsd > ceilings.worstCaseUsd ? 'over-worst' : spentUsd > ceilings.cleanRunUsd ? 'over-clean' : 'clean'
  return { tone, spentShare: share(spentUsd), cleanShare: share(ceilings.cleanRunUsd) }
}

export function baseMayMislead(pr: PullRequest): boolean {
  return pr.base !== '' && pr.base !== 'main'
}
