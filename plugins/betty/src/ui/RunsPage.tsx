import { useState, type ReactNode } from 'react'
import { experimental_useRpcQuery, useBbNavigate, type PluginNavPanelProps } from '@get-bb/plugin-sdk/app'
import type { PullRequest, RunSummary } from '../pesto/types'
import { rpcContract } from '../rpc'
import {
  groupRuns,
  inTile,
  OUTCOME_STYLE,
  overview,
  PR_STATE_STYLE,
  TILES,
  type Day,
  type Overview,
  type RunGroup,
  type TileId,
} from '../runs/board'
import { RECENT_DAYS, RUN_LIST_LIMIT } from '../runs/myRuns'
import { RunDetail } from './RunDetail'
import { money } from './format'
import { useRefresh } from './refresh'
import { SignInGate } from './SignInGate'

const FINISHED_SHOWN = 8

const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour12: false })
const dateTime = (at: string) => new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function ago(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000))
  if (minutes === 0) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / (24 * 60))}d ago`
}

export function RunsPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate()
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border flex w-full max-w-6xl flex-col gap-5 px-4 pb-6 pt-4 md:px-6">
        {subPath ? (
          <>
            <button
              type="button"
              className="self-start text-sm text-muted-foreground hover:text-foreground"
              onClick={() => navigate.toPluginPanel('runs', { subPath: '' })}
            >
              ← Back to runs
            </button>
            <SignInGate>
              <RunDetail runId={subPath} />
            </SignInGate>
          </>
        ) : (
          <>
            <h2 className="m-0 text-lg font-semibold">My BETTY runs</h2>
            <SignInGate>
              <RunBoard />
            </SignInGate>
          </>
        )}
      </div>
    </div>
  )
}

function RunBoard() {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'myRuns', input: null })
  const [filter, setFilter] = useState<TileId | null>(null)
  useRefresh(query.refetch)

  if (query.error && !query.data) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>
  if (!query.data) return <p className="text-sm text-muted-foreground">Loading runs.</p>

  const { runs, refreshedAt, cutOff, unreadable } = query.data
  const stats = overview(runs, refreshedAt, RECENT_DAYS)
  const shown = filter ? runs.filter((run) => inTile(filter, run)) : runs

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 -mt-3 text-xs text-muted-foreground">
        Last {RECENT_DAYS} days and every active run. Updated {clock(refreshedAt)}
      </p>
      {query.error && <p role="alert" className="m-0 text-sm text-destructive">{query.error.message}</p>}
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
        <>
          <Tiles stats={stats} filter={filter} onFilter={setFilter} />
          <Stats stats={stats} />
          <RunList runs={shown} now={refreshedAt} filter={filter} onClear={() => setFilter(null)} />
        </>
      )}
    </div>
  )
}

function tileSub(id: TileId, stats: Overview): string {
  const prs = stats.pullRequests
  switch (id) {
    case 'needs-decision':
      return 'waiting on you'
    case 'in-flight':
      return 'running, watching CI or waiting'
    case 'shipped':
      return `${plural(prs.merged, 'PR')} merged, ${prs.open} open`
    case 'broke':
      return `failed or partly, ${stats.cancelled} cancelled`
  }
}

function Tiles({ stats, filter, onFilter }: { stats: Overview; filter: TileId | null; onFilter: (tile: TileId | null) => void }) {
  return (
    <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {TILES.map((tile) => (
        <button
          key={tile.id}
          type="button"
          aria-pressed={filter === tile.id}
          onClick={() => onFilter(filter === tile.id ? null : tile.id)}
          className={`flex flex-col items-start rounded-lg border bg-card p-4 text-left hover:bg-accent ${
            filter === tile.id ? 'border-foreground' : 'border-border'
          }`}
        >
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{tile.label}</span>
          <span className={`mt-1 text-3xl font-semibold tabular-nums ${stats.tiles[tile.id] === 0 ? 'text-muted-foreground' : tile.text}`}>{stats.tiles[tile.id]}</span>
          <span className="mt-1 text-xs text-muted-foreground">{tileSub(tile.id, stats)}</span>
        </button>
      ))}
      <div className="flex flex-col items-start rounded-lg border border-border bg-card p-4">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Spend</span>
        <span className="mt-1 text-3xl font-semibold tabular-nums">{money(stats.spendUsd)}</span>
        <span className="mt-1 text-xs text-muted-foreground">
          {stats.spendPerRunUsd === null ? 'no runs' : `${money(stats.spendPerRunUsd)} per run`}
        </span>
      </div>
    </section>
  )
}

function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        {aside ? <span className="text-xs text-muted-foreground">{aside}</span> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Stats({ stats }: { stats: Overview }) {
  const total = stats.outcomes.reduce((sum, entry) => sum + entry.count, 0)
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_2fr]">
      <Panel title="Outcomes">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">
            {stats.successRate === null ? 'n/a' : `${Math.round(stats.successRate * 100)}%`}
          </span>
          <span className="text-xs text-muted-foreground">success rate, shipped of shipped and broke</span>
        </div>
        <div aria-hidden className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted">
          {stats.outcomes.map(({ outcome, count }) => (
            <div key={outcome} className={OUTCOME_STYLE[outcome].fill} style={{ width: `${(count / total) * 100}%` }} />
          ))}
        </div>
        <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
          {stats.outcomes.map(({ outcome, count }) => (
            <li key={outcome} className="flex items-center gap-1.5">
              <span className={`size-2.5 rounded-sm ${OUTCOME_STYLE[outcome].fill}`} />
              {OUTCOME_STYLE[outcome].label}
              <span className="tabular-nums text-foreground">{count}</span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Runs per day" aside="by day of last activity">
        <DayChart days={stats.days} />
      </Panel>
    </div>
  )
}

function DayChart({ days }: { days: Day[] }) {
  const peak = Math.max(1, ...days.map((day) => day.runs))
  return (
    <div>
      <div className="flex h-28 items-end gap-1">
        {days.map((day) => (
          <div
            key={day.day}
            title={`${dayLabel(day.day)}: ${plural(day.runs, 'run')}, ${money(day.spendUsd)}`}
            className="flex h-full flex-1 flex-col-reverse overflow-hidden rounded-sm bg-muted/40"
          >
            {Object.entries(day.byOutcome).map(([outcome, count]) => (
              <div
                key={outcome}
                className={OUTCOME_STYLE[outcome as keyof typeof OUTCOME_STYLE].fill}
                style={{ height: `${(count / peak) * 100}%` }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{dayLabel(days[0]!.day)}</span>
        <span>{dayLabel(days.at(-1)!.day)}</span>
      </div>
    </div>
  )
}

function RunList({ runs, now, filter, onClear }: { runs: RunSummary[]; now: number; filter: TileId | null; onClear: () => void }) {
  const label = TILES.find((tile) => tile.id === filter)?.label
  return (
    <div className="flex flex-col gap-3">
      {label && (
        <p className="m-0 text-sm">
          Showing {label.toLowerCase()} only.{' '}
          <button type="button" className="text-sm underline" onClick={onClear}>
            Show all
          </button>
        </p>
      )}
      {groupRuns(runs)
        .filter((group) => group.runs.length > 0)
        .map((group) => (
          <GroupSection key={group.id} group={group} now={now} />
        ))}
    </div>
  )
}

function GroupSection({ group, now }: { group: RunGroup; now: number }) {
  const [expanded, setExpanded] = useState(false)
  const limited = group.id === 'finished' && !expanded && group.runs.length > FINISHED_SHOWN
  const rows = limited ? group.runs.slice(0, FINISHED_SHOWN) : group.runs
  return (
    <section aria-label={group.label} className="rounded-lg border border-border bg-card">
      <h3 className="m-0 border-b border-border px-4 py-2.5 text-sm font-semibold">
        {group.label} <span className="font-normal text-muted-foreground">{group.runs.length}</span>
      </h3>
      <ul className="m-0 list-none divide-y divide-border p-0">
        {rows.map((run) => (
          <RunRow key={run.runId} run={run} now={now} />
        ))}
      </ul>
      {limited && (
        <button
          type="button"
          className="w-full border-t border-border px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent"
          onClick={() => setExpanded(true)}
        >
          Show all {group.runs.length}
        </button>
      )}
    </section>
  )
}

function RunRow({ run, now }: { run: RunSummary; now: number }) {
  const navigate = useBbNavigate()
  const outcome = OUTCOME_STYLE[run.outcome]
  const { nodesDone, nodesTotal } = run.progress
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
      <span className={`w-32 shrink-0 text-xs font-medium ${outcome.text}`}>{outcome.label}</span>
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:underline"
        title={run.title}
        onClick={() => navigate.toPluginPanel('runs', { subPath: run.runId })}
      >
        {run.title}
      </button>
      <span className="flex w-28 shrink-0 items-center gap-2 text-xs text-muted-foreground" title={`${nodesDone}/${nodesTotal} nodes`}>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className={`block h-full ${outcome.fill}`}
            style={{ width: `${nodesTotal === 0 ? 0 : (nodesDone / nodesTotal) * 100}%` }}
          />
        </span>
        <span className="w-10 text-right tabular-nums">
          {nodesDone}/{nodesTotal}
        </span>
      </span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{money(run.costUsd)}</span>
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground" title={dateTime(run.lastStatusChangeAt)}>
        {ago(run.lastStatusChangeAt, now)}
      </span>
      <span className="flex w-48 shrink-0 justify-end gap-1">
        {run.pullRequests.map((pr) => (
          <PullRequestChip key={pr.url} pr={pr} />
        ))}
      </span>
    </li>
  )
}

export function PullRequestChip({ pr }: { pr: Pick<PullRequest, 'number' | 'url' | 'state' | 'repo'> }) {
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
