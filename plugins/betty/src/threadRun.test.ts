import { createFakePluginHost, makePluginAgentConfigurationContext, type FakePluginHost } from '@get-bb/plugin-sdk/testing'
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlugin } from '../server'
import { createFakeBetty } from './auth/fakeBetty'
import { createFakePesto, fixture } from './pesto/fakePesto'
import { chipLabel, chipProgress, runChip, runStatus } from './runChip'
import type { NodeStatus } from './pesto/types'
import { runDetailSchema } from './pesto/wire'

const THREAD = 'thread-1'
const RUN = 'central-frontend-team-browser-validated-f153a0'

function createFakeThreads(jira: Record<string, Record<string, unknown>> = {}) {
  const key = (pluginId: string | undefined, threadId: string) => `${pluginId ?? 'betty'}:${threadId}`
  const metadata = new Map<string, Record<string, unknown>>(Object.entries(jira).map(([threadId, value]) => [`jira:${threadId}`, value]))
  const sent: { threadId: string; text: string }[] = []
  const sdk = {
    threads: {
      getPluginMetadata: async ({ threadId, pluginId }: { threadId: string; pluginId?: string }) => metadata.get(key(pluginId, threadId)) ?? {},
      updatePluginMetadata: async ({ threadId, pluginId, set }: { threadId: string; pluginId?: string; set?: Record<string, unknown> }) => {
        const next = { ...metadata.get(key(pluginId, threadId)), ...set }
        metadata.set(key(pluginId, threadId), next)
        return next
      },
      send: async ({ threadId, input }: { threadId: string; input: { type: string; text?: string }[] }) => {
        sent.push({ threadId, text: input.map((part) => part.text ?? '').join('') })
        return {}
      },
      spawn: async () => {
        throw new Error('a BETTY run must never spawn a thread')
      },
      fork: async () => {
        throw new Error('a BETTY run must never fork a thread')
      },
    },
    plugins: { reload: async () => ({ ok: true }) },
  }
  return { sdk, sent, betty: (threadId: string) => metadata.get(`betty:${threadId}`) }
}

type Threads = ReturnType<typeof createFakeThreads>

function dag(statuses: NodeStatus[], cost: number) {
  return runDetailSchema.parse({
    run_id: 'run',
    total_cost_usd: cost,
    nodes: statuses.map((status, index) => ({ task_id: `t${index}`, name: `n${index}`, executor: 'agent', status })),
  })
}

async function start(threads: Threads, pestoUp = { value: true }) {
  const betty = createFakeBetty()
  const pesto = createFakePesto({
    tools: {
      pesto_dag_status: (args) =>
        args.run_id === RUN ? { text: fixture('dag-status.json') } : { text: `run ${String(args.run_id)} not found`, isError: true },
    },
  })
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (new URL(String(input)).pathname !== '/mcp') return betty.fetch(input, init)
    if (!pestoUp.value) return Promise.resolve(new Response('unavailable', { status: 503 }))
    return pesto.fetch(input, init)
  }
  const host = createFakePluginHost({ pluginId: 'betty', settings: { baseUrl: betty.base }, sdk: threads.sdk, agentSkillIds: shippedSkillNames() })
  await createPlugin({ fetch })(host.bb)
  const { url } = (await host.harness.behavior.callRpc('startSignIn', null)) as { url: string }
  await host.harness.behavior.fetchHttp('GET', `/oauth/callback?${new URLSearchParams(betty.approve(url))}`)
  await vi.advanceTimersByTimeAsync(0)
  let current = host
  const restart = async () => (current = await current.harness.lifecycle.reload(createPlugin({ fetch })))
  return { host: await restart(), restart, pesto }
}

const threadRun = (host: FakePluginHost, threadId = THREAD) => host.harness.behavior.callRpc('threadRun', { threadId })

const linkTool = (host: FakePluginHost, runId: string, threadId = THREAD) =>
  host.harness.behavior.callAgentTool('betty_link_run', { runId }, { threadId })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('run status', () => {
  it.each<[NodeStatus[], string]>([
    [['succeeded', 'suspended', 'running', 'failed'], 'needs_decision'],
    [['succeeded', 'pending', 'failed', 'cancelled'], 'failed'],
    [['succeeded', 'pending'], 'running'],
    [['succeeded', 'running'], 'running'],
    [['succeeded', 'failed', 'cancelled'], 'failed'],
    [['succeeded', 'cancelled', 'skipped'], 'cancelled'],
    [['succeeded', 'skipped'], 'succeeded'],
    [['succeeded', 'unknown'], 'unknown'],
    [[], 'unknown'],
  ])('%j is %s', (statuses, expected) => {
    expect(runStatus(statuses.map((status) => ({ status })))).toBe(expected)
  })

  it('counts finished steps and shows them with the spend', () => {
    const chip = runChip(dag(['succeeded', 'skipped', 'failed', 'cancelled', 'running', 'pending', 'suspended', 'pending'], 4.1))

    expect(chip).toEqual({ status: 'needs_decision', nodesDone: 4, nodesTotal: 8, costUsd: 4.1 })
    expect(chipLabel({ status: 'running', nodesDone: 6, nodesTotal: 14, costUsd: 4.1 })).toBe('BETTY · Running · 6/14 · $4.10')
    expect(chipLabel(null)).toBe('BETTY · unknown')
    expect(chipProgress({ status: 'running', nodesDone: 6, nodesTotal: 14, costUsd: 4.1 })).toBe('6/14 · $4.10')
  })
})

describe('thread run link', () => {
  it('stores only the run id in betty metadata and reads it back after a restart', async () => {
    const threads = createFakeThreads()
    const { host, restart } = await start(threads)

    expect(await linkTool(host, RUN)).toBe(`Linked BETTY run ${RUN} to this thread. BETTY · Succeeded · 15/15 · $3.66`)
    expect(threads.betty(THREAD)).toEqual({ runId: RUN })

    const next = await restart()
    expect(await threadRun(next)).toEqual({
      kind: 'linked',
      runId: RUN,
      chip: { status: 'succeeded', nodesDone: 15, nodesTotal: 15, costUsd: 3.6576999999999997 },
      pullRequests: [{ number: 26731, url: 'https://github.com/collibra/frontend/pull/26731', state: 'open', repo: 'collibra/frontend' }],
      error: null,
    })
  })

  it('links the thread that called the tool and never spawns or forks one', async () => {
    const threads = createFakeThreads()
    const { host } = await start(threads)

    await linkTool(host, RUN, 'thread-2')

    expect(threads.betty('thread-2')).toEqual({ runId: RUN })
    expect(threads.betty(THREAD)).toBeUndefined()
    const calls = host.harness.inspection.sdk.calls.map((call) => call.path)
    expect(calls).toContain('threads.updatePluginMetadata')
    expect(calls).not.toContain('threads.spawn')
    expect(calls).not.toContain('threads.fork')
  })

  it('refuses an unknown run id and writes nothing', async () => {
    const threads = createFakeThreads()
    const { host } = await start(threads)

    const result = await linkTool(host, 'no-such-run')

    expect(result).toMatchObject({ isError: true })
    expect(threads.betty(THREAD)).toBeUndefined()
    expect(await threadRun(host)).toEqual({ kind: 'none', ticketKey: null })
  })

  it('selects the link, status and evidence tools and the betty skill for every agent session', async () => {
    const { host } = await start(createFakeThreads())

    const config = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({}))

    expect(config.tools.map((tool) => tool.name)).toEqual(['betty_link_run', 'betty_status', 'betty_evidence'])
    expect(config.skills).toEqual(['betty'])
  })

  it('keeps the link and shows the error when BETTY cannot be read', async () => {
    const threads = createFakeThreads()
    const pestoUp = { value: true }
    const { host } = await start(threads, pestoUp)
    await linkTool(host, RUN)

    pestoUp.value = false

    expect(await threadRun(host)).toMatchObject({ kind: 'linked', runId: RUN, chip: null, pullRequests: [], error: expect.stringContaining('503') })
  })
})

describe('thread without a run', () => {
  it.each([
    ['a Jira key', { issueKey: 'DEV-123' }, 'DEV-123'],
    ['no Jira link', undefined, null],
    ['an invalid Jira key', { issueKey: 'dev-123' }, null],
    ['a non-string Jira key', { issueKey: 42 }, null],
  ])('offers a run with %s', async (_name, jira, ticketKey) => {
    const { host } = await start(createFakeThreads(jira ? { [THREAD]: jira } : {}))

    expect(await threadRun(host)).toEqual({ kind: 'none', ticketKey })
  })

  it('has no ticket key when the Jira metadata cannot be read', async () => {
    const threads = createFakeThreads()
    const { host } = await start(threads)
    host.harness.inspection.sdk.stub('threads.getPluginMetadata', async ({ pluginId }: { pluginId?: string }) => {
      if (pluginId === 'jira') throw new Error('no jira')
      return {}
    })

    expect(await threadRun(host)).toEqual({ kind: 'none', ticketKey: null })
  })

  it('asks the agent of the same thread to start the run for the ticket', async () => {
    const threads = createFakeThreads({ [THREAD]: { issueKey: 'DEV-123' } })
    const { host } = await start(threads)

    expect(await host.harness.behavior.callRpc('startRun', { threadId: THREAD })).toBeNull()

    expect(threads.sent).toHaveLength(1)
    expect(threads.sent[0]!.threadId).toBe(THREAD)
    expect(threads.sent[0]!.text).toContain('DEV-123')
    expect(threads.sent[0]!.text).toContain('betty_link_run')
  })

  it('asks for a run for the thread work when there is no Jira key', async () => {
    const threads = createFakeThreads()
    const { host } = await start(threads)

    await host.harness.behavior.callRpc('startRun', { threadId: THREAD })

    expect(threads.sent).toHaveLength(1)
    expect(threads.sent[0]!.text).toContain('the work in this thread')
  })
})

function shippedSkillNames(): string[] {
  const root = new URL('../skills/', import.meta.url)
  return readdirSync(root).map((dir) => readFileSync(new URL(`${dir}/SKILL.md`, root), 'utf8').match(/^name: (.+)$/m)![1]!)
}
