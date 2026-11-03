import { createFakePluginHost, type FakePluginHost } from '@get-bb/plugin-sdk/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlugin } from '../server'
import { createFakeBetty } from './auth/fakeBetty'
import { createFakePesto } from './pesto/fakePesto'
import type { NodeStatus } from './pesto/types'

const THREAD = 'thread-1'
const RUN = 'run-1'

function createFakeThreads() {
  const sent: { threadId: string; text: string }[] = []
  const behavior = { sendFails: false }
  const sdk = {
    threads: {
      getPluginMetadata: async () => ({}),
      updatePluginMetadata: async () => ({}),
      send: async ({ threadId, input }: { threadId: string; input: { type: string; text?: string }[] }) => {
        if (behavior.sendFails) throw new Error('thread is gone')
        sent.push({ threadId, text: input.map((part) => part.text ?? '').join('') })
        return {}
      },
    },
    plugins: { reload: async () => ({ ok: true }) },
  }
  return { sdk, sent, behavior }
}

async function start() {
  const betty = createFakeBetty()
  const runs = new Map<string, NodeStatus[]>()
  const pesto = createFakePesto({
    tools: {
      pesto_dag_status: ({ run_id }) => {
        const statuses = runs.get(String(run_id))
        if (!statuses) return { text: `run ${String(run_id)} not found`, isError: true }
        const nodes = statuses.map((status, index) => ({ task_id: `t${index}`, name: `n${index}`, executor: 'agent', status }))
        return { text: JSON.stringify({ run_id, total_cost_usd: 1, nodes }) }
      },
    },
  })
  const fetch: typeof globalThis.fetch = (input, init) =>
    new URL(String(input)).pathname === '/mcp' ? pesto.fetch(input, init) : betty.fetch(input, init)
  const threads = createFakeThreads()
  const first = createFakePluginHost({ pluginId: 'betty', settings: { baseUrl: betty.base }, sdk: threads.sdk })
  await createPlugin({ fetch })(first.bb)
  const { url } = (await first.harness.behavior.callRpc('startSignIn', null)) as { url: string }
  await first.harness.behavior.fetchHttp('GET', `/oauth/callback?${new URLSearchParams(betty.approve(url))}`)
  await vi.advanceTimersByTimeAsync(0)
  let host = first
  const restart = async () => (host = await host.harness.lifecycle.reload(createPlugin({ fetch })))
  await restart()
  const statusCalls = () => pesto.toolCalls().filter((call) => call.body?.params?.name === 'pesto_dag_status').length
  return { host: () => host, restart, runs, threads, betty, statusCalls }
}

const link = (host: FakePluginHost, runId = RUN, threadId = THREAD) =>
  host.harness.behavior.callAgentTool('betty_link_run', { runId }, { threadId })

async function watch(host: FakePluginHost) {
  const service = host.harness.behavior.runService('run-watcher')
  await vi.advanceTimersByTimeAsync(0)
  return service
}

const nextTick = () => vi.advanceTimersByTimeAsync(30_000)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('run watcher', () => {
  it('tells the linked thread once when the run needs a decision', async () => {
    const { host, runs, threads } = await start()
    runs.set(RUN, ['succeeded', 'running'])
    await link(host())
    await watch(host())

    runs.set(RUN, ['succeeded', 'suspended'])
    await nextTick()
    await nextTick()

    expect(threads.sent).toEqual([{ threadId: THREAD, text: `BETTY run \`${RUN}\` needs a decision.` }])
  })

  it.each([
    [['succeeded', 'succeeded'], 'finished'],
    [['succeeded', 'failed'], 'failed'],
    [['succeeded', 'cancelled'], 'was cancelled'],
  ] as [NodeStatus[], string][])('tells the thread once when the run ends as %j and stops checking it', async (statuses, notice) => {
    const { host, runs, threads, statusCalls } = await start()
    runs.set(RUN, ['succeeded', 'running'])
    await link(host())
    await watch(host())

    runs.set(RUN, statuses)
    await nextTick()
    const callsAfterEnd = statusCalls()
    await nextTick()
    await nextTick()

    expect(threads.sent).toEqual([{ threadId: THREAD, text: `BETTY run \`${RUN}\` ${notice}.` }])
    expect(statusCalls()).toBe(callsAfterEnd)
  })

  it('remembers what it told the thread after a plugin reload', async () => {
    const { host, restart, runs, threads } = await start()
    runs.set(RUN, ['running'])
    await link(host())
    await watch(host())
    runs.set(RUN, ['suspended'])
    await nextTick()

    await restart()
    await watch(host())
    await nextTick()

    expect(threads.sent).toHaveLength(1)
  })

  it('says nothing when the linked run already finished', async () => {
    const { host, runs, threads, statusCalls } = await start()
    runs.set(RUN, ['succeeded'])
    await link(host())
    const callsAfterLink = statusCalls()

    await watch(host())
    await nextTick()

    expect(threads.sent).toEqual([])
    expect(statusCalls()).toBe(callsAfterLink)
  })

  it('tells the thread on the next check when sending fails', async () => {
    const { host, runs, threads } = await start()
    runs.set(RUN, ['running'])
    await link(host())
    await watch(host())
    threads.behavior.sendFails = true

    runs.set(RUN, ['failed'])
    await nextTick()
    expect(threads.sent).toEqual([])
    expect(host().harness.logEntries).toContainEqual({ level: 'warn', message: `Could not check BETTY run ${RUN}: thread is gone` })

    threads.behavior.sendFails = false
    await nextTick()
    expect(threads.sent).toEqual([{ threadId: THREAD, text: `BETTY run \`${RUN}\` failed.` }])
  })

  it('keeps checking the other runs when one run cannot be read', async () => {
    const { host, runs, threads } = await start()
    runs.set(RUN, ['running'])
    runs.set('run-2', ['running'])
    await link(host())
    await link(host(), 'run-2', 'thread-2')
    await watch(host())

    runs.delete(RUN)
    runs.set('run-2', ['failed'])
    await nextTick()

    expect(threads.sent).toEqual([{ threadId: 'thread-2', text: 'BETTY run `run-2` failed.' }])
  })

  it('does not call BETTY when the user is not signed in', async () => {
    const { host, restart, runs, betty, statusCalls } = await start()
    runs.set(RUN, ['running'])
    await link(host())
    betty.behavior.token = 'reject-refresh'
    await vi.advanceTimersByTimeAsync(3600_000)
    await restart()
    const callsBefore = statusCalls()

    await watch(host())
    await nextTick()

    expect(statusCalls()).toBe(callsBefore)
  })

  it('stops when the host aborts it and leaves no timer behind', async () => {
    const { host, runs, statusCalls } = await start()
    runs.set(RUN, ['running'])
    await link(host())
    const timersBefore = vi.getTimerCount()
    const { controller, done } = await watch(host())

    controller.abort()
    await done
    expect(vi.getTimerCount()).toBe(timersBefore)
    const callsAfterStop = statusCalls()
    await nextTick()

    expect(statusCalls()).toBe(callsAfterStop)
  })

  it('stops on a plugin reload', async () => {
    const { host, restart, runs, statusCalls } = await start()
    runs.set(RUN, ['running'])
    await link(host())
    const { done } = await watch(host())

    await restart()
    await done
    const callsAfterReload = statusCalls()
    await nextTick()

    expect(statusCalls()).toBe(callsAfterReload)
  })
})
