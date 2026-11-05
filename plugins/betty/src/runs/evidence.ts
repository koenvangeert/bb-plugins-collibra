import type { PestoClient } from '../pesto/client'
import type { NodeStatus, RunNode } from '../pesto/types'
import { dagColumns } from './detail'

export type Criterion = {
  id: string
  text: string | null
  met: boolean
  evidence: string
  images: string[]
  fakedBackend: string | null
}

type Step = { taskId: string; step: string }

export type StepEvidence = (Step & { criteria: Criterion[] }) | (Step & { error: string })

const FAKED_BACKEND: readonly RegExp[] = [
  /simulated backend/i,
  /not real data/i,
  /magneto_playwright_route/i,
  /\b(rewrote|rewritten|faked|fake|mocked|stubbed|intercepted)\b.*\bresponses?\b/i,
]

export function fakedBackendSentence(evidence: string): string | null {
  const sentences = evidence.split(/(?<=[.!?])\s+/)
  return sentences.find((sentence) => FAKED_BACKEND.some((pattern) => pattern.test(sentence)))?.trim() ?? null
}

const HAS_EVIDENCE: ReadonlySet<NodeStatus> = new Set(['succeeded', 'failed'])

export function createEvidenceLoader(pesto: Pick<PestoClient, 'acEvidence' | 'taskShow'>) {
  const finished = new Map<string, Promise<StepEvidence | null>>()

  async function read(node: RunNode): Promise<StepEvidence | null> {
    const task = await pesto.taskShow(node.taskId)
    if (!task.requiredArtifacts.includes('result') || Object.keys(task.criteria).length === 0) return null
    const verdicts = await pesto.acEvidence(node.taskId)
    return {
      taskId: node.taskId,
      step: node.name,
      criteria: verdicts.map((verdict) => ({
        ...verdict,
        text: task.criteria[verdict.id] ?? null,
        fakedBackend: fakedBackendSentence(verdict.evidence),
      })),
    }
  }

  function cached(node: RunNode): Promise<StepEvidence | null> {
    const key = `${node.taskId}@${node.completedAt ?? ''}`
    let step = finished.get(key)
    if (!step) {
      step = read(node)
      finished.set(key, step)
      step.catch(() => finished.delete(key))
    }
    return step
  }

  return {
    async load(nodes: readonly RunNode[]): Promise<StepEvidence[]> {
      const candidates = dagColumns(nodes)
        .flat()
        .filter((node) => node.executor === 'agent' && HAS_EVIDENCE.has(node.status))
      const reads = await Promise.allSettled(candidates.map(cached))
      return reads.flatMap((read, index): StepEvidence[] => {
        if (read.status === 'fulfilled') return read.value ? [read.value] : []
        const node = candidates[index]!
        return [{ taskId: node.taskId, step: node.name, error: read.reason instanceof Error ? read.reason.message : String(read.reason) }]
      })
    },
  }
}
