import type { RunNode } from '../pesto/types'
import { FINISHED } from './detail'

export function approveBudget(node: RunNode): number | null {
  return node.budgetUsd === null ? null : node.budgetUsd * 2
}

export function stopPlan(nodes: readonly RunNode[]): { steps: { node: RunNode; action: 'stop' | 'deny' }[]; stillRuns: RunNode[] } {
  const unfinished = nodes.filter((node) => !FINISHED.has(node.status))
  const isTarget = (node: RunNode) => !node.alwaysRun && node.status !== 'pending'
  return {
    steps: unfinished.filter(isTarget).map((node) => ({ node, action: node.status === 'suspended' ? 'deny' : 'stop' })),
    stillRuns: unfinished.filter((node) => node.alwaysRun),
  }
}
