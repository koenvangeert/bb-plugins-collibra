import { z } from 'zod'
import { PestoError, type McpSession } from './mcp'
import type { AcEvidence, Artifact, ArtifactEntry, Identity, RunDetail, RunList, TaskShow } from './types'
import { acEvidenceSchema, artifactSchema, identitySchema, runDetailSchema, runListSchema, taskLogsSchema, taskShowSchema } from './wire'

export type ListRunsQuery = {
  ownerDev: string
  since?: string
  includeFinished?: boolean
  limit?: number
  offset?: number
}

const NO_RESULT_ARTIFACT = /has no "result" artifact on any attempt/

export type PestoClient = ReturnType<typeof createPestoClient>

export function createPestoClient(session: Pick<McpSession, 'callTool'>) {
  async function call<T>(tool: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const reply = schema.safeParse(await session.callTool(tool, withoutUndefined(args)))
    if (!reply.success) throw new PestoError(`BETTY sent an unexpected answer to ${tool}: ${z.prettifyError(reply.error)}`)
    return reply.data
  }

  async function act(tool: string, args: Record<string, unknown>): Promise<void> {
    await call(tool, args, z.unknown())
  }

  return {
    listRuns: (query: ListRunsQuery): Promise<RunList> =>
      call(
        'pesto_dag_status',
        {
          owner_dev: query.ownerDev,
          since: query.since,
          include_finished: query.includeFinished,
          limit: query.limit,
          offset: query.offset,
        },
        runListSchema,
      ),
    dagStatus: (runId: string): Promise<RunDetail> => call('pesto_dag_status', { run_id: runId }, runDetailSchema),
    artifact: (artifactId: string): Promise<Artifact> => call('pesto_artifact_get', { artifact_id: artifactId }, artifactSchema),
    acEvidence: async (taskId: string): Promise<AcEvidence | null> => {
      try {
        const result = await call('pesto_artifact_get', { task_id: taskId, kind: 'result' }, artifactSchema)
        return acEvidenceSchema.safeParse(result.content).data ?? null
      } catch (error) {
        if (error instanceof PestoError && NO_RESULT_ARTIFACT.test(error.message)) return null
        throw error
      }
    },
    taskLogs: (taskId: string): Promise<ArtifactEntry[]> => call('pesto_task_logs', { task_id: taskId }, taskLogsSchema),
    taskShow: (taskId: string): Promise<TaskShow> => call('pesto_task_show', { task_id: taskId }, taskShowSchema),
    whoami: (): Promise<Identity> => call('pesto_whoami', {}, identitySchema),
    approve: ({ taskId, budgetUsd, hint }: { taskId: string; budgetUsd: number; hint?: string }) =>
      act('pesto_task_approve', { task_id: taskId, cost_budget_usd: budgetUsd, hint: hint || undefined }),
    deny: ({ taskId, reason }: { taskId: string; reason: string }) => act('pesto_task_deny', { task_id: taskId, reason }),
    stop: ({ taskId, reason }: { taskId: string; reason: string }) => act('pesto_task_stop', { task_id: taskId, reason }),
  }
}

function withoutUndefined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
}
