import type { PestoClient } from '../pesto/client'
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

const STOP_REASON = 'Stopped from bb.'

export async function stopRun(pesto: PestoClient, runId: string): Promise<{ failed: { step: string; error: string }[] }> {
  const { steps } = stopPlan((await pesto.dagStatus(runId)).nodes)
  const outcomes = await Promise.all(
    steps.map(({ node, action }) =>
      pesto[action]({ taskId: node.taskId, reason: STOP_REASON }).then(
        () => null,
        (error: unknown) => ({ step: node.name, error: error instanceof Error ? error.message : String(error) }),
      ),
    ),
  )
  return { failed: outcomes.filter((outcome) => outcome !== null) }
}
