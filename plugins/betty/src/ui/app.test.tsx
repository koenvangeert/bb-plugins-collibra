import type { ThreadRun } from '../runChip'
// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { act, type ComponentType } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadPluginApp, renderSlot, type CapturedPluginApp } from '@get-bb/plugin-sdk/testing/app'
import type { AuthKind } from '../auth/state'
import dagStatus from '../fixtures/dag-status.json'
import type { PullRequest, RunDetail, RunOutcome, RunSummary } from '../pesto/types'
import { runDetailSchema } from '../pesto/wire'
import type { StepEvidence } from '../runs/evidence'
import type { MyRuns } from '../runs/myRuns'

const REFRESHED_AT = Date.parse('2026-11-02T11:15:30Z')

function pr(number: number, state: PullRequest['state']): PullRequest {
  return {
    number,
    url: `https://github.com/collibra/frontend/pull/${number}`,
    state,
    base: 'main',
    head: `branch-${number}`,
    repo: 'collibra/frontend',
    actedOnBy: [],
  }
}

function run(title: string, outcome: RunOutcome, costUsd: number, pullRequests: PullRequest[] = []): RunSummary {
  return {
    runId: title,
    title,
    outcome,
    ownerDev: 'koen.vangeert@collibra.com',
    progress: { nodesDone: 4, nodesTotal: 15 },
    costUsd,
    lastStatusChangeAt: '2026-11-01T09:30:00Z',
    pullRequests,
  }
}

const RUNS = [
  run('Pick a schema', 'needs_decision', 1.5),
  run('Rename the column', 'watching_ci', 2.25, [pr(26728, 'open'), pr(26729, 'draft')]),
  run('Add the KPI', 'succeeded', 3, [pr(26700, 'merged')]),
  run('Drop the flag', 'cancelled', 0, [pr(26650, 'closed')]),
]

let app: CapturedPluginApp

beforeAll(async () => {
  app = await loadPluginApp(() => import('../../app'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderPage(myRuns: () => MyRuns | Promise<MyRuns>, state: AuthKind = 'signed-in') {
  return renderSlot(app.navPanels[0]!, { subPath: '' }, {
    rpc: { authStatus: () => ({ state }), startSignIn: () => ({ url: 'https://betty.test/oauth/authorize' }), myRuns },
  })
}

type RpcHandlers = NonNullable<Parameters<typeof renderSlot>[2]>['rpc']

function renderDetail(runId: string, runDetail: () => RunDetail, list: () => MyRuns = () => myRuns(), rpc: RpcHandlers = {}) {
  return renderSlot(app.navPanels[0]!, { subPath: runId }, {
    rpc: {
      authStatus: () => ({ state: 'signed-in' }),
      startSignIn: () => ({ url: 'https://betty.test/oauth/authorize' }),
      myRuns: list,
      runDetail,
      runEvidence: () => [],
      ...rpc,
    },
  })
}

const FIXTURE_DETAIL = runDetailSchema.parse(dagStatus)

const detailWithBase = (base: string): RunDetail => ({
  ...FIXTURE_DETAIL,
  pullRequests: FIXTURE_DETAIL.pullRequests.map((pr) => ({ ...pr, base })),
})

const myRuns = (overrides: Partial<MyRuns> = {}): MyRuns => ({ refreshedAt: REFRESHED_AT, runs: RUNS, cutOff: false, unreadable: 0, ...overrides })

describe('BETTY runs page', () => {
  it('groups the runs in one line each', async () => {
    const slot = renderPage(() => myRuns())

    const decision = await slot.findByRole('region', { name: 'Needs a decision' })
    const inFlight = slot.getByRole('region', { name: 'In flight' })
    const finished = slot.getByRole('region', { name: 'Finished' })

    expect(within(decision).getByText('Pick a schema')).toBeTruthy()
    expect(within(inFlight).getByText('Rename the column')).toBeTruthy()
    expect(within(inFlight).getByText('Watching CI')).toBeTruthy()
    expect(within(finished).getByText('Add the KPI')).toBeTruthy()
    expect(within(finished).getByText('Drop the flag')).toBeTruthy()
    expect(within(inFlight).getByText('4/15')).toBeTruthy()
    expect(within(inFlight).getByText('$2.25')).toBeTruthy()
    expect(within(inFlight).getByText('1d ago').getAttribute('title')).toBe('1 Nov 2026, 10:30')
    expect(slot.queryByRole('status')).toBeNull()
  })

  it('sums the runs up in tiles', async () => {
    const slot = renderPage(() => myRuns())

    const totals = await slot.findByRole('region', { name: 'Totals' })
    const tile = (label: string) => within(totals).getByText(label).parentElement!.textContent

    expect(tile('Needs a decision')).toBe('Needs a decision1waiting on you')
    expect(tile('In flight')).toBe('In flight1running, watching CI or waiting')
    expect(tile('Shipped')).toBe('Shipped11 PR merged, 1 open')
    expect(tile('Broke')).toBe('Broke0failed or partly, 1 cancelled')
    expect(tile('Spend')).toBe('Spend$6.75$1.69 per run')
  })

  it('shows the success rate and the outcome mix', async () => {
    const slot = renderPage(() =>
      myRuns({ runs: [...RUNS, run('Break the build', 'failed', 1), run('Ship the fix', 'succeeded', 1)] }),
    )

    const outcomes = await slot.findByRole('region', { name: 'Outcomes' })

    expect(within(outcomes).getByText('67%')).toBeTruthy()
    expect(within(outcomes).getByText('Succeeded').textContent).toBe('Succeeded2')
    expect(within(outcomes).getByText('Failed').textContent).toBe('Failed1')
  })

  it('counts runs per day of last activity', async () => {
    const slot = renderPage(() => myRuns())

    const chart = await slot.findByRole('region', { name: 'Runs per day' })

    expect(within(chart).getByTitle('1 Nov: 4 runs, $6.75')).toBeTruthy()
    expect(within(chart).getByTitle('2 Nov: 0 runs, $0.00')).toBeTruthy()
    expect(within(chart).getAllByTitle(/: \d+ runs?, /)).toHaveLength(14)
  })

  it('shows only the runs of a tile after a click on it', async () => {
    const slot = renderPage(() => myRuns())

    await act(async () => (await slot.findByRole('button', { name: /^In flight/ })).click())

    expect(slot.getByText('Showing in flight only.')).toBeTruthy()
    expect(slot.queryByText('Pick a schema')).toBeNull()
    expect(slot.getByText('Rename the column')).toBeTruthy()

    await act(async () => slot.getByRole('button', { name: 'Show all' }).click())

    expect(slot.getByText('Pick a schema')).toBeTruthy()
  })

  it('shows the newest 8 finished runs until asked for all', async () => {
    const finished = Array.from({ length: 10 }, (_, index) => run(`Finished ${index + 1}`, 'succeeded', 1))
    const slot = renderPage(() => myRuns({ runs: finished }))

    const section = await slot.findByRole('region', { name: 'Finished' })
    expect(within(section).getAllByRole('listitem')).toHaveLength(8)

    await act(async () => within(section).getByRole('button', { name: 'Show all 10' }).click())

    expect(within(section).getAllByRole('listitem')).toHaveLength(10)
  })

  it('skips a group without runs', async () => {
    const slot = renderPage(() => myRuns({ runs: [run('Add the KPI', 'succeeded', 3)] }))

    await slot.findByRole('region', { name: 'Finished' })

    expect(slot.queryByRole('region', { name: 'In flight' })).toBeNull()
    expect(slot.queryByRole('region', { name: 'Needs a decision' })).toBeNull()
  })

  it('shows each pull request as a chip that opens it', async () => {
    const slot = renderPage(() => myRuns())

    const chip = await slot.findByRole('button', { name: '#26728 open' })
    expect(chip.getAttribute('title')).toBe('collibra/frontend#26728')
    expect(slot.getByRole('button', { name: '#26729 draft' })).toBeTruthy()
    expect(slot.getByRole('button', { name: '#26700 merged' })).toBeTruthy()
    expect(slot.getByRole('button', { name: '#26650 closed' })).toBeTruthy()

    await act(async () => chip.click())

    expect(slot.navigateCalls).toEqual([{ method: 'openUrl', url: 'https://github.com/collibra/frontend/pull/26728' }])
  })

  it('says when the list is cut off', async () => {
    const slot = renderPage(() => myRuns({ cutOff: true }))

    expect((await slot.findByRole('status')).textContent).toBe('Showing the newest 100 runs. Older runs are cut off.')
  })

  it('says how many runs it cannot read', async () => {
    const slot = renderPage(() => myRuns({ unreadable: 2 }))

    expect((await slot.findByRole('status')).textContent).toBe('2 runs are not shown, because BETTY sent data that bb cannot read.')
  })

  it('says when there are no runs', async () => {
    const slot = renderPage(() => myRuns({ runs: [] }))

    expect(await slot.findByText('No runs in the last 14 days.')).toBeTruthy()
  })

  it('shows why the runs cannot be read', async () => {
    const slot = renderPage(() => {
      throw new Error('BETTY did not tell bb your email, so bb cannot find your runs.')
    })

    expect((await slot.findByRole('alert')).textContent).toContain('BETTY did not tell bb your email')
  })

  it('reads the runs again every 30 seconds and shows when', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let refreshedAt = REFRESHED_AT
    const load = vi.fn(() => myRuns({ refreshedAt }))
    const slot = renderPage(load)
    expect(await slot.findByText(/Updated 12:15:30$/)).toBeTruthy()

    refreshedAt += 30_000
    await act(async () => vi.advanceTimersByTime(30_000))

    expect(await slot.findByText(/Updated 12:16:00$/)).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['signed-out', 'Sign in to BETTY'],
    ['expired', 'Sign in to BETTY again'],
  ] as const)('asks to sign in when %s and does not read runs', async (state, prompt) => {
    const load = vi.fn(() => myRuns())
    const slot = renderPage(load, state)

    await act(async () => (await slot.findByRole('button', { name: prompt })).click())

    expect(slot.navigateCalls).toEqual([{ method: 'openUrl', url: 'https://betty.test/oauth/authorize' }])
    expect(load).not.toHaveBeenCalled()
  })
})

describe('BETTY run detail', () => {
  it('opens a run after a click on its title', async () => {
    const slot = renderPage(() => myRuns())

    await act(async () => (await slot.findByRole('button', { name: 'Rename the column' })).click())

    expect(slot.navigateCalls).toEqual([{ method: 'toPluginPanel', path: 'runs', options: { subPath: 'Rename the column' } }])
  })

  it('shows the run title, outcome, spend and spend ceilings', async () => {
    const slot = renderDetail('Rename the column', () => detailWithBase('main'))

    expect(await slot.findByRole('heading', { name: 'Rename the column' })).toBeTruthy()
    expect(slot.getByText('Watching CI')).toBeTruthy()
    expect(slot.getByRole('img', { name: 'Spent $3.66. Clean run up to $78.00 · Worst case up to $105.00 (one attempt per step)' })).toBeTruthy()
    expect(slot.getByText('$3.66').parentElement!.textContent).toBe('$3.66 spent')
    expect(slot.getByText('Every step is done')).toBeTruthy()
    expect(slot.getByText('15/15 steps')).toBeTruthy()
  })

  it('reads the run outcome again every 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let outcome: RunOutcome = 'watching_ci'
    const slot = renderDetail('Rename the column', () => detailWithBase('main'), () => myRuns({ runs: [run('Rename the column', outcome, 2.25)] }))
    expect(await slot.findByText('Watching CI')).toBeTruthy()

    outcome = 'succeeded'
    await act(async () => vi.advanceTimersByTime(30_000))

    expect(await slot.findByText('Succeeded')).toBeTruthy()
  })

  it('warns when the pull request base is not main', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('release/2026.11'))

    const section = await slot.findByRole('region', { name: 'Pull request #26731' })

    expect(within(section).getByRole('status').textContent).toContain('Base is release/2026.11, not main. CI may run only a few checks')
  })

  it('does not warn when the pull request base is main', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'))

    await slot.findByRole('region', { name: 'Pull request #26731' })

    expect(slot.queryByText(/CI may run only a few checks/)).toBeNull()
  })

  it('opens the pull request and each comment on GitHub', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'))
    const section = await slot.findByRole('region', { name: 'Pull request #26731' })

    await act(async () => within(section).getByRole('button', { name: 'Open PR #26731' }).click())
    await act(async () => within(section).getByRole('button', { name: 'Remediation · remediate-review' }).click())

    expect(slot.navigateCalls).toEqual([
      { method: 'openUrl', url: 'https://github.com/collibra/frontend/pull/26731' },
      { method: 'openUrl', url: 'https://github.com/collibra/frontend/pull/26731#issuecomment-6473319138' },
    ])
    expect(within(section).getByText('Review · revalidate-app').parentElement!.textContent).toBe('Review · revalidate-appplanned')
    expect(within(section).queryByRole('button', { name: 'Review · revalidate-app' })).toBeNull()
  })

  it('shows each step with its status, spend against budget and when it runs', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'))
    const steps = await slot.findByRole('region', { name: 'Steps' })

    const remediate = within(steps).getByRole('listitem', { name: 'remediate-review' })
    expect(within(remediate).getByText('Done')).toBeTruthy()
    expect(within(remediate).getByText('$0.56/$12.00')).toBeTruthy()
    expect(within(remediate).getByText('after implement, review')).toBeTruthy()

    const fix = within(steps).getByRole('listitem', { name: 'remediate-app' })
    expect(within(fix).getByText('Skipped')).toBeTruthy()
    expect(within(fix).getByTitle('Only when $validate-app.output.all_met == false').textContent).toBe('$validate-app.output.all_met == false')

    const teardown = within(steps).getByRole('listitem', { name: 'teardown-env' })
    expect(within(teardown).getByTitle('script')).toBeTruthy()
    expect(within(teardown).getByTitle('Always runs')).toBeTruthy()
  })

  it.each([
    ['queued', 'Queued'],
    ['claimed', 'Starting'],
  ] as const)('shows a %s step as %s', async (status, label) => {
    const detail: RunDetail = {
      ...FIXTURE_DETAIL,
      nodes: FIXTURE_DETAIL.nodes.map((node) => (node.name === 'teardown-env' ? { ...node, status } : node)),
    }
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detail)
    const steps = await slot.findByRole('region', { name: 'Steps' })

    expect(within(within(steps).getByRole('listitem', { name: 'teardown-env' })).getByText(label)).toBeTruthy()
  })

  it('goes back to the runs', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'))

    await act(async () => (await slot.findByRole('button', { name: /Back to runs/ })).click())

    expect(slot.navigateCalls).toEqual([{ method: 'toPluginPanel', path: 'runs', options: { subPath: '' } }])
  })

  it('shows why the run cannot be read', async () => {
    const slot = renderDetail('gone', () => {
      throw new Error('BETTY has no run gone.')
    })

    expect((await slot.findByRole('alert')).textContent).toContain('BETTY has no run gone.')
  })
})

const SCREENSHOT = (name: string) => `https://github.com/collibra/frontend/raw/a9fb6c6/${name}.png`

const CLEAN_STEP = {
  taskId: 't-validate-app',
  step: 'validate-app',
  criteria: [
    {
      id: 'AC-1',
      text: 'The drawer lists Compliance apps in order',
      met: true,
      evidence: 'I opened /apps.\nThe Compliance group rendered in order.',
      images: [SCREENSHOT('ac-1-1'), SCREENSHOT('ac-1-2')],
      fakedBackend: null,
    },
    { id: 'AC-2', text: null, met: false, evidence: 'Not exercised.', images: [], fakedBackend: null },
  ],
} satisfies StepEvidence

const CLEAN_EVIDENCE: StepEvidence[] = [CLEAN_STEP]

const FAKED_SENTENCE = 'The browser rewrote the guardianOverview responses (magneto_playwright_route).'

const FAKED_EVIDENCE: StepEvidence[] = [
  {
    ...CLEAN_STEP,
    criteria: [
      { ...CLEAN_STEP.criteria[0], evidence: `The DGC has no Guardian backend. ${FAKED_SENTENCE}`, fakedBackend: FAKED_SENTENCE },
      CLEAN_STEP.criteria[1],
    ],
  },
]

const VALIDATE_APP = FIXTURE_DETAIL.nodes.find((node) => node.name === 'validate-app')!

describe('BETTY acceptance criteria', () => {
  it('shows each criterion with its verdict, text, evidence and screenshot links when bb cannot load the screenshots', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'), undefined, {
      runEvidence: () => CLEAN_EVIDENCE,
      screenshot: () => {
        throw new Error('gh could not load the screenshot')
      },
    })

    const step = await slot.findByRole('region', { name: 'Evidence of validate-app' })
    expect(within(step).getByText('1 of 2 met')).toBeTruthy()

    const met = within(step).getByRole('listitem', { name: 'AC-1' })
    expect(within(met).getByText('Met')).toBeTruthy()
    expect(within(met).getByText('The drawer lists Compliance apps in order')).toBeTruthy()
    expect(within(met).getByText(/I opened \/apps\.\s+The Compliance group rendered in order\./)).toBeTruthy()
    await act(async () => within(met).getByRole('button', { name: 'AC-1 screenshot 1' }).click())
    await act(async () => within(met).getByRole('button', { name: 'AC-1 screenshot 2' }).click())
    expect(slot.navigateCalls).toEqual([
      { method: 'openUrl', url: SCREENSHOT('ac-1-1') },
      { method: 'openUrl', url: SCREENSHOT('ac-1-2') },
    ])

    const notMet = within(step).getByRole('listitem', { name: 'AC-2' })
    expect(within(notMet).getByText('Not met')).toBeTruthy()
    expect(within(notMet).getByText('Not exercised.')).toBeTruthy()
    expect(within(notMet).queryByRole('button')).toBeNull()
  })

  it('shows the screenshots inline and opens one in the lightbox', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'), undefined, {
      runEvidence: () => CLEAN_EVIDENCE,
      screenshot: (input) => ({ src: `data:image/png;base64,${btoa((input as { url: string }).url)}` }),
    })

    const met = await slot.findByRole('listitem', { name: 'AC-1' })
    const thumbnail = await within(met).findByRole('img', { name: 'AC-1 screenshot 2' })
    expect(thumbnail.getAttribute('src')).toBe(`data:image/png;base64,${btoa(SCREENSHOT('ac-1-2'))}`)

    await act(async () => within(met).getByRole('button', { name: 'AC-1 screenshot 2' }).click())

    await waitFor(() => expect(slot.getAllByRole('img', { name: 'AC-1 screenshot 2' })).toHaveLength(2))
    expect(slot.navigateCalls).toEqual([])
  })

  it('marks the criteria whose evidence mentions faked backend data', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'), undefined, { runEvidence: () => FAKED_EVIDENCE })

    const section = await slot.findByRole('region', { name: 'Acceptance criteria' })

    expect(within(section).getByRole('status').textContent).toBe(
      'Some evidence mentions faked backend data. Read the marked criteria before you trust them.',
    )
    const faked = within(section).getByRole('listitem', { name: 'AC-1' })
    expect(within(faked).getByText('Faked backend data')).toBeTruthy()
    expect(within(faked).getByText(FAKED_SENTENCE)).toBeTruthy()
    expect(within(within(section).getByRole('listitem', { name: 'AC-2' })).queryByText('Faked backend data')).toBeNull()
  })

  it('does not warn about faked data when all evidence is real', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'), undefined, { runEvidence: () => CLEAN_EVIDENCE })

    const section = await slot.findByRole('region', { name: 'Acceptance criteria' })

    expect(within(section).queryByRole('status')).toBeNull()
    expect(within(section).queryByText('Faked backend data')).toBeNull()
  })

  it('shows the criteria in the run tab too', async () => {
    const slot = renderSlot({ component: app.tabs[0]!.component as ComponentType<{ threadId: string }> }, { threadId: 'thr_1' }, {
      rpc: {
        authStatus: () => ({ state: 'signed-in' }),
        myRuns: () => myRuns(),
        threadRun: () => ({ kind: 'linked', runId: FIXTURE_DETAIL.runId, chip: null, pullRequests: [], error: null }),
        runDetail: () => detailWithBase('main'),
        runEvidence: () => FAKED_EVIDENCE,
      },
    })

    expect(await slot.findByRole('region', { name: 'Evidence of validate-app' })).toBeTruthy()
    expect(slot.getByRole('status').textContent).toContain('faked backend data')
  })

  it('has no criteria section for a run without evidence', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'))

    await slot.findByRole('region', { name: 'Steps' })
    await waitFor(() => expect(slot.queryByText('Loading the acceptance criteria.')).toBeNull())

    expect(slot.queryByRole('region', { name: 'Acceptance criteria' })).toBeNull()
  })

  it('shows why the evidence of one step cannot be read and still shows the other steps', async () => {
    const unreadable = { taskId: 't-revalidate-app', step: 'revalidate-app', error: 'BETTY is down' }
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'), undefined, { runEvidence: () => [...CLEAN_EVIDENCE, unreadable] })

    const failed = await slot.findByRole('region', { name: 'Evidence of revalidate-app' })

    expect(within(failed).getByRole('alert').textContent).toBe('BETTY is down')
    expect(within(failed).queryByRole('listitem')).toBeNull()
    expect(within(slot.getByRole('region', { name: 'Evidence of validate-app' })).getByText('1 of 2 met')).toBeTruthy()
  })

  it('shows why the evidence cannot be read', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'), undefined, {
      runEvidence: () => {
        throw new Error('BETTY is down')
      },
    })

    expect((await slot.findByRole('alert')).textContent).toContain('BETTY is down')
  })
})

describe('BETTY step artifacts', () => {
  const ARTIFACTS = [
    { artifactId: 'a-review', kind: 'post_review', sizeBytes: 76, attempt: 1 },
    { artifactId: 'a-transcript', kind: 'transcript', sizeBytes: 1531592, attempt: 1 },
  ]

  function renderArtifacts(content: { content: string; note: string | null }, list: () => typeof ARTIFACTS = () => ARTIFACTS) {
    const stepArtifacts = vi.fn(list)
    const artifact = vi.fn(() => content)
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'), undefined, { stepArtifacts, artifact })
    return { slot, stepArtifacts, artifact }
  }

  it('loads the artifacts of a step only after a click and shows one after a click on it', async () => {
    const { slot, stepArtifacts, artifact } = renderArtifacts({ content: 'Two findings.', note: null })
    const steps = await slot.findByRole('region', { name: 'Steps' })
    const step = within(steps).getByRole('listitem', { name: 'validate-app' })
    expect(stepArtifacts).not.toHaveBeenCalled()

    await act(async () => within(step).getByRole('button', { name: 'Artifacts of validate-app' }).click())
    const list = await within(step).findByRole('list', { name: 'Artifacts' })
    expect(stepArtifacts).toHaveBeenCalledWith({ taskId: VALIDATE_APP.taskId })
    expect(within(list).getByRole('button', { name: 'transcript · 1.5 MB' })).toBeTruthy()
    expect(artifact).not.toHaveBeenCalled()

    await act(async () => within(list).getByRole('button', { name: 'post_review · 76 B' }).click())
    expect(await within(list).findByText('Two findings.')).toBeTruthy()
    expect(artifact).toHaveBeenCalledWith({ artifactId: 'a-review' })

    await act(async () => within(list).getByRole('button', { name: 'post_review · 76 B' }).click())
    expect(within(list).queryByText('Two findings.')).toBeNull()
  })

  it('shows the note PESTO sends when it cut an artifact', async () => {
    const { slot } = renderArtifacts({ content: 'x', note: 'truncated: showing the first 98304 bytes of a gzipped artifact (1531592 bytes compressed).' })
    const step = within(await slot.findByRole('region', { name: 'Steps' })).getByRole('listitem', { name: 'validate-app' })

    await act(async () => within(step).getByRole('button', { name: 'Artifacts of validate-app' }).click())
    await act(async () => (await within(step).findByRole('button', { name: 'transcript · 1.5 MB' })).click())

    expect(await within(step).findByText('truncated: showing the first 98304 bytes of a gzipped artifact (1531592 bytes compressed).')).toBeTruthy()
  })

  it('reads an open artifact list again every 30 seconds and shows the attempt once the step ran again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let list = ARTIFACTS
    const { slot, stepArtifacts, artifact } = renderArtifacts({ content: 'Two findings.', note: null }, () => list)
    const step = within(await slot.findByRole('region', { name: 'Steps' })).getByRole('listitem', { name: 'validate-app' })
    await act(async () => within(step).getByRole('button', { name: 'Artifacts of validate-app' }).click())
    await act(async () => (await within(step).findByRole('button', { name: 'post_review · 76 B' })).click())
    await within(step).findByText('Two findings.')

    list = [{ artifactId: 'a-result-2', kind: 'result', sizeBytes: 1229, attempt: 2 }, ...ARTIFACTS]
    await act(async () => vi.advanceTimersByTime(30_000))

    expect(await within(step).findByRole('button', { name: 'result · attempt 2 · 1.2 KB' })).toBeTruthy()
    expect(within(step).getByRole('button', { name: 'post_review · attempt 1 · 76 B' })).toBeTruthy()
    expect(stepArtifacts).toHaveBeenCalledTimes(2)
    expect(artifact).toHaveBeenCalledTimes(1)
  })

  it('has no artifacts button on a step that did not start', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'))
    const steps = await slot.findByRole('region', { name: 'Steps' })

    expect(within(within(steps).getByRole('listitem', { name: 'remediate-app' })).queryByRole('button', { name: 'Artifacts of remediate-app' })).toBeNull()
  })
})

const DECISION_DETAIL: RunDetail = {
  ...FIXTURE_DETAIL,
  nodes: FIXTURE_DETAIL.nodes.map((node) => {
    if (node.name === 'review-2') return { ...node, status: 'suspended', error: 'ci is red after 2 remediation attempt(s) (max 2)' }
    if (node.name === 'publish-review' || node.name === 'teardown-env') return { ...node, status: 'pending' }
    return node
  }),
}

const REVIEW_2 = DECISION_DETAIL.nodes.find((node) => node.name === 'review-2')!

function renderDecision(handlers: { approveStep?: () => null; denyStep?: () => null; stopRun?: () => { failed: { step: string; error: string }[] } } = {}) {
  const runDetail = vi.fn(() => DECISION_DETAIL)
  const approveStep = vi.fn(handlers.approveStep ?? (() => null))
  const denyStep = vi.fn(handlers.denyStep ?? (() => null))
  const stopRun = vi.fn(handlers.stopRun ?? (() => ({ failed: [] })))
  const slot = renderSlot(app.navPanels[0]!, { subPath: DECISION_DETAIL.runId }, {
    rpc: {
      authStatus: () => ({ state: 'signed-in' }),
      startSignIn: () => ({ url: 'https://betty.test/oauth/authorize' }),
      myRuns: () => myRuns(),
      runDetail,
      runEvidence: () => [],
      approveStep,
      denyStep,
      stopRun,
    },
  })
  return { slot, runDetail, approveStep, denyStep, stopRun }
}

describe('BETTY decisions', () => {
  it('shows why a step waits for a decision and what it spent', async () => {
    const { slot } = renderDecision()

    const card = await slot.findByRole('region', { name: 'Decide on review-2' })

    expect(within(card).getByText('ci is red after 2 remediation attempt(s) (max 2)')).toBeTruthy()
    expect(within(card).getByText('Spent $0.35 of $6.00')).toBeTruthy()
  })

  it('approves a step with double the old budget and a hint', async () => {
    const { slot, approveStep } = renderDecision()
    const card = await slot.findByRole('region', { name: 'Decide on review-2' })

    await act(async () => within(card).getByRole('button', { name: 'Approve' }).click())
    const form = within(card).getByRole('form', { name: 'Approve review-2' })
    expect((within(form).getByLabelText('New budget (USD)') as HTMLInputElement).value).toBe('12')
    await act(async () => fireEvent.change(within(form).getByLabelText('Hint (optional)'), { target: { value: 'Skip the flaky test.' } }))
    await act(async () => within(form).getByRole('button', { name: 'Approve' }).click())

    expect(approveStep).toHaveBeenCalledWith({ taskId: REVIEW_2.taskId, budgetUsd: 12, hint: 'Skip the flaky test.' })
    expect(within(card).queryByRole('form')).toBeNull()
  })

  it('does not approve a budget that is not above what the step spent', async () => {
    const { slot, approveStep } = renderDecision()
    const card = await slot.findByRole('region', { name: 'Decide on review-2' })

    await act(async () => within(card).getByRole('button', { name: 'Approve' }).click())
    const form = within(card).getByRole('form', { name: 'Approve review-2' })
    await act(async () => fireEvent.change(within(form).getByLabelText('New budget (USD)'), { target: { value: '0.3' } }))

    expect(within(form).getByText('The budget must be more than the $0.35 this step spent.')).toBeTruthy()
    expect((within(form).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect(approveStep).not.toHaveBeenCalled()
  })

  it('shows why BETTY refused the approval', async () => {
    const { slot } = renderDecision({
      approveStep: () => {
        throw new Error('budget must exceed spend')
      },
    })
    const card = await slot.findByRole('region', { name: 'Decide on review-2' })

    await act(async () => within(card).getByRole('button', { name: 'Approve' }).click())
    await act(async () => within(within(card).getByRole('form')).getByRole('button', { name: 'Approve' }).click())

    expect((await within(card).findByRole('alert')).textContent).toContain('budget must exceed spend')
  })

  it('denies a step only with a reason', async () => {
    const { slot, denyStep } = renderDecision()
    const card = await slot.findByRole('region', { name: 'Decide on review-2' })

    await act(async () => within(card).getByRole('button', { name: 'Deny' }).click())
    const form = within(card).getByRole('form', { name: 'Deny review-2' })
    const submit = within(form).getByRole('button', { name: 'Deny' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await act(async () => fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Wrong approach.' } }))
    await act(async () => submit.click())

    expect(denyStep).toHaveBeenCalledWith({ taskId: REVIEW_2.taskId, reason: 'Wrong approach.' })
  })

  it('asks before it stops the run and names the steps that still run', async () => {
    const { slot, stopRun } = renderDecision()

    await act(async () => (await slot.findByRole('button', { name: 'Stop run' })).click())
    const confirm = slot.getByRole('group', { name: 'Stop the run' })
    expect(within(confirm).getByText('Stop 1 step? teardown-env still runs.')).toBeTruthy()
    await act(async () => within(confirm).getByRole('button', { name: 'Cancel' }).click())

    expect(stopRun).not.toHaveBeenCalled()
    expect(slot.queryByRole('group', { name: 'Stop the run' })).toBeNull()

    await act(async () => slot.getByRole('button', { name: 'Stop run' }).click())
    await act(async () => within(slot.getByRole('group', { name: 'Stop the run' })).getByRole('button', { name: 'Stop run' }).click())

    expect(stopRun).toHaveBeenCalledWith({ runId: DECISION_DETAIL.runId })
  })

  it('shows the steps that did not stop', async () => {
    const { slot } = renderDecision({ stopRun: () => ({ failed: [{ step: 'review-2', error: 'task already finished' }] }) })

    await act(async () => (await slot.findByRole('button', { name: 'Stop run' })).click())
    await act(async () => within(slot.getByRole('group', { name: 'Stop the run' })).getByRole('button', { name: 'Stop run' }).click())

    expect((await slot.findByRole('alert')).textContent).toBe('Could not stop 1 step:review-2: task already finished')
  })

  it('has no stop button on a finished run', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'))

    await slot.findByRole('heading', { name: FIXTURE_DETAIL.runId })

    expect(slot.queryByRole('button', { name: 'Stop run' })).toBeNull()
    expect(slot.queryByRole('region', { name: /^Decide on/ })).toBeNull()
  })
})

describe('BETTY run tab', () => {
  it('asks to sign in when signed out', async () => {
    const slot = renderSlot({ component: app.tabs[0]!.component as ComponentType<{ threadId: string }> }, { threadId: 'thr_1' }, {
      rpc: { authStatus: () => ({ state: 'signed-out' }), startSignIn: () => ({ url: 'https://betty.test/oauth/authorize' }), myRuns: () => myRuns() },
    })

    expect(await slot.findByRole('button', { name: 'Sign in to BETTY' })).toBeTruthy()
  })

  it('shows the run detail of the linked run', async () => {
    const slot = renderThreadTab({ kind: 'linked', runId: 'Rename the column', chip: null, pullRequests: [], error: null })

    expect(await slot.findByRole('heading', { name: 'Rename the column' })).toBeTruthy()
    expect(slot.getByText(/CI may run only a few checks/)).toBeTruthy()
    expect(slot.getByRole('img', { name: /Clean run up to \$78\.00 · Worst case up to \$105\.00/ })).toBeTruthy()
    expect(slot.queryByRole('listitem', { name: 'remediate-review' })).toBeNull()

    await act(async () => slot.getByRole('button', { name: /^Steps/ }).click())

    expect(slot.getByRole('listitem', { name: 'remediate-review' }).textContent).toContain('$0.56/$12.00')
  })

  it('lets you decide on a step and stop the run', async () => {
    const slot = renderThreadTab({ kind: 'linked', runId: DECISION_DETAIL.runId, chip: null, pullRequests: [], error: null }, () => DECISION_DETAIL)

    const card = await slot.findByRole('region', { name: 'Decide on review-2' })

    expect(within(card).getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(slot.getByRole('button', { name: 'Stop run' })).toBeTruthy()
  })

  it('says when the thread has no run', async () => {
    const slot = renderThreadTab({ kind: 'none', ticketKey: null })

    expect(await slot.findByText('No BETTY run for this thread yet.')).toBeTruthy()
  })
})

function renderThreadTab(threadRun: ThreadRun, runDetail: () => RunDetail = () => detailWithBase('release/1')) {
  return renderSlot({ component: app.tabs[0]!.component as ComponentType<{ threadId: string }> }, { threadId: 'thr_1' }, {
    rpc: {
      authStatus: () => ({ state: 'signed-in' }),
      startSignIn: () => ({ url: 'https://betty.test/oauth/authorize' }),
      myRuns: () => myRuns(),
      threadRun: () => threadRun,
      runDetail,
      runEvidence: () => [],
    },
  })
}
