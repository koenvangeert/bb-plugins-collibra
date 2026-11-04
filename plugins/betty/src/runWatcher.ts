import { z } from 'zod'
import type { PestoClient } from './pesto/client'
import { RUN_STATUSES, runStatus, type RunStatus } from './runChip'
import type { ThreadRunSdk } from './threadRun'

export const WATCH_INTERVAL_MS = 30_000

export type WatchedRun = { runId: string; threadId: string; status: RunStatus }

export interface WatchDatabase {
  prepare(sql: string): {
    run(...params: string[]): unknown
    all(...params: string[]): unknown[]
  }
}

const NOTICE: Record<RunStatus, string | null> = {
  needs_decision: 'needs a decision',
  failed: 'failed',
  cancelled: 'was cancelled',
  succeeded: 'finished',
  running: null,
  unknown: null,
}

const FINAL_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled']

const watchedRow = z
  .object({ run_id: z.string(), thread_id: z.string(), status: z.enum(RUN_STATUSES) })
  .transform(({ run_id, thread_id, status }): WatchedRun => ({ runId: run_id, threadId: thread_id, status }))

export function createRunWatcher(deps: {
  db: WatchDatabase
  pesto: Pick<PestoClient, 'dagStatus'>
  sdk: Pick<ThreadRunSdk['threads'], 'send'>
  isSignedIn: () => boolean
  log: (line: string) => void
}) {
  const { db, pesto, sdk, isSignedIn, log } = deps

  const watch = ({ runId, threadId, status }: WatchedRun) => {
    db.prepare(
      `INSERT INTO watched_runs (run_id, thread_id, status) VALUES (?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET thread_id = excluded.thread_id, status = excluded.status`,
    ).run(runId, threadId, status)
  }

  const activeRuns = (): WatchedRun[] =>
    db
      .prepare(`SELECT run_id, thread_id, status FROM watched_runs WHERE status NOT IN (${FINAL_STATUSES.map(() => '?').join(', ')})`)
      .all(...FINAL_STATUSES)
      .flatMap((row) => {
        const parsed = watchedRow.safeParse(row)
        return parsed.success ? [parsed.data] : []
      })

  const check = async (run: WatchedRun) => {
    const status = runStatus((await pesto.dagStatus(run.runId)).nodes)
    if (status === run.status) return
    const notice = NOTICE[status]
    if (notice) {
      const text = `BETTY run \`${run.runId}\` ${notice}.`
      await sdk.send({ threadId: run.threadId, input: [{ type: 'text', text, mentions: [] }], mode: 'queue-if-active' })
    }
    watch({ ...run, status })
  }

  const tick = async (signal: AbortSignal) => {
    if (!isSignedIn()) return
    for (const run of activeRuns()) {
      if (signal.aborted) return
      try {
        await check(run)
      } catch (error) {
        log(`Could not check BETTY run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return {
    watch,
    async run(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        await tick(signal)
        await wait(WATCH_INTERVAL_MS, signal)
      }
    },
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
