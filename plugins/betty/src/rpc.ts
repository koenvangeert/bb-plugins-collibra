import { defineRpcContract } from '@get-bb/plugin-sdk'
import { z } from 'zod'
import { AUTH_KINDS } from './auth/state'
import { NODE_STATUSES, PULL_REQUEST_STATES, RUN_OUTCOMES, type PullRequest, type RunDetail, type RunSummary } from './pesto/types'
import type { MyRuns } from './runs/myRuns'

const pullRequest = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum([...PULL_REQUEST_STATES, 'unknown']),
  base: z.string(),
  head: z.string(),
  repo: z.string(),
  actedOnBy: z.array(
    z.object({ kind: z.string(), name: z.string(), taskId: z.string(), url: z.string().optional(), predicted: z.boolean() }),
  ),
}) satisfies z.ZodType<PullRequest>

const runSummary = z.object({
  runId: z.string(),
  title: z.string(),
  outcome: z.enum([...RUN_OUTCOMES, 'unknown']),
  ownerDev: z.string(),
  progress: z.object({ nodesDone: z.number(), nodesTotal: z.number() }),
  costUsd: z.number(),
  lastStatusChangeAt: z.string(),
  finishedAt: z.string().optional(),
  pullRequests: z.array(pullRequest),
}) satisfies z.ZodType<RunSummary>

const myRuns = z.object({ refreshedAt: z.number(), runs: z.array(runSummary), cutOff: z.boolean(), unreadable: z.number() }) satisfies z.ZodType<MyRuns>
import { RUN_STATUSES, type ThreadRun } from './runChip'

const threadInput = z.object({ threadId: z.string().min(1) })

const runChipSchema = z.object({
  status: z.enum(RUN_STATUSES),
  nodesDone: z.number(),
  nodesTotal: z.number(),
  costUsd: z.number(),
})

const threadRunSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), ticketKey: z.string().nullable() }),
  z.object({
    kind: z.literal('linked'),
    runId: z.string(),
    chip: runChipSchema.nullable(),
    pullRequests: z.array(z.object({ number: z.number(), url: z.string(), state: z.enum([...PULL_REQUEST_STATES, 'unknown']), repo: z.string() })),
    error: z.string().nullable(),
  }),
]) satisfies z.ZodType<ThreadRun>

const runDetail = z.object({
  runId: z.string(),
  totalCostUsd: z.number(),
  nodes: z.array(
    z.object({
      taskId: z.string(),
      name: z.string(),
      executor: z.string(),
      status: z.enum([...NODE_STATUSES, 'unknown']),
      dependsOn: z.array(z.string()),
      when: z.string().optional(),
      alwaysRun: z.boolean(),
      costUsd: z.number(),
      budgetUsd: z.number().nullable(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  pullRequests: z.array(pullRequest),
}) satisfies z.ZodType<RunDetail>

export const rpcContract = defineRpcContract({
  authStatus: { input: z.null(), output: z.object({ state: z.enum(AUTH_KINDS) }) },
  startSignIn: { input: z.null(), output: z.object({ url: z.url({ protocol: /^https$/ }) }) },
  myRuns: { input: z.null(), output: myRuns },
  threadRun: { input: threadInput, output: threadRunSchema },
  startRun: { input: threadInput, output: z.null() },
  runDetail: { input: z.object({ runId: z.string().min(1) }), output: runDetail },
})
