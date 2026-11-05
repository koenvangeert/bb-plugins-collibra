import { createFakePluginHost, type FakePluginHost } from '@get-bb/plugin-sdk/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlugin } from '../server'
import { createFakeBetty } from './auth/fakeBetty'
import { createFakePesto, fixture } from './pesto/fakePesto'

type Tools = NonNullable<Parameters<typeof createFakePesto>[0]['tools']>

const THREAD = 'thread-1'
const RUN = 'central-frontend-team-browser-validated-f153a0'
const VALIDATE_APP = '65bee160-b71b-4d19-a614-8ff73e1cc3b3'

const fixtureTools: Tools = {
  pesto_dag_status: { text: fixture('dag-status.json') },
  pesto_task_show: (args) =>
    args.task_id === VALIDATE_APP ? { text: fixture('task-show-validate.json') } : { text: JSON.stringify({ required_artifacts: ['push_branch'] }) },
  pesto_artifact_get: { text: fixture('artifact-result.json') },
  pesto_task_logs: { text: fixture('task-logs.json') },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('betty_status', () => {
  it('answers with the status, progress and pull request of the linked run and ends with the pointer', async () => {
    const host = await signedIn()

    const { text, isError } = await call(host, 'betty_status')

    expect(isError).toBe(false)
    expect(text.split('\n')[0]).toBe(`BETTY · Succeeded · 15/15 · $3.66 · run ${RUN}`)
    expect(text).toContain('PR collibra/frontend#26731, open, https://github.com/collibra/frontend/pull/26731')
    expect(text).toMatch(/call betty_evidence with its taskId\.$/)
  })

  it('lists the steps that need a decision, failed or run', async () => {
    const run = runJson([
      { task_id: 't-ci', name: 'watch-ci', executor: 'agent', status: 'suspended', cost_usd: 4.27, budget: '$4.27/$6.00' },
      { task_id: 't-impl', name: 'implement', executor: 'agent', status: 'failed', error: 'push rejected' },
      { task_id: 't-rev', name: 'review', executor: 'agent', status: 'running' },
    ])
    const host = await signedIn({ pesto_dag_status: { text: run } })

    const { text } = await call(host, 'betty_status', { runId: 'huge' })

    expect(text).toContain('Needs a decision: watch-ci (t-ci), $4.27 of $6.00 spent.')
    expect(text).toContain('Failed: implement (t-impl): push rejected')
    expect(text).toContain('Running: review (t-rev).')
  })

  it('stays under 4000 chars for a run with hundreds of steps and long errors, and still ends with the pointer', async () => {
    const statuses = ['suspended', 'failed', 'running']
    const nodes = Array.from({ length: 600 }, (_, index) => ({
      task_id: `task-${index}`,
      name: `step-${index}-${'n'.repeat(80)}`,
      executor: 'agent',
      status: statuses[index % 3],
      error: 'boom '.repeat(1000),
    }))
    const host = await signedIn({ pesto_dag_status: { text: runJson(nodes) } })

    const { text } = await call(host, 'betty_status', { runId: 'huge' })

    expect(text.length).toBeLessThan(4000)
    expect(text).toMatch(/more lines cut\.\nThe full run is in the BETTY run tab of the thread\. .*call betty_evidence with its taskId\.$/)
  })

  it('asks to sign in when signed out, and answers on the same thread right after the sign-in', async () => {
    const { host, signIn, reload } = await start()

    const before = await call(host, 'betty_status')
    expect(before.isError).toBe(true)
    expect(before.text).toContain('sign in from the BETTY run tab')

    await signIn()
    expect(await call(host, 'betty_status')).toMatchObject({ isError: false, text: expect.stringContaining('Succeeded') })
    expect(await call(await reload(), 'betty_status')).toMatchObject({ isError: false, text: expect.stringContaining('Succeeded') })
  })

  it.each(['betty_status', 'betty_evidence'])('%s names runId and betty_link_run when the thread has no linked run', async (tool) => {
    const host = await signedIn({}, {})

    const { text, isError } = await call(host, tool)

    expect(isError).toBe(true)
    expect(text).toContain('Pass runId, or link the run with betty_link_run first.')
  })

  it('answers with the PESTO error when the run cannot be read', async () => {
    const host = await signedIn({ pesto_dag_status: { text: 'run nope not found', isError: true } })

    const { text, isError } = await call(host, 'betty_status', { runId: 'nope' })

    expect(isError).toBe(true)
    expect(text).toContain('run nope not found')
  })
})

describe('betty_evidence', () => {
  it('answers with the AC evidence of the linked run and warns about faked backend data', async () => {
    const host = await signedIn()

    const { text, isError } = await call(host, 'betty_evidence')

    expect(isError).toBe(false)
    expect(text).toContain(`Step validate-app (${VALIDATE_APP}):`)
    expect(text).toContain('AC-1 met: On an AI Agent asset with Guardian off, the tab bar has no Guardian tab. Screenshots: 1. Evidence: On the deployed DGC')
    expect(text).toContain('Warning: the evidence mentions faked backend data')
    expect(text).toMatch(/call it with an artifactId to read one in full\.$/)
  })

  it('stays under 4000 chars for many steps with long criteria and evidence', async () => {
    const nodes = Array.from({ length: 40 }, (_, index) => ({ task_id: `task-${index}`, name: `validate-${index}`, executor: 'agent', status: 'succeeded' }))
    const criteria = Array.from({ length: 30 }, (_, index) => `AC-${index}: ${'criterion '.repeat(100)}`).join('\n')
    const acs = Array.from({ length: 30 }, (_, index) => ({ id: `AC-${index}`, met: index % 2 === 0, evidence: 'evidence '.repeat(500), images: ['a.png'] }))
    const host = await signedIn({
      pesto_dag_status: { text: runJson(nodes) },
      pesto_task_show: { text: JSON.stringify({ required_artifacts: ['result'], acceptance_criteria: criteria }) },
      pesto_artifact_get: { text: JSON.stringify({ content: JSON.stringify({ acs }) }) },
    })

    const { text } = await call(host, 'betty_evidence', { runId: 'huge' })

    expect(text.length).toBeLessThan(4000)
    expect(text).toContain('AC-1 NOT MET')
    expect(text).toMatch(/more lines cut\.\n.*call it with an artifactId to read one in full\.$/)
  })

  it('lists the artifacts of a step', async () => {
    const host = await signedIn()

    const { text } = await call(host, 'betty_evidence', { taskId: 'ff3bc7e0-644a-47b0-895b-368497922af8' })

    expect(text).toContain('transcript, attempt 1, 1531592 bytes, artifactId f6cf7bf4-a16f-4589-9cc5-59d4636a4323')
    expect(text.split('\n')).toHaveLength(5)
    expect(text).toMatch(/call betty_evidence with its artifactId\.$/)
  })

  it('pages through an artifact so the pages put together are the exact content', async () => {
    const content = Array.from({ length: 900 }, (_, index) => `line ${index}: ${'é'.repeat(index % 7)}\t{"k": "v"}`).join('\n')
    const host = await signedIn({
      pesto_artifact_get: { text: JSON.stringify({ content, note: 'truncated: showing the first bytes.' }) },
    })

    const pages: string[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const { text, isError } = await call(host, 'betty_evidence', { artifactId: 'big', offset })
      expect(isError).toBe(false)
      expect(text.length).toBeLessThan(4000)
      expect(text).toContain('PESTO note: truncated: showing the first bytes.')
      const lines = text.split('\n')
      pages.push(lines.slice(1, -1).join('\n'))
      const next = lines.at(-1)!.match(/offset (\d+)\.$/)
      offset = next ? Number(next[1]) : null
    }

    expect(pages.length).toBeGreaterThan(3)
    expect(pages.join('')).toBe(content)
  })
})

async function start(tools: Tools = {}, metadata: Record<string, unknown> = { runId: RUN }) {
  vi.useFakeTimers()
  const betty = createFakeBetty()
  const pesto = createFakePesto({ tools: { ...fixtureTools, ...tools } })
  const fetch: typeof globalThis.fetch = (input, init) =>
    new URL(String(input)).pathname === '/mcp' ? pesto.fetch(input, init) : betty.fetch(input, init)
  const host = createFakePluginHost({
    pluginId: 'betty',
    settings: { baseUrl: betty.base },
    sdk: { threads: { getPluginMetadata: async () => metadata }, plugins: { reload: async () => ({ ok: true }) } },
  })
  await createPlugin({ fetch })(host.bb)
  const signIn = async () => {
    const { url } = (await host.harness.behavior.callRpc('startSignIn', null)) as { url: string }
    await host.harness.behavior.fetchHttp('GET', `/oauth/callback?${new URLSearchParams(betty.approve(url))}`)
    await vi.advanceTimersByTimeAsync(0)
  }
  const reload = () => host.harness.lifecycle.reload(createPlugin({ fetch }))
  return { host, signIn, reload }
}

async function signedIn(tools: Tools = {}, metadata?: Record<string, unknown>) {
  const { signIn, reload } = await start(tools, metadata)
  await signIn()
  return reload()
}

async function call(host: FakePluginHost, tool: string, input: Record<string, unknown> = {}) {
  const result = await host.harness.behavior.callAgentTool(tool, input, { threadId: THREAD })
  if (typeof result === 'string') return { text: result, isError: false }
  return { text: result.content.map((part) => ('text' in part ? part.text : '')).join(''), isError: result.isError === true }
}

const runJson = (nodes: object[]) => JSON.stringify({ run_id: 'huge', total_cost_usd: 99, nodes })
