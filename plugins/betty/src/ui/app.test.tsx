// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react'
import { act, type ComponentType } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadPluginApp, renderSlot, type CapturedPluginApp } from '@get-bb/plugin-sdk/testing/app'
import type { AuthKind } from '../auth/state'
import type { PullRequest, RunOutcome, RunSummary } from '../pesto/types'
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

const myRuns = (overrides: Partial<MyRuns> = {}): MyRuns => ({ refreshedAt: REFRESHED_AT, runs: RUNS, cutOff: false, ...overrides })

describe('BETTY runs page', () => {
  it('groups the runs and counts them in tiles with the total spend', async () => {
    const slot = renderPage(() => myRuns())

    const decision = await slot.findByRole('region', { name: 'Needs a decision' })
    const inFlight = slot.getByRole('region', { name: 'In flight' })
    const finished = slot.getByRole('region', { name: 'Finished' })

    expect(within(decision).getByText('Pick a schema')).toBeTruthy()
    expect(within(inFlight).getByText('Rename the column')).toBeTruthy()
    expect(within(inFlight).getByText('Watching CI')).toBeTruthy()
    expect(within(finished).getByText('Add the KPI')).toBeTruthy()
    expect(within(finished).getByText('Drop the flag')).toBeTruthy()
    expect(within(inFlight).getByText('4/15 nodes')).toBeTruthy()
    expect(within(inFlight).getByText('$2.25')).toBeTruthy()
    expect(within(inFlight).getByText('1 Nov 2026, 10:30')).toBeTruthy()
    const totals = slot.getByRole('region', { name: 'Totals' })
    const tile = (label: string) => within(totals).getByText(label).parentElement!
    expect(tile('Needs a decision').textContent).toBe('Needs a decision1')
    expect(tile('In flight').textContent).toBe('In flight1')
    expect(tile('Finished').textContent).toBe('Finished2')
    expect(tile('Spend').textContent).toBe('Spend$6.75')
    expect(slot.queryByRole('status')).toBeNull()
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
    expect(await slot.findByText('Updated 12:15:30')).toBeTruthy()

    refreshedAt += 30_000
    await act(async () => vi.advanceTimersByTime(30_000))

    expect(await slot.findByText('Updated 12:16:00')).toBeTruthy()
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

describe('BETTY run tab', () => {
  it('asks to sign in when signed out', async () => {
    const slot = renderSlot({ component: app.tabs[0]!.component as ComponentType<{ threadId: string }> }, { threadId: 'thr_1' }, {
      rpc: { authStatus: () => ({ state: 'signed-out' }), startSignIn: () => ({ url: 'https://betty.test/oauth/authorize' }), myRuns: () => myRuns() },
    })

    expect(await slot.findByRole('button', { name: 'Sign in to BETTY' })).toBeTruthy()
  })
})
