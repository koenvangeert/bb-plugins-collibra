import { createFakePluginHost, type FakePluginHost } from '@get-bb/plugin-sdk/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlugin } from '../server'
import { createFakeBetty } from './auth/fakeBetty'
import { createFakePesto, fixture } from './pesto/fakePesto'
import type { RunDetail } from './pesto/types'

type Betty = ReturnType<typeof createFakeBetty>

async function start(betty: Betty, fetch = betty.fetch) {
  const host = createFakePluginHost({
    pluginId: 'betty',
    settings: { baseUrl: betty.base },
    sdk: { plugins: { reload: async () => ({ ok: true }) } },
  })
  await createPlugin({ fetch })(host.bb)
  return host
}

const reloadRequests = ({ harness }: FakePluginHost) => harness.inspection.sdk.callsTo('plugins.reload').length

const reload = (host: FakePluginHost, betty: Betty, fetch = betty.fetch) => host.harness.lifecycle.reload(createPlugin({ fetch }))

const authStatus = ({ harness }: FakePluginHost) => harness.behavior.callRpc('authStatus', null)

async function signIn(host: FakePluginHost, betty: Betty, answer: (params: Record<string, string>) => Record<string, string> = (p) => p) {
  const { url } = (await host.harness.behavior.callRpc('startSignIn', null)) as { url: string }
  const response = await host.harness.behavior.fetchHttp('GET', `/oauth/callback?${new URLSearchParams(answer(betty.approve(url)))}`)
  return { url, status: response.status, html: await response.text() }
}

async function signedIn(betty: Betty, fetch = betty.fetch) {
  const host = await start(betty, fetch)
  await signIn(host, betty)
  await vi.advanceTimersByTimeAsync(0)
  return reload(host, betty, fetch)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BETTY sign-in', () => {
  it('asks to sign in on first start', async () => {
    const host = await start(createFakeBetty())

    expect(host.harness.needsConfigurationMessages).toEqual(['Sign in to BETTY'])
    expect(await authStatus(host)).toEqual({ state: 'signed-out' })
  })

  it('sends the user to BETTY with PKCE, the MCP resource and a loopback callback', async () => {
    const betty = createFakeBetty()
    const host = await start(betty)

    const { url } = (await host.harness.behavior.callRpc('startSignIn', null)) as { url: string }

    const params = new URL(url).searchParams
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:38886/api/v1/plugins/betty/http/oauth/callback')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('resource')).toBe('https://betty.test/mcp')
    expect(params.get('scope')).toBe('pesto:mcp pesto:tasks:read pesto:tasks:write')
    expect(betty.registrations).toEqual([{ clientId: 'client-1', redirectUris: [params.get('redirect_uri')] }])
  })

  it('signs in through the callback and runs after the reload', async () => {
    vi.useFakeTimers()
    const betty = createFakeBetty()
    const host = await start(betty)

    const { status, html } = await signIn(host, betty)
    await vi.advanceTimersByTimeAsync(0)

    expect(status).toBe(200)
    expect(html).toContain('Signed in to BETTY. You can close this tab.')
    expect(await authStatus(host)).toEqual({ state: 'signed-in' })
    expect(reloadRequests(host)).toBe(1)
    const next = await reload(host, betty)
    expect(next.harness.needsConfigurationMessages).toEqual([])
  })

  it.each([
    ['an unknown state', (params: Record<string, string>) => ({ ...params, state: 'forged' })],
    ['another issuer', (params: Record<string, string>) => ({ ...params, iss: 'https://evil.test' })],
    ['no issuer', ({ iss: _iss, ...params }: Record<string, string>) => params],
  ])('refuses a callback with %s', async (_name, answer) => {
    vi.useFakeTimers()
    const betty = createFakeBetty()
    const host = await start(betty)

    const { status } = await signIn(host, betty, answer)
    await vi.advanceTimersByTimeAsync(0)

    expect(status).toBe(400)
    expect(await authStatus(host)).toEqual({ state: 'signed-out' })
    expect(reloadRequests(host)).toBe(0)
  })

  it('shows the BETTY error when the user does not approve', async () => {
    const host = await start(createFakeBetty())

    const response = await host.harness.behavior.fetchHttp('GET', '/oauth/callback?error=access_denied&error_description=%3Cb%3Eno%3C%2Fb%3E')

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('BETTY did not sign you in: &#60;b&#62;no&#60;/b&#62;')
  })

  it('asks to sign in again after BETTY refuses the refresh', async () => {
    vi.useFakeTimers()
    const betty = createFakeBetty({ expiresIn: 3600 })
    const host = await signedIn(betty)
    betty.behavior.token = 'reject-refresh'

    await vi.advanceTimersByTimeAsync(3600_000)

    expect(await authStatus(host)).toEqual({ state: 'expired' })
    expect(reloadRequests(host)).toBe(1)
    const next = await reload(host, betty)
    expect(next.harness.needsConfigurationMessages).toEqual(['Sign in to BETTY again'])
  })

  it('stays signed in when a refresh fails for a moment', async () => {
    vi.useFakeTimers()
    const betty = createFakeBetty({ expiresIn: 3600 })
    const host = await signedIn(betty)
    betty.behavior.token = 'down'

    await vi.advanceTimersByTimeAsync(3540_000)
    betty.behavior.token = 'ok'
    await vi.advanceTimersByTimeAsync(30_000)

    expect(await authStatus(host)).toEqual({ state: 'signed-in' })
    expect(betty.tokenRequests.map((form) => form.get('grant_type'))).toEqual(['authorization_code', 'refresh_token', 'refresh_token'])
    expect(reloadRequests(host)).toBe(0)
  })

  it('never puts a token in rpc output, the callback page or the log', async () => {
    vi.useFakeTimers()
    const betty = createFakeBetty({ expiresIn: 3600 })
    const host = await start(betty)
    const seen: unknown[] = [await authStatus(host)]

    seen.push((await signIn(host, betty)).html)
    seen.push(await authStatus(host))
    await vi.advanceTimersByTimeAsync(3540_000)
    betty.behavior.token = 'down'
    await vi.advanceTimersByTimeAsync(3540_000)
    betty.behavior.token = 'reject-refresh'
    await vi.advanceTimersByTimeAsync(30_000)
    seen.push(await authStatus(host), host.harness.logEntries, host.harness.realtimeSignals)

    expect(betty.issued.length).toBeGreaterThan(0)
    const visible = JSON.stringify(seen)
    for (const token of betty.issued) expect(visible).not.toContain(token)
    expect(host.harness.logEntries.length).toBeGreaterThan(0)
  })
})

type Tools = NonNullable<Parameters<typeof createFakePesto>[0]['tools']>

function bettyWithPesto(whoami: () => { text: string } = () => ({ text: fixture('whoami.json') }), tools: Tools = {}) {
  const betty = createFakeBetty()
  const pesto = createFakePesto({
    tools: {
      pesto_whoami: whoami,
      pesto_dag_status: (args: Record<string, unknown>) => ({ text: fixture(args.run_id ? 'dag-status.json' : 'run-list.json') }),
      ...tools,
    },
  })
  const fetch: typeof globalThis.fetch = (input, init) =>
    new URL(String(input)).pathname === '/mcp' ? pesto.fetch(input, init) : betty.fetch(input, init)
  return { betty, pesto, fetch }
}

describe('my runs', () => {

  it('lists the runs of the signed-in user', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-02T12:00:00Z') })
    const { betty, pesto, fetch } = bettyWithPesto(() => ({ text: fixture('whoami.json') }))
    const host = await signedIn(betty, fetch)

    const result = (await host.harness.behavior.callRpc('myRuns', null)) as { runs: { runId: string }[]; cutOff: boolean }

    expect(result.runs.map((run) => run.runId)).toEqual(['fft-61-dev-230276-guard-to-categories', 'dev-229618-guardian-kpi-real-data'])
    expect(result.cutOff).toBe(true)
    const owners = pesto
      .toolCalls()
      .filter((call) => call.body!.params!.name === 'pesto_dag_status')
      .map((call) => call.body!.params!.arguments!.owner_dev)
    expect(owners).toEqual(['koen.vangeert@collibra.com', 'koen.vangeert@collibra.com'])
  })

  it('says why it cannot find runs when BETTY sends no email, and asks again next time', async () => {
    vi.useFakeTimers()
    let identity: object = { auth_mode: 'api_key' }
    const { betty, fetch } = bettyWithPesto(() => ({ text: JSON.stringify(identity) }))
    const host = await signedIn(betty, fetch)

    await expect(host.harness.behavior.callRpc('myRuns', null)).rejects.toThrow(
      'BETTY did not tell bb your email, so bb cannot find your runs.',
    )

    identity = JSON.parse(fixture('whoami.json'))
    await expect(host.harness.behavior.callRpc('myRuns', null)).resolves.toMatchObject({ cutOff: true })
  })
})

describe('run detail', () => {
  it('reads one run with its steps and pull request', async () => {
    vi.useFakeTimers()
    const { betty, pesto, fetch } = bettyWithPesto()
    const host = await signedIn(betty, fetch)

    const detail = (await host.harness.behavior.callRpc('runDetail', { runId: 'central-frontend-team-browser-validated-f153a0' })) as RunDetail

    expect(pesto.toolCalls().at(-1)!.body!.params).toEqual({
      name: 'pesto_dag_status',
      arguments: { run_id: 'central-frontend-team-browser-validated-f153a0' },
    })
    expect(detail.runId).toBe('central-frontend-team-browser-validated-f153a0')
    expect(detail.nodes).toHaveLength(15)
    expect(detail.nodes.find((node) => node.name === 'remediate-review')).toMatchObject({ costUsd: 0.5587, budgetUsd: 12 })
    expect(detail.pullRequests.map((pr) => [pr.number, pr.base])).toEqual([[26731, 'main']])
  })

  it('refuses an empty run id', async () => {
    vi.useFakeTimers()
    const { betty, pesto, fetch } = bettyWithPesto()
    const host = await signedIn(betty, fetch)

    await expect(host.harness.behavior.callRpc('runDetail', { runId: '' })).rejects.toThrow()
    expect(pesto.toolCalls().filter((call) => call.body!.params!.name === 'pesto_dag_status')).toEqual([])
  })
})

const RUNNING_RUN = JSON.stringify({
  run_id: 'run-1',
  total_cost_usd: 2.5,
  nodes: [
    { task_id: 't-implement', name: 'implement', executor: 'agent', status: 'running', budget: '$1.00/$15.00' },
    { task_id: 't-review', name: 'review', executor: 'agent', status: 'pending', depends_on: ['implement'] },
    { task_id: 't-watch-ci', name: 'watch-ci', executor: 'agent', status: 'suspended', budget: '$4.27/$6.00' },
    { task_id: 't-teardown', name: 'teardown-env', executor: 'script', status: 'pending', depends_on: ['review'], always_run: true },
  ],
})

async function actingHost(tools: Tools) {
  vi.useFakeTimers()
  const { betty, pesto, fetch } = bettyWithPesto(undefined, { pesto_dag_status: { text: RUNNING_RUN }, ...tools })
  const host = await signedIn(betty, fetch)
  const sent = (name: string) => pesto.toolCalls().filter((call) => call.body!.params!.name === name).map((call) => call.body!.params!.arguments)
  return { host, pesto, sent }
}

describe('decisions', () => {
  it('approves a step with the new budget and hint', async () => {
    const { host, sent } = await actingHost({ pesto_task_approve: { text: 'approved' } })

    const result = await host.harness.behavior.callRpc('approveStep', { taskId: 't-watch-ci', budgetUsd: 12, hint: 'Skip the flaky test.' })

    expect(result).toBeNull()
    expect(sent('pesto_task_approve')).toEqual([{ task_id: 't-watch-ci', cost_budget_usd: 12, hint: 'Skip the flaky test.' }])
  })

  it.each(['', '  '])('approves without a hint when the hint is %j', async (hint) => {
    const { host, sent } = await actingHost({ pesto_task_approve: { text: 'approved' } })

    await host.harness.behavior.callRpc('approveStep', { taskId: 't-watch-ci', budgetUsd: 12, hint })

    expect(sent('pesto_task_approve')).toEqual([{ task_id: 't-watch-ci', cost_budget_usd: 12 }])
  })

  it('reads the runs again after each decision', async () => {
    const { host } = await actingHost({ pesto_task_approve: { text: 'approved' }, pesto_task_deny: { text: 'denied' }, pesto_task_stop: { text: 'stopped' } })
    const before = host.harness.inspection.experimental_rpcInvalidations.length

    await host.harness.behavior.callRpc('approveStep', { taskId: 't-watch-ci', budgetUsd: 12 })
    await host.harness.behavior.callRpc('denyStep', { taskId: 't-watch-ci', reason: 'No.' })
    await host.harness.behavior.callRpc('stopRun', { runId: 'run-1' })

    expect(host.harness.inspection.experimental_rpcInvalidations.length - before).toBe(3)
  })

  it('denies a step with the reason', async () => {
    const { host, sent } = await actingHost({ pesto_task_deny: { text: 'denied' } })

    await host.harness.behavior.callRpc('denyStep', { taskId: 't-watch-ci', reason: '  Wrong approach.  ' })

    expect(sent('pesto_task_deny')).toEqual([{ task_id: 't-watch-ci', reason: 'Wrong approach.' }])
  })

  it('refuses a deny without a reason and sends nothing', async () => {
    const { host, pesto } = await actingHost({ pesto_task_deny: { text: 'denied' } })

    await expect(host.harness.behavior.callRpc('denyStep', { taskId: 't-watch-ci', reason: '   ' })).rejects.toThrow()
    expect(pesto.toolCalls()).toEqual([])
  })

  it('refuses an approval without a positive budget and sends nothing', async () => {
    const { host, pesto } = await actingHost({ pesto_task_approve: { text: 'approved' } })

    await expect(host.harness.behavior.callRpc('approveStep', { taskId: 't-watch-ci', budgetUsd: 0 })).rejects.toThrow()
    expect(pesto.toolCalls()).toEqual([])
  })

  it('stops a run by stopping the live steps and denying the suspended ones, and leaves the rest to PESTO', async () => {
    const { host, sent } = await actingHost({ pesto_task_stop: { text: 'stopped' }, pesto_task_deny: { text: 'denied' } })

    const result = await host.harness.behavior.callRpc('stopRun', { runId: 'run-1' })

    expect(sent('pesto_dag_status')).toEqual([{ run_id: 'run-1' }])
    expect(sent('pesto_task_stop')).toEqual([{ task_id: 't-implement', reason: 'Stopped from bb.' }])
    expect(sent('pesto_task_deny')).toEqual([{ task_id: 't-watch-ci', reason: 'Stopped from bb.' }])
    expect(result).toEqual({ failed: [] })
  })

  it('reports a step that PESTO refuses to stop and still stops the others', async () => {
    const { host } = await actingHost({
      pesto_task_stop: { text: 'task t-implement already finished', isError: true },
      pesto_task_deny: { text: 'denied' },
    })

    const result = await host.harness.behavior.callRpc('stopRun', { runId: 'run-1' })

    expect(result).toEqual({ failed: [{ step: 'implement', error: 'task t-implement already finished' }] })
  })
})

const VALIDATE_APP = '65bee160-b71b-4d19-a614-8ff73e1cc3b3'

describe('evidence and artifacts', () => {
  const artifactGet = (args: Record<string, unknown>) => {
    if (args.artifact_id) {
      const cut = args.artifact_id === 'short' ? { content: 'done' } : { content: 'x'.repeat(98_304), note: 'truncated: showing the first 98304 bytes of a gzipped artifact (1531592 bytes compressed).' }
      return { text: JSON.stringify({ artifact_id: args.artifact_id, kind: 'transcript', content_type: 'text/plain', size_bytes: 1531592, ...cut }) }
    }
    if (args.task_id === VALIDATE_APP) return { text: fixture('artifact-result.json') }
    return { text: `task ${String(args.task_id)} has no "result" artifact on any attempt; pesto_task_logs lists what it did produce`, isError: true }
  }

  async function evidenceHost() {
    vi.useFakeTimers()
    const { betty, pesto, fetch } = bettyWithPesto(undefined, {
      pesto_artifact_get: artifactGet,
      pesto_task_show: { text: fixture('task-show-validate.json') },
      pesto_task_logs: { text: fixture('task-logs.json') },
    })
    const host = await signedIn(betty, fetch)
    const sent = (name: string) => pesto.toolCalls().filter((call) => call.body!.params!.name === name).map((call) => call.body!.params!.arguments)
    return { host, sent }
  }

  it('reads the AC evidence of a run once per finished step', async () => {
    const { host, sent } = await evidenceHost()

    const steps = (await host.harness.behavior.callRpc('runEvidence', { runId: 'central-frontend-team-browser-validated-f153a0' })) as {
      step: string
      criteria: { id: string; text: string | null; met: boolean }[]
    }[]
    const asked = sent('pesto_artifact_get').length
    await host.harness.behavior.callRpc('runEvidence', { runId: 'central-frontend-team-browser-validated-f153a0' })

    expect(steps.map((step) => step.step)).toEqual(['validate-app'])
    expect(steps[0]!.criteria.map(({ id, text, met }) => [id, text, met])).toEqual([
      ['AC-1', 'On an AI Agent asset with Guardian off, the tab bar has no Guardian tab', true],
      ['AC-2', 'With AI Agent contracts off, the asset has no Contract tab', true],
      ['AC-3', null, true],
    ])
    expect(sent('pesto_task_show')).toEqual([{ task_id: VALIDATE_APP }])
    expect(sent('pesto_artifact_get')).toHaveLength(asked)
  })

  it('lists the artifacts of a step', async () => {
    const { host, sent } = await evidenceHost()

    const artifacts = (await host.harness.behavior.callRpc('stepArtifacts', { taskId: 'ff3bc7e0-644a-47b0-895b-368497922af8' })) as { kind: string }[]

    expect(sent('pesto_task_logs')).toEqual([{ task_id: 'ff3bc7e0-644a-47b0-895b-368497922af8' }])
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(['post_review', 'result', 'transcript', 'usage_ledger'])
  })

  it('passes on the note PESTO sends when it cut an artifact', async () => {
    const { host, sent } = await evidenceHost()

    const artifact = (await host.harness.behavior.callRpc('artifact', { artifactId: 'f6cf7bf4' })) as { content: string; note: string | null }

    expect(sent('pesto_artifact_get')).toEqual([{ artifact_id: 'f6cf7bf4' }])
    expect(artifact.note).toBe('truncated: showing the first 98304 bytes of a gzipped artifact (1531592 bytes compressed).')
    expect(artifact.content).toHaveLength(98_304)
  })

  it('sends a short artifact whole', async () => {
    const { host } = await evidenceHost()

    expect(await host.harness.behavior.callRpc('artifact', { artifactId: 'short' })).toEqual({ content: 'done', note: null })
  })
})
