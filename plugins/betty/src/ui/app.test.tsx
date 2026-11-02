// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react'
import { act, type ComponentType } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadPluginApp, renderSlot, type CapturedPluginApp } from '@get-bb/plugin-sdk/testing/app'
import type { AuthKind } from '../auth/state'
import dagStatus from '../fixtures/dag-status.json'
import type { PullRequest, RunDetail, RunOutcome, RunSummary } from '../pesto/types'
import { runDetailSchema } from '../pesto/wire'
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

function renderDetail(runId: string, runDetail: () => RunDetail) {
  return renderSlot(app.navPanels[0]!, { subPath: runId }, {
    rpc: {
      authStatus: () => ({ state: 'signed-in' }),
      startSignIn: () => ({ url: 'https://betty.test/oauth/authorize' }),
      myRuns: () => myRuns(),
      runDetail,
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
    expect(slot.getByText(/^Spent/).textContent).toBe('Spent $3.66')
    expect(slot.getByText(/^Clean run/).textContent).toBe('Clean run up to $78.00 · Worst case up to $105.00 (one attempt per step)')
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
    await act(async () => within(section).getByRole('button', { name: 'Remediation by remediate-review' }).click())

    expect(slot.navigateCalls).toEqual([
      { method: 'openUrl', url: 'https://github.com/collibra/frontend/pull/26731' },
      { method: 'openUrl', url: 'https://github.com/collibra/frontend/pull/26731#issuecomment-6473319138' },
    ])
    expect(within(section).getByText('Review by revalidate-app').parentElement!.textContent).toBe('Review by revalidate-appplanned')
    expect(within(section).queryByRole('button', { name: 'Review by revalidate-app' })).toBeNull()
  })

  it('shows each step with its status, spend against budget and when it runs', async () => {
    const slot = renderDetail(FIXTURE_DETAIL.runId, () => detailWithBase('main'))
    const steps = await slot.findByRole('region', { name: 'Steps' })

    const remediate = within(steps).getByRole('listitem', { name: 'remediate-review' })
    expect(within(remediate).getByText('Done')).toBeTruthy()
    expect(within(remediate).getByText('$0.56/$12.00')).toBeTruthy()
    expect(within(remediate).getByText('After implement, review')).toBeTruthy()

    const fix = within(steps).getByRole('listitem', { name: 'remediate-app' })
    expect(within(fix).getByText('Skipped')).toBeTruthy()
    expect(within(fix).getByText('Only when $validate-app.output.all_met == false')).toBeTruthy()

    const teardown = within(steps).getByRole('listitem', { name: 'teardown-env' })
    expect(within(teardown).getByText('script')).toBeTruthy()
    expect(within(teardown).getByText('Always runs')).toBeTruthy()
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

describe('BETTY run tab', () => {
  it('asks to sign in when signed out', async () => {
    const slot = renderSlot({ component: app.tabs[0]!.component as ComponentType<{ threadId: string }> }, { threadId: 'thr_1' }, {
      rpc: { authStatus: () => ({ state: 'signed-out' }), startSignIn: () => ({ url: 'https://betty.test/oauth/authorize' }), myRuns: () => myRuns() },
    })

    expect(await slot.findByRole('button', { name: 'Sign in to BETTY' })).toBeTruthy()
  })
})
