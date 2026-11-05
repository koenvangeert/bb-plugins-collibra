import type { PestoClient } from '../pesto/client'
import type { AcEvidence, NodeStatus, RunNode } from '../pesto/types'
import { dagColumns } from './detail'

export type Criterion = {
  id: string
  text: string | null
  met: boolean
  evidence: string
  images: string[]
  fakedBackend: string | null
}

export type StepEvidence = { taskId: string; step: string; criteria: Criterion[] }

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
    const evidence = await pesto.acEvidence(node.taskId)
    if (!evidence) return null
    const { acceptanceCriteria } = await pesto.taskShow(node.taskId)
    return { taskId: node.taskId, step: node.name, criteria: criteria(evidence, acceptanceCriteria) }
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
      const steps = await Promise.all(candidates.map(cached))
      return steps.filter((step): step is StepEvidence => step !== null)
    },
  }
}

function criteria(evidence: AcEvidence, texts: readonly string[]): Criterion[] {
  return evidence.acs.map((ac) => ({
    id: ac.id,
    text: texts[criterionIndex(ac.id)] ?? null,
    met: ac.met,
    evidence: ac.evidence,
    images: ac.images,
    fakedBackend: fakedBackendSentence(ac.evidence),
  }))
}

function criterionIndex(id: string): number {
  const number = id.match(/^AC-(\d+)$/)?.[1]
  return number === undefined ? -1 : Number(number) - 1
}
