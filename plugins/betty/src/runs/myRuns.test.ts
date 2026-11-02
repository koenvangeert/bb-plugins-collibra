import { describe, expect, it } from 'vitest'
import { createPestoClient } from '../pesto/client'
import { createFakePesto, fixture } from '../pesto/fakePesto'
import { createMcpSession } from '../pesto/mcp'
import { loadMyRuns } from './myRuns'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const OWNER = 'koen.vangeert@collibra.com'

type WireRun = Record<string, unknown>

const [succeeded] = JSON.parse(fixture('run-list.json')).runs as WireRun[]

const run = (runId: string, outcome: string, lastStatusChangeAt: string): WireRun => ({
  ...succeeded,
  run_id: runId,
  outcome,
  last_status_change_at: lastStatusChangeAt,
})

const list = (runs: WireRun[], beyond = 0) => ({
  text: JSON.stringify({ runs, runs_beyond_limit: beyond, runs_matched: runs.length + beyond }),
})

function load(lists: { recent: ReturnType<typeof list>; active: ReturnType<typeof list> }) {
  const pesto = createFakePesto({
    tools: { pesto_dag_status: (args) => (args.include_finished ? lists.recent : lists.active) },
  })
  const session = createMcpSession({ endpoint: () => 'https://betty.test/mcp', getToken: async () => 't', fetch: pesto.fetch })
  return { pesto, result: loadMyRuns(createPestoClient(session), OWNER, NOW) }
}

describe('my runs', () => {
  it('asks for the last 14 days with finished runs and for every active run', async () => {
    const { pesto, result } = load({ recent: list([]), active: list([]) })
    await result

    expect(pesto.toolCalls().map((call) => call.body!.params!.arguments)).toEqual(
      expect.arrayContaining([
        { owner_dev: OWNER, since: '2026-10-19T12:00:00.000Z', include_finished: true, limit: 100 },
        { owner_dev: OWNER, limit: 100 },
      ]),
    )
    expect(pesto.toolCalls()).toHaveLength(2)
  })

  it('lists each run once, newest change first', async () => {
    const { result } = load({
      recent: list([run('a', 'succeeded', '2026-10-30T10:00:00Z'), run('b', 'running', '2026-11-01T10:00:00Z')]),
      active: list([run('b', 'running', '2026-11-01T10:00:00Z'), run('c', 'waiting', '2026-10-01T10:00:00Z')]),
    })

    const { runs, refreshedAt, cutOff } = await result

    expect(runs.map((entry) => entry.runId)).toEqual(['b', 'a', 'c'])
    expect(runs[1]!.pullRequests[0]).toMatchObject({ number: 26728, state: 'open' })
    expect(refreshedAt).toBe(NOW)
    expect(cutOff).toBe(false)
  })

  it.each([
    ['the recent list', { recent: 3, active: 0 }],
    ['the active list', { recent: 0, active: 1 }],
  ])('says the list is cut off when %s has more runs than it sent', async (_name, beyond) => {
    const { result } = load({ recent: list([], beyond.recent), active: list([], beyond.active) })

    expect((await result).cutOff).toBe(true)
  })

  it('counts a run it cannot read once, when both lists send it', async () => {
    const broken = { run_id: 'broken', outcome: 'running' }
    const { result } = load({
      recent: list([broken as WireRun, run('a', 'succeeded', '2026-10-30T10:00:00Z')]),
      active: list([broken as WireRun]),
    })

    const { runs, unreadable } = await result

    expect(runs.map((entry) => entry.runId)).toEqual(['a'])
    expect(unreadable).toBe(1)
  })
})
