import { useState } from 'react'
import { experimental_Icon as Icon, experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from '@get-bb/plugin-sdk/app'
import type { PullRequest, PullRequestAction, RunNode, RunSummary } from '../pesto/types'
import { rpcContract } from '../rpc'
import { OUTCOME_STYLE, PR_STATE_STYLE } from '../runs/board'
import { approveBudget, stopPlan } from '../runs/decide'
import {
  actionIcon,
  actionLabel,
  attentionFirst,
  baseMayMislead,
  dagColumns,
  nextAction,
  orderedActions,
  spendCeilings,
  spendMeter,
  STEP_STATUS_STYLE,
  stepConditions,
  stepProgress,
  type NextAction,
  type SpendMeter,
} from '../runs/detail'
import { money } from './format'
import { useRefresh } from './refresh'

const EXECUTOR_ICON: Record<string, string> = { agent: 'Bot', script: 'Terminal', publisher: 'Sent' }

const SPEND_TONE: Record<SpendMeter['tone'], string> = {
  clean: 'bg-green-500',
  'over-clean': 'bg-amber-500',
  'over-worst': 'bg-red-500',
}

const NEXT_ACTION_STYLE: Record<NextAction['kind'], { icon: string; className: string; spin?: boolean }> = {
  decide: { icon: 'Pause', className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  failed: { icon: 'CircleX', className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400' },
  running: { icon: 'Loading', className: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400', spin: true },
  done: { icon: 'CircleCheck', className: 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400' },
  cancelled: { icon: 'Unavailable', className: 'border-border bg-muted/40 text-muted-foreground' },
  waiting: { icon: 'Clock', className: 'border-border bg-muted/40 text-muted-foreground' },
}

function nextActionText(action: NextAction): string {
  switch (action.kind) {
    case 'decide':
      return `${action.step} stopped and needs a decision`
    case 'failed':
      return `${action.step} failed`
    case 'running':
      return `Now: ${action.steps.join(', ')}`
    case 'done':
      return 'Every step is done'
    case 'cancelled':
      return 'The run was cancelled'
    case 'waiting':
      return 'Waiting for the next step'
  }
}

export function RunDetail({ runId, compact = false }: { runId: string; compact?: boolean }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'runDetail', input: { runId } })
  const list = experimental_useRpcQuery({ contract: rpcContract, method: 'myRuns', input: null })
  const summary = list.data?.runs.find((run) => run.runId === runId)
  useRefresh(query.refetch)
  useRefresh(list.refetch)

  if (query.error && !query.data) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>
  if (!query.data) return <p className="text-sm text-muted-foreground">Loading the run.</p>

  const { nodes, pullRequests, totalCostUsd } = query.data

  return (
    <div className="flex flex-col gap-4">
      <Header runId={runId} summary={summary} nodes={nodes} spentUsd={totalCostUsd} compact={compact} onChange={query.refetch} />
      {query.error && <p role="alert" className="m-0 text-sm text-destructive">{query.error.message}</p>}
      {pullRequests.map((pr) => (
        <PullRequestCard key={pr.url} pr={pr} />
      ))}
      {compact ? <CompactSteps nodes={nodes} /> : <StepColumns nodes={nodes} />}
    </div>
  )
}

function Header({
  runId,
  summary,
  nodes,
  spentUsd,
  compact,
  onChange,
}: {
  runId: string
  summary: RunSummary | undefined
  nodes: RunNode[]
  spentUsd: number
  compact: boolean
  onChange: () => unknown
}) {
  const outcome = summary && OUTCOME_STYLE[summary.outcome]
  const plan = stopPlan(nodes)
  const [stopping, setStopping] = useState(false)
  return (
    <header className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h2 className={`m-0 min-w-0 font-semibold leading-snug ${compact ? 'text-base' : 'text-lg'}`} title={compact ? runId : undefined}>
            {summary?.title ?? runId}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {outcome && (
              <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${outcome.pill}`}>
                <Icon name={outcome.icon} fallback="Circle" aria-hidden className={`size-3.5 ${summary?.outcome === 'running' ? 'animate-spin' : ''}`} />
                {outcome.label}
              </span>
            )}
            {!stopping && plan.steps.length > 0 && (
              <button type="button" className={BUTTON} onClick={() => setStopping(true)}>
                Stop run
              </button>
            )}
          </div>
        </div>
        {!compact && <span className="font-mono text-xs text-muted-foreground">{runId}</span>}
      </div>
      <StopRun runId={runId} plan={plan} confirming={stopping} onClose={() => setStopping(false)} onChange={onChange} />
      <NextActionCallout action={nextAction(nodes)} />
      {nodes
        .filter((node) => node.status === 'suspended')
        .map((node) => (
          <DecisionCard key={node.taskId} node={node} onChange={onChange} />
        ))}
      <SpendBar spentUsd={spentUsd} nodes={nodes} />
      {!compact && <StepProgress nodes={nodes} />}
    </header>
  )
}

const BUTTON = 'rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50'
const FIELD = 'rounded-md border border-border bg-background px-2 py-1 text-sm'

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function StopRun({
  runId,
  plan,
  confirming,
  onClose,
  onChange,
}: {
  runId: string
  plan: ReturnType<typeof stopPlan>
  confirming: boolean
  onClose: () => void
  onChange: () => unknown
}) {
  const stop = experimental_useRpcMutation({ contract: rpcContract, method: 'stopRun' })
  const [failed, setFailed] = useState<{ step: string; error: string }[]>([])
  const names = plan.stillRuns.map((node) => node.name)

  const submit = () =>
    stop.mutate({ runId }).then(
      (result) => {
        setFailed(result.failed)
        onClose()
        void onChange()
      },
      () => {},
    )

  return (
    <>
      {confirming && plan.steps.length > 0 && (
        <div role="group" aria-label="Stop the run" className="flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
          <p className="m-0">
            Stop {plural(plan.steps.length, 'step')}?
            {names.length > 0 && ` ${names.join(', ')} still ${names.length === 1 ? 'runs' : 'run'}.`}
          </p>
          <div className="flex gap-2">
            <button type="button" className={BUTTON} disabled={stop.isPending} onClick={submit}>
              Stop run
            </button>
            <button type="button" className={BUTTON} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {stop.error && <p role="alert" className="m-0 text-sm text-destructive">{stop.error.message}</p>}
      {failed.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          <span>Could not stop {plural(failed.length, 'step')}:</span>
          <ul className="m-0 pl-4">
            {failed.map(({ step, error }) => (
              <li key={step}>
                {step}: {error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function DecisionCard({ node, onChange }: { node: RunNode; onChange: () => unknown }) {
  const [form, setForm] = useState<'approve' | 'deny' | null>(null)
  const done = () => {
    setForm(null)
    void onChange()
  }
  return (
    <section aria-label={`Decide on ${node.name}`} className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{node.name}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          Spent {money(node.costUsd)}
          {node.budgetUsd !== null && ` of ${money(node.budgetUsd)}`}
        </span>
      </div>
      {node.error && <p className="m-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">{node.error}</p>}
      <div className="flex gap-2">
        <button type="button" aria-expanded={form === 'approve'} className={BUTTON} onClick={() => setForm(form === 'approve' ? null : 'approve')}>
          Approve
        </button>
        <button type="button" aria-expanded={form === 'deny'} className={BUTTON} onClick={() => setForm(form === 'deny' ? null : 'deny')}>
          Deny
        </button>
      </div>
      {form === 'approve' && <ApproveForm node={node} onDone={done} />}
      {form === 'deny' && <DenyForm node={node} onDone={done} />}
    </section>
  )
}

function ApproveForm({ node, onDone }: { node: RunNode; onDone: () => void }) {
  const approve = experimental_useRpcMutation({ contract: rpcContract, method: 'approveStep' })
  const [budget, setBudget] = useState(String(approveBudget(node) ?? ''))
  const [hint, setHint] = useState('')
  const budgetUsd = Number(budget)
  const aboveSpend = budget.trim() !== '' && budgetUsd > node.costUsd
  return (
    <form
      aria-label={`Approve ${node.name}`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = hint.trim()
        approve.mutate({ taskId: node.taskId, budgetUsd, ...(trimmed ? { hint: trimmed } : {}) }).then(onDone, () => {})
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        New budget (USD)
        <input type="number" min="0" step="any" className={FIELD} value={budget} onChange={(event) => setBudget(event.target.value)} />
      </label>
      {!aboveSpend && <p className="m-0 text-xs text-destructive">The budget must be more than the {money(node.costUsd)} this step spent.</p>}
      <label className="flex flex-col gap-1 text-xs">
        Hint (optional)
        <textarea rows={2} className={FIELD} value={hint} onChange={(event) => setHint(event.target.value)} />
      </label>
      <button type="submit" className={`${BUTTON} self-start`} disabled={!aboveSpend || approve.isPending}>
        Approve
      </button>
      {approve.error && <p role="alert" className="m-0 text-sm text-destructive">{approve.error.message}</p>}
    </form>
  )
}

function DenyForm({ node, onDone }: { node: RunNode; onDone: () => void }) {
  const deny = experimental_useRpcMutation({ contract: rpcContract, method: 'denyStep' })
  const [reason, setReason] = useState('')
  return (
    <form
      aria-label={`Deny ${node.name}`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        deny.mutate({ taskId: node.taskId, reason }).then(onDone, () => {})
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        Reason
        <textarea rows={2} className={FIELD} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button type="submit" className={`${BUTTON} self-start`} disabled={reason.trim() === '' || deny.isPending}>
        Deny
      </button>
      {deny.error && <p role="alert" className="m-0 text-sm text-destructive">{deny.error.message}</p>}
    </form>
  )
}

function NextActionCallout({ action }: { action: NextAction }) {
  const style = NEXT_ACTION_STYLE[action.kind]
  return (
    <p className={`m-0 flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium ${style.className}`}>
      <Icon name={style.icon} fallback="Circle" aria-hidden className={`size-4 shrink-0 ${style.spin ? 'animate-spin' : ''}`} />
      {nextActionText(action)}
    </p>
  )
}

function SpendBar({ spentUsd, nodes }: { spentUsd: number; nodes: RunNode[] }) {
  const ceilings = spendCeilings(nodes)
  const meter = spendMeter(spentUsd, ceilings)
  const ceilingsText = `Clean run up to ${money(ceilings.cleanRunUsd)} · Worst case up to ${money(ceilings.worstCaseUsd)}`
  return (
    <div className="flex flex-col gap-1.5">
      <div role="img" aria-label={`Spent ${money(spentUsd)}. ${ceilingsText} (one attempt per step)`} className="relative h-2 rounded-full bg-muted">
        <div className={`h-full rounded-full ${SPEND_TONE[meter.tone]}`} style={{ width: `${meter.spentShare * 100}%` }} />
        <div className="absolute -top-1 h-4 w-0.5 rounded-full bg-foreground/50" style={{ left: `${meter.cleanShare * 100}%` }} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span>
          <span className="text-sm font-semibold tabular-nums">{money(spentUsd)}</span> spent
        </span>
        <span className="tabular-nums text-muted-foreground" title="One attempt per step">
          clean run {money(ceilings.cleanRunUsd)} · worst case {money(ceilings.worstCaseUsd)}
        </span>
      </div>
    </div>
  )
}

function StepProgress({ nodes }: { nodes: RunNode[] }) {
  const { done, total } = stepProgress(nodes)
  return (
    <div className="flex items-center gap-3">
      <SegmentedBar nodes={nodes} />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {done}/{total} steps
      </span>
    </div>
  )
}

function SegmentedBar({ nodes }: { nodes: RunNode[] }) {
  return (
    <div className="flex h-1.5 min-w-0 flex-1 gap-0.5">
      {dagColumns(nodes)
        .flat()
        .map((node) => (
          <span
            key={node.taskId}
            title={`${node.name}: ${STEP_STATUS_STYLE[node.status].label}`}
            className={`flex-1 rounded-full ${STEP_STATUS_STYLE[node.status].fill}`}
          />
        ))}
    </div>
  )
}

function PullRequestCard({ pr }: { pr: PullRequest }) {
  const navigate = useBbNavigate()
  const state = PR_STATE_STYLE[pr.state]
  return (
    <section aria-label={`Pull request #${pr.number}`} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Icon name={state.icon} fallback="Circle" aria-hidden className={`mt-0.5 size-6 shrink-0 ${state.text}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">#{pr.number}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${state.pill}`}>{state.label}</span>
            <span className="text-sm text-muted-foreground">{pr.repo}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <BranchPill name={pr.head} />
            <Icon name="ArrowRight" fallback="ChevronRight" aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <BranchPill name={pr.base} className="max-w-[45%] shrink-0" />
          </div>
        </div>
        <button
          type="button"
          aria-label={`Open PR #${pr.number}`}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent"
          onClick={() => navigate.openUrl(pr.url)}
        >
          <Icon name="ExternalLink" fallback="Circle" aria-hidden className="size-3.5" />
          Open PR
        </button>
      </div>
      {baseMayMislead(pr) && (
        <p
          role="status"
          className="m-0 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <Icon name="AlertTriangle" fallback="Circle" aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>Base is {pr.base}, not main. CI may run only a few checks, so a green CI can mislead.</span>
        </p>
      )}
      {pr.actedOnBy.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {orderedActions(pr.actedOnBy).map((action) => (
            <ActionChip key={`${action.taskId}-${action.kind}`} action={action} />
          ))}
        </ul>
      )}
    </section>
  )
}

function BranchPill({ name, className = 'min-w-0' }: { name: string; className?: string }) {
  return (
    <span className={`truncate rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground ${className}`} title={name}>
      {name}
    </span>
  )
}

function ActionChip({ action }: { action: PullRequestAction }) {
  const navigate = useBbNavigate()
  const label = `${actionLabel(action.kind)} · ${action.name}`
  const icon = <Icon name={actionIcon(action.kind)} fallback="Circle" aria-hidden className="size-3.5 shrink-0" />
  const url = action.url
  if (action.predicted || !url) {
    return (
      <li
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground ${action.predicted ? 'border-dashed' : ''}`}
      >
        {icon}
        <span>{label}</span>
        {action.predicted && <span className="italic">planned</span>}
      </li>
    )
  }
  return (
    <li>
      <button
        type="button"
        aria-label={label}
        className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-accent"
        onClick={() => navigate.openUrl(url)}
      >
        {icon}
        {label}
      </button>
    </li>
  )
}

function StepColumns({ nodes }: { nodes: RunNode[] }) {
  return (
    <section aria-label="Steps" className="flex gap-3 overflow-x-auto pb-2">
      {dagColumns(nodes).map((column, index) => (
        <div key={index} className="flex w-60 shrink-0 flex-col gap-2">
          <span className="px-1 text-xs font-medium text-muted-foreground">{index + 1}</span>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {column.map((node) => (
              <StepCard key={node.taskId} node={node} showCondition />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

function CompactSteps({ nodes }: { nodes: RunNode[] }) {
  const [open, setOpen] = useState(false)
  const { done, total } = stepProgress(nodes)
  return (
    <section aria-label="Steps" className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm hover:bg-accent"
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} fallback="Circle" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">Steps</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        <SegmentedBar nodes={nodes} />
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {attentionFirst(nodes).map((node) => (
            <StepCard key={node.taskId} node={node} showCondition={false} />
          ))}
        </ul>
      )}
    </section>
  )
}

function StepCard({ node, showCondition }: { node: RunNode; showCondition: boolean }) {
  const status = STEP_STATUS_STYLE[node.status]
  const skipped = node.status === 'skipped'
  return (
    <li
      aria-label={node.name}
      className={`flex flex-col gap-2 rounded-lg border border-l-4 border-border bg-card p-3 text-sm ${status.border} ${skipped ? 'border-dashed opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <Icon name={status.icon} fallback="Circle" aria-hidden className={`size-4 shrink-0 ${status.text} ${status.spin ? 'animate-spin' : ''}`} />
        <span className="min-w-0 flex-1 truncate font-medium" title={node.name}>
          {node.name}
        </span>
        <span title={node.executor} className="shrink-0 text-muted-foreground">
          <Icon name={EXECUTOR_ICON[node.executor] ?? 'Circle'} fallback="Circle" aria-hidden className="size-3.5" />
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={status.text}>{status.label}</span>
        {node.budgetUsd !== null && (
          <span className="tabular-nums text-muted-foreground">{`${money(node.costUsd)}/${money(node.budgetUsd)}`}</span>
        )}
      </div>
      {node.budgetUsd !== null && <StepSpend costUsd={node.costUsd} budgetUsd={node.budgetUsd} />}
      {showCondition && <StepConditions node={node} />}
    </li>
  )
}

function StepSpend({ costUsd, budgetUsd }: { costUsd: number; budgetUsd: number }) {
  const share = budgetUsd === 0 ? 0 : Math.min(costUsd / budgetUsd, 1)
  return (
    <div className="h-1 rounded-full bg-muted">
      <div className={`h-full rounded-full ${costUsd > budgetUsd ? 'bg-red-500' : 'bg-foreground/40'}`} style={{ width: `${share * 100}%` }} />
    </div>
  )
}

function StepConditions({ node }: { node: RunNode }) {
  return (
    <div className="flex flex-wrap gap-1 text-xs">
      {stepConditions(node).map((condition) => {
        switch (condition.kind) {
          case 'when':
            return (
              <ConditionChip key="when" icon="GitBranch" title={`Only when ${condition.expression}`}>
                {condition.expression}
              </ConditionChip>
            )
          case 'always':
            return (
              <ConditionChip key="always" icon="Repeat" title="Always runs">
                always
              </ConditionChip>
            )
          case 'after':
            return (
              <span key="after" className="text-muted-foreground">
                after {condition.steps.join(', ')}
              </span>
            )
          case 'first':
            return (
              <span key="first" className="text-muted-foreground">
                runs first
              </span>
            )
        }
      })}
    </div>
  )
}

function ConditionChip({ icon, title, children }: { icon: string; title: string; children: string }) {
  return (
    <span title={title} className="flex min-w-0 max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
      <Icon name={icon} fallback="Circle" aria-hidden className="size-3 shrink-0" />
      <span className="truncate font-mono">{children}</span>
    </span>
  )
}
