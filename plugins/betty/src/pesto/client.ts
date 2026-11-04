import { z } from 'zod'
import { PestoError, type McpSession } from './mcp'
import type { Artifact, Identity, RunDetail, RunList } from './types'
import { artifactSchema, identitySchema, runDetailSchema, runListSchema } from './wire'

export type ListRunsQuery = {
  ownerDev: string
  since?: string
  includeFinished?: boolean
  limit?: number
  offset?: number
}

export type ArtifactQuery = { taskId: string; kind: string } | { artifactId: string }

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
    artifact: (query: ArtifactQuery): Promise<Artifact> =>
      call(
        'pesto_artifact_get',
        'artifactId' in query ? { artifact_id: query.artifactId } : { task_id: query.taskId, kind: query.kind },
        artifactSchema,
      ),
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
