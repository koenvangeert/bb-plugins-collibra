import type { BbPluginApi } from '@get-bb/plugin-sdk'
import { z } from 'zod'
import type { PestoClient } from './pesto/client'
import type { Artifact, ArtifactEntry, NodeStatus, RunDetail, RunNode } from './pesto/types'
import { chipLabel, runChip } from './runChip'
import type { createEvidenceLoader, StepEvidence } from './runs/evidence'
import { LINK_TOOL } from './threadRun'

export const STATUS_TOOL = 'betty_status'
export const EVIDENCE_TOOL = 'betty_evidence'

export const ANSWER_LIMIT = 4000
const PAGE_SIZE = 3000

export type Answer = { lines: string[]; pointer: string }

export function renderAnswer({ lines, pointer }: Answer): string {
  const end = clip(pointer, ANSWER_LIMIT / 4)
  const room = ANSWER_LIMIT - 1 - (end.length + 1) - (cutLine(lines.length).length + 1)
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const left = room - used - 1
    const shown = clip(line, left)
    if (left < 0 || (shown === '' && line !== '')) break
    kept.push(shown)
    used += shown.length + 1
  }
  const cut = lines.length - kept.length
  return [...kept, ...(cut > 0 ? [cutLine(cut)] : []), end].join('\n')
}

const cutLine = (count: number) => `… ${count} more lines cut.`

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 1 ? '' : `${text.slice(0, max - 1)}…`
}

const field = (text: string, max: number) => clip(text.replace(/\s+/g, ' ').trim(), max)

const usd = (amount: number) => `$${amount.toFixed(2)}`

const STEP_LINES: readonly [NodeStatus, (node: RunNode) => string][] = [
  ['suspended', (node) => `Needs a decision: ${node.name} (${node.taskId}), ${usd(node.costUsd)}${node.budgetUsd === null ? '' : ` of ${usd(node.budgetUsd)}`} spent.`],
  ['failed', (node) => `Failed: ${node.name} (${node.taskId})${node.error ? `: ${field(node.error, 300)}` : '.'}`],
  ['running', (node) => `Running: ${node.name} (${node.taskId}).`],
]

export function statusAnswer(run: RunDetail): Answer {
  const steps = STEP_LINES.flatMap(([status, line]) => run.nodes.filter((node) => node.status === status).map(line))
  const pullRequests = run.pullRequests.map(
    (pr) =>
      `PR ${pr.repo}#${pr.number}, ${pr.state}, ${pr.url}${pr.base === 'main' ? '' : `. Its base is ${pr.base || 'unknown'}, not main, so CI may run only a few checks.`}`,
  )
  return {
    lines: [`${chipLabel(runChip(run))} · run ${run.runId}`, ...pullRequests, ...steps],
    pointer: `The full run is in the BETTY run tab of the thread. For the AC evidence, call ${EVIDENCE_TOOL}. For the artifacts of a step, call ${EVIDENCE_TOOL} with its taskId.`,
  }
}

export function evidenceAnswer(runId: string, steps: readonly StepEvidence[]): Answer {
  const lines = steps.flatMap((step): string[] => {
    const header = `Step ${step.step} (${step.taskId})`
    if ('error' in step) return [`${header}: could not read the evidence: ${field(step.error, 300)}`]
    return [
      `${header}:`,
      ...step.criteria.flatMap((criterion) => [
        `${criterion.id} ${criterion.met ? 'met' : 'NOT MET'}${criterion.text ? `: ${field(criterion.text, 120)}` : ''}. Screenshots: ${criterion.images.length}. Evidence: ${field(criterion.evidence, 300) || 'none'}`,
        ...(criterion.fakedBackend ? [`Warning: the evidence mentions faked backend data: "${field(criterion.fakedBackend, 300)}"`] : []),
      ]),
    ]
  })
  return {
    lines: lines.length > 0 ? lines : [`No step of run ${runId} has AC evidence yet.`],
    pointer: `To list the artifacts of a step, call ${EVIDENCE_TOOL} with its taskId. Then call it with an artifactId to read one in full.`,
  }
}

export function artifactListAnswer(taskId: string, entries: readonly ArtifactEntry[]): Answer {
  const lines = entries.map((entry) => `${entry.kind}, attempt ${entry.attempt}, ${entry.sizeBytes} bytes, artifactId ${entry.artifactId}`)
  return {
    lines: lines.length > 0 ? lines : [`Step ${taskId} has no artifacts.`],
    pointer: `To read an artifact, call ${EVIDENCE_TOOL} with its artifactId.`,
  }
}

export function artifactPageAnswer(artifactId: string, artifact: Artifact, offset: number): Answer {
  const total = artifact.content.length
  const end = Math.min(offset + PAGE_SIZE, total)
  const note = artifact.note ? ` PESTO note: ${field(artifact.note, 300)}` : ''
  if (total === 0) return { lines: [`Artifact ${artifactId} is empty.${note}`], pointer: 'There is nothing more to read.' }
  if (offset >= total) {
    return { lines: [`Artifact ${artifactId} has ${total} chars, so offset ${offset} is past the end.${note}`], pointer: `Start again with offset 0.` }
  }
  return {
    lines: [`Artifact ${artifactId}, chars ${offset + 1} to ${end} of ${total}.${note}`, artifact.content.slice(offset, end)],
    pointer: end < total ? `Next page: ${EVIDENCE_TOOL} with artifactId ${artifactId} and offset ${end}.` : 'This is the end of the artifact.',
  }
}

const SIGNED_OUT = `bb is not signed in to BETTY. Ask the user to sign in from the BETTY run tab of this thread. This tool works right after the sign-in, with no restart.`

const NO_RUN = `This thread has no linked BETTY run. Pass runId, or link the run with ${LINK_TOOL} first.`

const ERROR_POINTER = 'The BETTY run tab of the thread shows the run and the sign-in.'

const runIdParam = z.string().trim().min(1).max(200)

export function registerAgentTools(
  agents: Pick<BbPluginApi['agents'], 'registerTool'>,
  deps: {
    pesto: Pick<PestoClient, 'dagStatus' | 'taskLogs' | 'artifact'>
    evidence: ReturnType<typeof createEvidenceLoader>
    linkedRunId: (threadId: string) => Promise<string | null>
    isSignedIn: () => boolean
  },
) {
  const { pesto, evidence, linkedRunId, isSignedIn } = deps

  const answer = async (work: () => Promise<Answer>) => {
    try {
      if (!isSignedIn()) throw new Error(SIGNED_OUT)
      return renderAnswer(await work())
    } catch (error) {
      const text = renderAnswer({ lines: [error instanceof Error ? error.message : String(error)], pointer: ERROR_POINTER })
      return { content: [{ type: 'text' as const, text }], isError: true }
    }
  }

  const resolveRunId = async (threadId: string, runId: string | undefined) => {
    const id = runId ?? (await linkedRunId(threadId))
    if (!id) throw new Error(NO_RUN)
    return id
  }

  agents.registerTool({
    name: STATUS_TOOL,
    description: `Read the status of a BETTY (PESTO) run: progress, spend, steps that need a decision, failed and running steps, and pull requests. Answers in under ${ANSWER_LIMIT} chars. Needs no pesto MCP.`,
    parameters: z.object({ runId: runIdParam.optional().describe('The run to read. Defaults to the run linked to this thread.') }),
    presentation: { label: { pending: 'Reading BETTY run', completed: 'Read BETTY run' }, icon: { glyph: 'Workflow' } },
    execute: ({ runId }, ctx) => answer(async () => statusAnswer(await pesto.dagStatus(await resolveRunId(ctx.threadId, runId)))),
  })

  agents.registerTool({
    name: EVIDENCE_TOOL,
    description: `Read the acceptance criteria evidence of a BETTY (PESTO) run. With taskId, list the artifacts of that step. With artifactId, read that artifact page by page from offset. Answers in under ${ANSWER_LIMIT} chars. Needs no pesto MCP.`,
    parameters: z.object({
      runId: runIdParam.optional().describe('The run to read. Defaults to the run linked to this thread.'),
      taskId: runIdParam.optional().describe('List the artifacts of this step.'),
      artifactId: runIdParam.optional().describe('Read this artifact.'),
      offset: z.number().int().min(0).optional().describe('The char offset of the artifact page to read. Defaults to 0.'),
    }),
    presentation: { label: { pending: 'Reading BETTY evidence', completed: 'Read BETTY evidence' }, icon: { glyph: 'Workflow' } },
    execute: ({ runId, taskId, artifactId, offset }, ctx) =>
      answer(async () => {
        if (artifactId) return artifactPageAnswer(artifactId, await pesto.artifact(artifactId), offset ?? 0)
        if (taskId) return artifactListAnswer(taskId, await pesto.taskLogs(taskId))
        const id = await resolveRunId(ctx.threadId, runId)
        return evidenceAnswer(id, await evidence.load((await pesto.dagStatus(id)).nodes))
      }),
  })

  return [STATUS_TOOL, EVIDENCE_TOOL]
}
