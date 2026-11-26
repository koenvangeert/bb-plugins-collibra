import { defineRpcContract } from '@get-bb/plugin-sdk'
import { z } from 'zod'
import type { DashboardInput, HealthDashboard, HealthService } from './healthService'
import { WINDOW_DAYS } from './metrics'

const groupStats = z.object({
  merged: z.number(),
  avgReviewerComments: z.number().nullable(),
  medianHoursToMerge: z.number().nullable(),
  avgHoursToMerge: z.number().nullable(),
})

const windowDays = z.union(WINDOW_DAYS.map((days) => z.literal(days)))

const dailyFigures = z.object({
      day: z.string(),
      betty: z.number(),
      other: z.number(),
      avgReviewerComments: z.number().nullable(),
      medianHoursToMerge: z.number().nullable(),
      rolling: z.object({
        mergedPerDay: z.number(),
        avgReviewerComments: z.number().nullable(),
        medianHoursToMerge: z.number().nullable(),
        bettyShare: z.number().nullable(),
      }),
    })

const metrics = z.object({
  daily: z.array(dailyFigures),
  mergedPerDay: z.number(),
  bettyShare: z.number().nullable(),
  all: groupStats,
  betty: groupStats,
  other: groupStats,
})

const dashboard = z.object({
  repos: z.array(z.string()),
  repo: z.string().nullable(),
  teams: z.array(z.string()),
  team: z.string().nullable(),
  viewer: z.string().nullable(),
  windowDays,
  metrics,
  baseline: metrics.nullable(),
  byRepo: z.array(z.object({ repo: z.string(), daily: z.array(dailyFigures) })).nullable(),
  syncing: z.boolean(),
  historyDaysRead: z.number(),
  historyDaysTotal: z.number(),
  errors: z.array(z.object({ repo: z.string(), message: z.string() })),
  syncedAt: z.number().nullable(),
}) satisfies z.ZodType<HealthDashboard>

export type Dashboard = z.infer<typeof dashboard>

export const rpcContract = defineRpcContract({
  dashboard: {
    input: z.object({ windowDays, repo: z.string().nullable(), team: z.string().nullable() }).strict(),
    output: dashboard,
  },
})

export function createRpcHandlers(service: HealthService) {
  return { dashboard: (input: DashboardInput) => service.dashboard(input) }
}
