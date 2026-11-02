import { useEffect } from 'react'
import { experimental_useRpcQuery, useBbNavigate } from '@get-bb/plugin-sdk/app'
import type { PullRequest, RunSummary } from '../pesto/types'
import { rpcContract } from '../rpc'
import { board, OUTCOME_STYLE, PR_STATE_STYLE, type RunGroup } from '../runs/board'
import { RECENT_DAYS, RUN_LIST_LIMIT } from '../runs/myRuns'
import { SignInGate } from './SignInGate'

const REFRESH_MS = 30_000

const money = (usd: number) => `$${usd.toFixed(2)}`
const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour12: false })
const dateTime = (at: string) => new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

export function RunsPage() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <h2 className="m-0 text-lg font-semibold">My BETTY runs</h2>
      <SignInGate>
        <RunBoard />
      </SignInGate>
    </div>
  )
}

function RunBoard() {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'myRuns', input: null })
  const { refetch } = query

  useEffect(() => {
    const timer = setInterval(() => void refetch(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [refetch])

  if (query.error && !query.data) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>
  if (!query.data) return <p className="text-sm text-muted-foreground">Loading runs.</p>

  const { runs, refreshedAt, cutOff, unreadable } = query.data
  const { groups, spendUsd } = board(runs)
  const tiles = [...groups.map((group) => ({ label: group.label, value: String(group.runs.length) })), { label: 'Spend', value: money(spendUsd) }]

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-xs text-muted-foreground">Updated {clock(refreshedAt)}</p>
      {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message}</p>}
      <section aria-label="Totals" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{tile.label}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{tile.value}</div>
          </div>
        ))}
      </section>
      {cutOff && (
        <p role="status" className="m-0 text-sm text-muted-foreground">
          Showing the newest {RUN_LIST_LIMIT} runs. Older runs are cut off.
        </p>
      )}
      {unreadable > 0 && (
        <p role="status" className="m-0 text-sm text-muted-foreground">
          {unreadable === 1 ? '1 run is not shown, because' : `${unreadable} runs are not shown, because`} BETTY sent data
          that bb cannot read.
        </p>
      )}
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs in the last {RECENT_DAYS} days.</p>
      ) : (
        groups.filter((group) => group.runs.length > 0).map((group) => <GroupSection key={group.id} group={group} />)
      )}
    </div>
  )
}

function GroupSection({ group }: { group: RunGroup }) {
  return (
    <section aria-label={group.label} className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{group.label}</h3>
      <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
        {group.runs.map((run) => (
          <RunRow key={run.runId} run={run} />
        ))}
      </ul>
    </section>
  )
}

function RunRow({ run }: { run: RunSummary }) {
  return (
    <li className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="text-sm font-medium">{run.title}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className={`font-medium ${OUTCOME_STYLE[run.outcome].className}`}>{OUTCOME_STYLE[run.outcome].label}</span>
        <span>
          {run.progress.nodesDone}/{run.progress.nodesTotal} nodes
        </span>
        <span className="tabular-nums">{money(run.costUsd)}</span>
        <span>{dateTime(run.lastStatusChangeAt)}</span>
        {run.pullRequests.map((pr) => (
          <PullRequestChip key={pr.url} pr={pr} />
        ))}
      </div>
    </li>
  )
}

function PullRequestChip({ pr }: { pr: PullRequest }) {
  const navigate = useBbNavigate()
  const style = PR_STATE_STYLE[pr.state]
  return (
    <button
      type="button"
      title={`${pr.repo}#${pr.number}`}
      className={`rounded-full border px-2 py-0.5 text-xs hover:bg-accent ${style.className}`}
      onClick={() => navigate.openUrl(pr.url)}
    >
      #{pr.number} {style.label}
    </button>
  )
}
