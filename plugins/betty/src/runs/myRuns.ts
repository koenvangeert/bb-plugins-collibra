import type { PestoClient } from '../pesto/client'
import type { RunSummary } from '../pesto/types'

export const RUN_LIST_LIMIT = 100
export const RECENT_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

export type MyRuns = { refreshedAt: number; runs: RunSummary[]; cutOff: boolean }

export async function loadMyRuns(client: Pick<PestoClient, 'listRuns'>, ownerDev: string, now: number): Promise<MyRuns> {
  const [recent, active] = await Promise.all([
    client.listRuns({
      ownerDev,
      since: new Date(now - RECENT_DAYS * DAY_MS).toISOString(),
      includeFinished: true,
      limit: RUN_LIST_LIMIT,
    }),
    client.listRuns({ ownerDev, limit: RUN_LIST_LIMIT }),
  ])
  const byId = new Map([...recent.runs, ...active.runs].map((run) => [run.runId, run]))
  return {
    refreshedAt: now,
    runs: [...byId.values()].sort((a, b) => Date.parse(b.lastStatusChangeAt) - Date.parse(a.lastStatusChangeAt)),
    cutOff: recent.beyondLimit > 0 || active.beyondLimit > 0,
  }
}
