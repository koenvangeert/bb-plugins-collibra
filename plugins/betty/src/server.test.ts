import { createFakePluginHost, type FakePluginHost } from '@get-bb/plugin-sdk/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlugin } from '../server'
import { createFakeBetty } from './auth/fakeBetty'
import { createFakePesto, fixture } from './pesto/fakePesto'

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

describe('my runs', () => {
  function bettyWithPesto(whoami: () => { text: string }) {
    const betty = createFakeBetty()
    const pesto = createFakePesto({
      tools: { pesto_whoami: whoami, pesto_dag_status: { text: fixture('run-list.json') } },
    })
    const fetch: typeof globalThis.fetch = (input, init) =>
      new URL(String(input)).pathname === '/mcp' ? pesto.fetch(input, init) : betty.fetch(input, init)
    return { betty, pesto, fetch }
  }

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
