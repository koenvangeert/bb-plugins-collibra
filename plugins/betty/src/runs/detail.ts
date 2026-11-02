import type { NodeStatus, RunNode } from '../pesto/types'

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

export const STEP_STATUS_STYLE: Record<NodeStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'text-slate-500' },
  running: { label: 'Running', className: 'text-blue-600' },
  suspended: { label: 'Needs a decision', className: 'text-amber-600' },
  succeeded: { label: 'Done', className: 'text-green-600' },
  skipped: { label: 'Skipped', className: 'text-muted-foreground' },
  failed: { label: 'Failed', className: 'text-red-600' },
  cancelled: { label: 'Cancelled', className: 'text-gray-500' },
  unknown: { label: 'Unknown', className: 'text-muted-foreground' },
}

export function runCondition(node: RunNode): string {
  const parts = [...(node.when === undefined ? [] : [`Only when ${node.when}`]), ...(node.alwaysRun ? ['Always runs'] : [])]
  if (parts.length > 0) return parts.join(' · ')
  return node.dependsOn.length === 0 ? 'Runs first' : `After ${node.dependsOn.join(', ')}`
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

const ACTION_LABEL = new Map([
  ['post_review', 'Review'],
  ['remediation_comment', 'Remediation'],
  ['ci_watch', 'CI watch'],
])

export function actionLabel(kind: string): string {
  return ACTION_LABEL.get(kind) ?? kind.replaceAll('_', ' ')
}
