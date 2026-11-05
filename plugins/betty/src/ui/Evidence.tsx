import { useState } from 'react'
import { experimental_Icon as Icon, experimental_useRpcQuery, useBbNavigate } from '@get-bb/plugin-sdk/app'
import { rpcContract } from '../rpc'
import type { Criterion, StepEvidence } from '../runs/evidence'
import { bytes } from './format'
import { useRefresh } from './refresh'

const VERDICT_STYLE = {
  met: { label: 'Met', icon: 'CircleCheck', text: 'text-green-600 dark:text-green-400' },
  notMet: { label: 'Not met', icon: 'CircleX', text: 'text-red-600 dark:text-red-400' },
} as const

const AMBER = 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
const BUTTON = 'rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent'

export function EvidenceSection({ runId }: { runId: string }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'runEvidence', input: { runId } })
  useRefresh(query.refetch)

  if (query.error && !query.data) return <p role="alert" className="m-0 text-sm text-destructive">{query.error.message}</p>
  if (!query.data) return <p className="m-0 text-sm text-muted-foreground">Loading the acceptance criteria.</p>
  if (query.data.length === 0) return null

  const faked = query.data.some((step) => step.criteria.some((criterion) => criterion.fakedBackend !== null))
  return (
    <section aria-label="Acceptance criteria" className="flex flex-col gap-3">
      <h3 className="m-0 text-sm font-semibold">Acceptance criteria</h3>
      {query.error && <p role="alert" className="m-0 text-sm text-destructive">{query.error.message}</p>}
      {faked && (
        <p role="status" className={`m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${AMBER}`}>
          <Icon name="AlertTriangle" fallback="Circle" aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>Some evidence comes from faked backend data, so those checks did not run against real data.</span>
        </p>
      )}
      {query.data.map((step) => (
        <StepEvidenceCard key={step.taskId} step={step} />
      ))}
    </section>
  )
}

function StepEvidenceCard({ step }: { step: StepEvidence }) {
  const met = step.criteria.filter((criterion) => criterion.met).length
  return (
    <section aria-label={`Evidence of ${step.step}`} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{step.step}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {met} of {step.criteria.length} met
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {step.criteria.map((criterion) => (
          <CriterionItem key={criterion.id} criterion={criterion} />
        ))}
      </ul>
    </section>
  )
}

function CriterionItem({ criterion }: { criterion: Criterion }) {
  const navigate = useBbNavigate()
  const verdict = VERDICT_STYLE[criterion.met ? 'met' : 'notMet']
  return (
    <li aria-label={criterion.id} className="flex flex-col gap-1.5 border-t border-border pt-3 text-sm first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`flex items-center gap-1 font-medium ${verdict.text}`}>
          <Icon name={verdict.icon} fallback="Circle" aria-hidden className="size-4 shrink-0" />
          {verdict.label}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{criterion.id}</span>
        {criterion.fakedBackend !== null && (
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${AMBER}`}>Faked backend data</span>
        )}
      </div>
      {criterion.text !== null && <p className="m-0 font-medium">{criterion.text}</p>}
      {criterion.fakedBackend !== null && <p className={`m-0 rounded-md border px-2 py-1 text-xs ${AMBER}`}>{criterion.fakedBackend}</p>}
      <p className="m-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">{criterion.evidence}</p>
      {criterion.images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {criterion.images.map((url, index) => (
            <button key={url} type="button" className={`flex items-center gap-1.5 ${BUTTON}`} onClick={() => navigate.openUrl(url)}>
              <Icon name="Image" fallback="ExternalLink" aria-hidden className="size-3.5" />
              Screenshot {index + 1}
            </button>
          ))}
        </div>
      )}
    </li>
  )
}

export function StepArtifacts({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" aria-expanded={open} className={`self-start ${BUTTON}`} onClick={() => setOpen(!open)}>
        Artifacts
      </button>
      {open && <ArtifactList taskId={taskId} />}
    </div>
  )
}

function ArtifactList({ taskId }: { taskId: string }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'stepArtifacts', input: { taskId } })
  const [shown, setShown] = useState<string | null>(null)

  if (query.error) return <p role="alert" className="m-0 text-xs text-destructive">{query.error.message}</p>
  if (!query.data) return <p className="m-0 text-xs text-muted-foreground">Loading the artifacts.</p>
  if (query.data.length === 0) return <p className="m-0 text-xs text-muted-foreground">No artifacts.</p>

  return (
    <ul aria-label="Artifacts" className="m-0 flex list-none flex-col gap-1.5 p-0">
      {query.data.map((artifact) => (
        <li key={artifact.artifactId} className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={shown === artifact.artifactId}
            className={`self-start ${BUTTON}`}
            onClick={() => setShown(shown === artifact.artifactId ? null : artifact.artifactId)}
          >
            {artifact.kind} · {bytes(artifact.sizeBytes)}
          </button>
          {shown === artifact.artifactId && <ArtifactViewer artifactId={artifact.artifactId} />}
        </li>
      ))}
    </ul>
  )
}

function ArtifactViewer({ artifactId }: { artifactId: string }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'artifact', input: { artifactId } })

  if (query.error) return <p role="alert" className="m-0 text-xs text-destructive">{query.error.message}</p>
  if (!query.data) return <p className="m-0 text-xs text-muted-foreground">Loading the artifact.</p>

  return (
    <div className="flex flex-col gap-1">
      {query.data.note !== null && <p className="m-0 text-xs text-muted-foreground">{query.data.note}</p>}
      <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{query.data.content}</pre>
    </div>
  )
}
