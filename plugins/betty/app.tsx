import { useEffect, useRef, useState } from 'react'
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  useBbNavigate,
  type ExperimentalThreadActionTabProps,
  type PluginThreadHeaderActionProps,
} from '@get-bb/plugin-sdk/app'
import { rpcContract } from './src/rpc'
import { chipLabel, chipProgress, type ThreadRun } from './src/runChip'
import { OUTCOME_STYLE } from './src/runs/board'
import { PullRequestChip, RunsPage } from './src/ui/RunsPage'
import { SignInGate } from './src/ui/SignInGate'

const RUN_TAB = 'betty-run'
const POLL_MS = 30_000

function useThreadRun(threadId: string) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'threadRun', input: { threadId } })
  const refetch = useRef(query.refetch)
  refetch.current = query.refetch
  useEffect(() => {
    const poll = setInterval(() => void refetch.current(), POLL_MS)
    return () => clearInterval(poll)
  }, [])
  return query
}

function ThreadRunHeader({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { data: run } = useThreadRun(threadId)
  const start = experimental_useRpcMutation({ contract: rpcContract, method: 'startRun' })
  const [sent, setSent] = useState(false)
  const navigate = useBbNavigate()
  if (!run) return null

  if (run.kind === 'linked') {
    return (
      <button
        type="button"
        title={chipLabel(run.chip)}
        aria-label={chipLabel(run.chip)}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums hover:bg-accent"
        onClick={() => navigate.openThreadPanel({ actionId: RUN_TAB })}
      >
        <Icon name="Workflow" className="size-3.5" aria-hidden />
        <span className={`size-2 rounded-full ${OUTCOME_STYLE[run.chip?.status ?? 'unknown'].fill}`} />
        {run.chip && !isCompactViewport && chipProgress(run.chip)}
      </button>
    )
  }

  return (
    <button
      type="button"
      className={`h-7 rounded-md px-2 text-xs hover:bg-accent disabled:opacity-50 ${start.error ? 'text-destructive' : ''}`}
      title={start.error?.message}
      disabled={start.isPending || sent}
      onClick={() => start.mutate({ threadId }).then(() => setSent(true), () => {})}
    >
      {run.ticketKey && !isCompactViewport ? `Run with BETTY · ${run.ticketKey}` : 'Run with BETTY'}
    </button>
  )
}

function ThreadRunPanel({ threadId }: ExperimentalThreadActionTabProps) {
  const { data: run } = useThreadRun(threadId)
  return (
    <SignInGate>
      <div className="flex flex-col items-start gap-2">{run && <RunDetails run={run} />}</div>
    </SignInGate>
  )
}

function RunDetails({ run }: { run: ThreadRun }) {
  if (run.kind === 'none') return <p className="text-sm text-muted-foreground">No BETTY run for this thread yet.</p>

  return (
    <>
      <p className="font-mono text-xs text-muted-foreground">{run.runId}</p>
      <p className="text-sm">{chipLabel(run.chip)}</p>
      {run.error && <p className="text-sm text-destructive">{run.error}</p>}
      {run.pullRequests.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {run.pullRequests.map((pr) => (
            <PullRequestChip key={pr.url} pr={pr} />
          ))}
        </div>
      )}
    </>
  )
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: 'runs', title: 'BETTY', icon: 'Workflow', path: 'runs', component: RunsPage })
  app.slots.experimental_tab({
    context: { kind: 'thread' },
    availability: 'action',
    id: RUN_TAB,
    title: 'BETTY run',
    icon: 'Workflow',
    layout: 'padded',
    component: ThreadRunPanel,
    run: ({ openPanel }) => {
      openPanel()
    },
  })
  app.slots.experimental_threadHeaderAction({
    id: 'betty-run-chip',
    title: 'BETTY run',
    component: ThreadRunHeader,
  })
})
