import { useState } from 'react'
import { experimental_Icon as Icon, experimental_ImageLightbox as ImageLightbox, experimental_useRpcQuery, useBbNavigate } from '@get-bb/plugin-sdk/app'
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

  const faked = query.data.some((step) => 'criteria' in step && step.criteria.some((criterion) => criterion.fakedBackend !== null))
  return (
    <section aria-label="Acceptance criteria" className="flex flex-col gap-3">
      <h3 className="m-0 text-sm font-semibold">Acceptance criteria</h3>
      {query.error && <p role="alert" className="m-0 text-sm text-destructive">{query.error.message}</p>}
      {faked && (
        <p role="status" className={`m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${AMBER}`}>
          <Icon name="AlertTriangle" fallback="Circle" aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>Some evidence mentions faked backend data. Read the marked criteria before you trust them.</span>
        </p>
      )}
      {query.data.map((step) => (
        <StepEvidenceCard key={step.taskId} step={step} />
      ))}
    </section>
  )
}

function StepEvidenceCard({ step }: { step: StepEvidence }) {
  return (
    <section aria-label={`Evidence of ${step.step}`} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{step.step}</span>
        {'criteria' in step && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {step.criteria.filter((criterion) => criterion.met).length} of {step.criteria.length} met
          </span>
        )}
      </div>
      {'criteria' in step ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {step.criteria.map((criterion) => (
            <CriterionItem key={criterion.id} criterion={criterion} />
          ))}
        </ul>
      ) : (
        <p role="alert" className="m-0 text-sm text-destructive">{step.error}</p>
      )}
    </section>
  )
}

function CriterionItem({ criterion }: { criterion: Criterion }) {
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
      {criterion.images.length > 0 && <Screenshots criterionId={criterion.id} urls={criterion.images} />}
    </li>
  )
}

function Screenshots({ criterionId, urls }: { criterionId: string; urls: readonly string[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const shown = open === null ? null : { index: open, label: `${criterionId} screenshot ${open + 1}` }
  const lightbox = experimental_useRpcQuery({
    contract: rpcContract,
    method: 'screenshot',
    input: { url: urls[open ?? 0]! },
    enabled: open !== null,
  })
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {urls.map((url, index) => (
          <Screenshot key={url} url={url} criterionId={criterionId} number={index + 1} onOpen={() => setOpen(index)} />
        ))}
      </div>
      {shown && (
        <ImageLightbox
          isOpen
          title={shown.label}
          imageAlt={shown.label}
          imageSrc={lightbox.data?.src ?? null}
          hasMultipleImages={urls.length > 1}
          navigationStatus={`${shown.index + 1} of ${urls.length}`}
          previousDisabled={shown.index === 0}
          nextDisabled={shown.index === urls.length - 1}
          onPrevious={() => setOpen(shown.index - 1)}
          onNext={() => setOpen(shown.index + 1)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

function Screenshot({ url, criterionId, number, onOpen }: { url: string; criterionId: string; number: number; onOpen: () => void }) {
  const navigate = useBbNavigate()
  const label = `${criterionId} screenshot ${number}`
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'screenshot', input: { url } })

  if (query.data) {
    return (
      <button type="button" aria-label={label} className="overflow-hidden rounded-md border border-border hover:border-foreground/40" onClick={onOpen}>
        <img src={query.data.src} alt={label} className="block h-32 w-auto max-w-full object-contain" />
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={query.error?.message}
      className={`flex items-center gap-1.5 ${BUTTON}`}
      onClick={() => navigate.openUrl(url)}
    >
      <Icon name="Image" fallback="ExternalLink" aria-hidden className="size-3.5" />
      Screenshot {number}
    </button>
  )
}

export function StepArtifacts({ taskId, stepName }: { taskId: string; stepName: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Artifacts of ${stepName}`}
        className={`self-start ${BUTTON}`}
        onClick={() => setOpen(!open)}
      >
        Artifacts
      </button>
      {open && <ArtifactList taskId={taskId} />}
    </div>
  )
}

function ArtifactList({ taskId }: { taskId: string }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: 'stepArtifacts', input: { taskId } })
  useRefresh(query.refetch)
  const [shown, setShown] = useState<string | null>(null)

  if (query.error) return <p role="alert" className="m-0 text-xs text-destructive">{query.error.message}</p>
  if (!query.data) return <p className="m-0 text-xs text-muted-foreground">Loading the artifacts.</p>
  if (query.data.length === 0) return <p className="m-0 text-xs text-muted-foreground">No artifacts.</p>

  const retried = new Set(query.data.map((artifact) => artifact.attempt)).size > 1
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
            {[artifact.kind, ...(retried ? [`attempt ${artifact.attempt}`] : []), bytes(artifact.sizeBytes)].join(' · ')}
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
