import { z } from 'zod'
import {
  NODE_STATUSES,
  PULL_REQUEST_STATES,
  RUN_OUTCOMES,
  type Artifact,
  type PullRequest,
  type RunDetail,
  type RunList,
  type RunNode,
} from './types'

const pullRequest = z
  .object({
    number: z.number(),
    url: z.string(),
    state: z.enum([...PULL_REQUEST_STATES, 'unknown']).catch('unknown'),
    base: z.string(),
    head: z.string(),
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
  .transform(
    (pr): PullRequest => ({
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
    }),
  )

export const runListSchema = z
  .object({
    runs: z.array(
      z.object({
        run_id: z.string(),
        title: z.string(),
        outcome: z.enum([...RUN_OUTCOMES, 'unknown']).catch('unknown'),
        owner_dev: z.string(),
        nodes_done: z.number(),
        nodes_total: z.number(),
        cost_usd: z.number(),
        last_status_change_at: z.string(),
        finished_at: z.string().optional(),
        pull_requests: z.array(pullRequest).default([]),
      }),
    ),
    runs_beyond_limit: z.number(),
    runs_matched: z.number(),
  })
  .transform(
    (list): RunList => ({
      runs: list.runs.map((run) => ({
        runId: run.run_id,
        title: run.title,
        outcome: run.outcome,
        ownerDev: run.owner_dev,
        progress: { nodesDone: run.nodes_done, nodesTotal: run.nodes_total },
        costUsd: run.cost_usd,
        lastStatusChangeAt: run.last_status_change_at,
        ...(run.finished_at === undefined ? {} : { finishedAt: run.finished_at }),
        pullRequests: run.pull_requests,
      })),
      beyondLimit: list.runs_beyond_limit,
      matched: list.runs_matched,
    }),
  )

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
  })
  .transform(
    (node): RunNode => ({
      taskId: node.task_id,
      name: node.name,
      executor: node.executor,
      status: node.status,
      dependsOn: node.depends_on,
      ...(node.when === undefined ? {} : { when: node.when }),
      alwaysRun: node.always_run,
      skipped: node.skipped,
      costUsd: node.cost_usd,
      budgetUsd: budgetLimit(node.budget),
      ...(node.started_at === undefined ? {} : { startedAt: node.started_at }),
      ...(node.completed_at === undefined ? {} : { completedAt: node.completed_at }),
    }),
  )

export const runDetailSchema = z
  .object({
    run_id: z.string(),
    total_cost_usd: z.number(),
    nodes: z.array(node),
    pull_requests: z.array(pullRequest).default([]),
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

function budgetLimit(budget: string | undefined): number | null {
  const limit = budget?.match(/\/\$([\d.]+)/)?.[1]
  return limit === undefined ? null : Number(limit)
}
