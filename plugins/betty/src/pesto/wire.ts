import { z } from 'zod'
import {
  NODE_STATUSES,
  PULL_REQUEST_STATES,
  RUN_OUTCOMES,
  type AcEvidence,
  type Artifact,
  type ArtifactEntry,
  type Identity,
  type PullRequest,
  type RunDetail,
  type RunList,
  type RunNode,
  type RunSummary,
  type TaskShow,
} from './types'

const pullRequest = z
  .object({
    number: z.number().optional(),
    url: z.string().optional(),
    state: z.enum([...PULL_REQUEST_STATES, 'unknown']).catch('unknown'),
    base: z.string().default(''),
    head: z.string().default(''),
    repo: z.string(),
    acted_on_by: z
      .array(
        z.object({
          kind: z.string(),
          name: z.string(),
          task_id: z.string(),
          url: z.string().optional(),
          predicted: z.boolean().default(false),
        }),
      )
      .default([]),
  })
  .transform((pr): PullRequest | null => {
    if (pr.number === undefined || pr.url === undefined) return null
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      base: pr.base,
      head: pr.head,
      repo: pr.repo,
      actedOnBy: pr.acted_on_by.map((action) => ({
        kind: action.kind,
        name: action.name,
        taskId: action.task_id,
        ...(action.url === undefined ? {} : { url: action.url }),
        predicted: action.predicted,
      })),
    }
  })

const openedPullRequests = z
  .array(pullRequest)
  .default([])
  .transform((prs) => prs.filter((pr): pr is PullRequest => pr !== null))

const runSummary = z
  .object({
    run_id: z.string(),
    title: z.string(),
    outcome: z.enum([...RUN_OUTCOMES, 'unknown']).catch('unknown'),
    owner_dev: z.string(),
    nodes_done: z.number(),
    nodes_total: z.number(),
    cost_usd: z.number(),
    last_status_change_at: z.string(),
    finished_at: z.string().optional(),
    pull_requests: openedPullRequests,
  })
  .transform(
    (run): RunSummary => ({
      runId: run.run_id,
      title: run.title,
      outcome: run.outcome,
      ownerDev: run.owner_dev,
      progress: { nodesDone: run.nodes_done, nodesTotal: run.nodes_total },
      costUsd: run.cost_usd,
      lastStatusChangeAt: run.last_status_change_at,
      ...(run.finished_at === undefined ? {} : { finishedAt: run.finished_at }),
      pullRequests: run.pull_requests,
    }),
  )

const runId = z.object({ run_id: z.string() })

export const runListSchema = z
  .object({
    runs: z.array(z.unknown()).default([]),
    runs_beyond_limit: z.number().default(0),
    runs_matched: z.number().default(0),
  })
  .transform((list): RunList => {
    const runs: RunSummary[] = []
    const unreadable: string[] = []
    for (const row of list.runs) {
      const run = runSummary.safeParse(row)
      if (run.success) runs.push(run.data)
      else unreadable.push(runId.safeParse(row).data?.run_id ?? '')
    }
    return { runs, unreadable, beyondLimit: list.runs_beyond_limit, matched: list.runs_matched }
  })

const node = z
  .object({
    task_id: z.string(),
    name: z.string(),
    executor: z.string(),
    status: z.enum([...NODE_STATUSES, 'unknown']).catch('unknown'),
    depends_on: z.array(z.string()).default([]),
    when: z.string().optional(),
    always_run: z.boolean().default(false),
    skipped: z.boolean().default(false),
    cost_usd: z.number().default(0),
    budget: z.string().optional(),
    started_at: z.string().optional(),
    completed_at: z.string().optional(),
    error: z.string().optional(),
  })
  .transform(
    (node): RunNode => ({
      taskId: node.task_id,
      name: node.name,
      executor: node.executor,
      status: node.skipped ? 'skipped' : node.status,
      dependsOn: node.depends_on,
      ...(node.when === undefined ? {} : { when: node.when }),
      alwaysRun: node.always_run,
      costUsd: node.cost_usd,
      budgetUsd: budgetLimit(node.budget),
      ...(node.started_at === undefined ? {} : { startedAt: node.started_at }),
      ...(node.completed_at === undefined ? {} : { completedAt: node.completed_at }),
      ...(node.error === undefined ? {} : { error: node.error }),
    }),
  )

export const runDetailSchema = z
  .object({
    run_id: z.string(),
    total_cost_usd: z.number(),
    nodes: z.array(node),
    pull_requests: openedPullRequests,
  })
  .transform(
    (run): RunDetail => ({
      runId: run.run_id,
      totalCostUsd: run.total_cost_usd,
      nodes: run.nodes,
      pullRequests: run.pull_requests,
    }),
  )

export const artifactSchema = z
  .object({
    artifact_id: z.string(),
    kind: z.string(),
    content_type: z.string(),
    size_bytes: z.number(),
    content: z.string(),
  })
  .transform(
    (artifact): Artifact => ({
      artifactId: artifact.artifact_id,
      kind: artifact.kind,
      contentType: artifact.content_type,
      sizeBytes: artifact.size_bytes,
      content: artifact.content,
    }),
  )

export const acEvidenceSchema = z
  .string()
  .transform((content, ctx) => {
    try {
      return JSON.parse(content) as unknown
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not JSON' })
      return z.NEVER
    }
  })
  .pipe(
    z.object({
      all_met: z.boolean(),
      acs: z.array(
        z.object({
          id: z.string(),
          met: z.boolean(),
          evidence: z.string().default(''),
          images: z.array(z.string()).default([]),
        }),
      ),
    }),
  )
  .transform(
    (result): AcEvidence => ({
      allMet: result.all_met,
      acs: result.acs.map(({ id, met, evidence, images }) => ({ id, met, evidence, images })),
    }),
  )

export const taskLogsSchema = z
  .object({
    attempts: z
      .array(
        z.object({
          attempt: z.number(),
          artifacts: z
            .array(
              z.object({
                artifact_id: z.string(),
                kind: z.string(),
                content_type: z.string().default(''),
                size_bytes: z.number().default(0),
              }),
            )
            .default([]),
        }),
      )
      .default([]),
  })
  .transform(({ attempts }): ArtifactEntry[] =>
    [...attempts]
      .sort((a, b) => b.attempt - a.attempt)
      .flatMap(({ attempt, artifacts }) =>
        artifacts.map((artifact) => ({
          artifactId: artifact.artifact_id,
          kind: artifact.kind,
          contentType: artifact.content_type,
          sizeBytes: artifact.size_bytes,
          attempt,
        })),
      ),
  )

export const taskShowSchema = z
  .object({ name: z.string(), acceptance_criteria_list: z.array(z.string()).default([]) })
  .transform((task): TaskShow => ({ name: task.name, acceptanceCriteria: task.acceptance_criteria_list }))

export const identitySchema = z
  .object({ email: z.string().optional() })
  .transform((identity): Identity => ({ email: identity.email ?? null }))

function budgetLimit(budget: string | undefined): number | null {
  const limit = budget?.match(/\/\$([\d.]+)/)?.[1]
  return limit === undefined ? null : Number(limit)
}
