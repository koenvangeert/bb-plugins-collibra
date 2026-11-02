import { experimental_useRpcQuery, useBbNavigate } from '@get-bb/plugin-sdk/app'
import type { PullRequest, RunNode } from '../pesto/types'
import { rpcContract } from '../rpc'
import { OUTCOME_STYLE, PR_STATE_STYLE } from '../runs/board'
import { actionLabel, baseMayMislead, dagColumns, runCondition, spendCeilings, STEP_STATUS_STYLE } from '../runs/detail'
import { money } from './format'
import { useRefresh } from './refresh'

export function RunDetail({ runId }: { runId: string }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'runDetail', input: { runId } })
  const list = experimental_useRpcQuery({ contract: rpcContract, method: 'myRuns', input: null })
  const summary = list.data?.runs.find((run) => run.runId === runId)
  useRefresh(query.refetch)
  useRefresh(list.refetch)

  if (query.error && !query.data) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>
  if (!query.data) return <p className="text-sm text-muted-foreground">Loading the run.</p>

  const { nodes, pullRequests, totalCostUsd } = query.data
  const ceilings = spendCeilings(nodes)
  const outcome = summary && OUTCOME_STYLE[summary.outcome]

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="m-0 text-lg font-semibold">{summary?.title ?? runId}</h2>
          {outcome && <span className={`text-sm font-medium ${outcome.text}`}>{outcome.label}</span>}
        </div>
        <span className="font-mono text-xs text-muted-foreground">{runId}</span>
        <p className="m-0 text-sm">
          Spent <span className="tabular-nums">{money(totalCostUsd)}</span>
        </p>
        <p className="m-0 text-xs text-muted-foreground">
          Clean run up to {money(ceilings.cleanRunUsd)} · Worst case up to {money(ceilings.worstCaseUsd)} (one attempt per step)
        </p>
      </header>
      {query.error && <p role="alert" className="m-0 text-sm text-destructive">{query.error.message}</p>}
      {pullRequests.map((pr) => (
        <PullRequestSection key={pr.url} pr={pr} />
      ))}
      <Steps nodes={nodes} />
    </div>
  )
}

function PullRequestSection({ pr }: { pr: PullRequest }) {
  const navigate = useBbNavigate()
  const state = PR_STATE_STYLE[pr.state]
  return (
    <section aria-label={`Pull request #${pr.number}`} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <button
          type="button"
          className={`rounded-full border px-2 py-0.5 text-xs hover:bg-accent ${state.className}`}
          onClick={() => navigate.openUrl(pr.url)}
        >
          Open PR #{pr.number}
        </button>
        <span className="text-xs text-muted-foreground">{state.label}</span>
        <span>{pr.repo}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {pr.head} → {pr.base}
        </span>
      </div>
      {baseMayMislead(pr) && (
        <p role="status" className="m-0 rounded-md border border-amber-500 px-3 py-2 text-sm text-amber-600">
          Base is {pr.base}, not main. CI may run only a few checks, so a green CI can mislead.
        </p>
      )}
      {pr.actedOnBy.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {pr.actedOnBy.map((action) => {
            const label = `${actionLabel(action.kind)} by ${action.name}`
            const url = action.url
            return (
              <li key={`${action.taskId}-${action.kind}`} className="flex items-center gap-2">
                {url ? (
                  <button type="button" className="text-left underline" onClick={() => navigate.openUrl(url)}>
                    {label}
                  </button>
                ) : (
                  <span>{label}</span>
                )}
                {action.predicted && <span className="text-xs text-muted-foreground">planned</span>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Steps({ nodes }: { nodes: RunNode[] }) {
  return (
    <section aria-label="Steps" className="flex gap-3 overflow-x-auto pb-2">
      {dagColumns(nodes).map((column, index) => (
        <ul key={index} className="m-0 flex w-56 shrink-0 list-none flex-col gap-2 p-0">
          {column.map((node) => (
            <StepCard key={node.taskId} node={node} />
          ))}
        </ul>
      ))}
    </section>
  )
}

function StepCard({ node }: { node: RunNode }) {
  const status = STEP_STATUS_STYLE[node.status]
  return (
    <li aria-label={node.name} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-sm">
      <span className="truncate font-medium" title={node.name}>
        {node.name}
      </span>
      <span className="flex justify-between gap-2 text-xs">
        <span className={status.className}>{status.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {node.budgetUsd === null ? node.executor : `${money(node.costUsd)}/${money(node.budgetUsd)}`}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">{runCondition(node)}</span>
    </li>
  )
}
