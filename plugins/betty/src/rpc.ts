import { defineRpcContract } from '@get-bb/plugin-sdk'
import { z } from 'zod'
import { AUTH_KINDS } from './auth/state'
import { PULL_REQUEST_STATES, RUN_OUTCOMES, type RunSummary } from './pesto/types'
import type { MyRuns } from './runs/myRuns'

const runSummary = z.object({
  runId: z.string(),
  title: z.string(),
  outcome: z.enum([...RUN_OUTCOMES, 'unknown']),
  ownerDev: z.string(),
  progress: z.object({ nodesDone: z.number(), nodesTotal: z.number() }),
  costUsd: z.number(),
  lastStatusChangeAt: z.string(),
  finishedAt: z.string().optional(),
  pullRequests: z.array(
    z.object({
      number: z.number(),
      url: z.string(),
      state: z.enum([...PULL_REQUEST_STATES, 'unknown']),
      base: z.string(),
      head: z.string(),
      repo: z.string(),
      actedOnBy: z.array(
        z.object({ kind: z.string(), name: z.string(), taskId: z.string(), url: z.string().optional(), predicted: z.boolean() }),
      ),
    }),
  ),
}) satisfies z.ZodType<RunSummary>

const myRuns = z.object({ refreshedAt: z.number(), runs: z.array(runSummary), cutOff: z.boolean(), unreadable: z.number() }) satisfies z.ZodType<MyRuns>

export const rpcContract = defineRpcContract({
  authStatus: { input: z.null(), output: z.object({ state: z.enum(AUTH_KINDS) }) },
  startSignIn: { input: z.null(), output: z.object({ url: z.url({ protocol: /^https$/ }) }) },
  myRuns: { input: z.null(), output: myRuns },
})
