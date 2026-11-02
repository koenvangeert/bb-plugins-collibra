import { createFakePluginHost, type FakePluginHost } from '@get-bb/plugin-sdk/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlugin } from '../server'
import { createFakeBetty } from './auth/fakeBetty'

type Betty = ReturnType<typeof createFakeBetty>

async function start(betty: Betty) {
  const host = createFakePluginHost({
    pluginId: 'betty',
    settings: { baseUrl: betty.base },
    sdk: { plugins: { reload: async () => ({ ok: true }) } },
  })
  await createPlugin({ fetch: betty.fetch })(host.bb)
  return host
}

const reloadRequests = ({ harness }: FakePluginHost) => harness.inspection.sdk.callsTo('plugins.reload').length

const reload = (host: FakePluginHost, betty: Betty) => host.harness.lifecycle.reload(createPlugin({ fetch: betty.fetch }))

const authStatus = ({ harness }: FakePluginHost) => harness.behavior.callRpc('authStatus', null)

async function signIn(host: FakePluginHost, betty: Betty, answer: (params: Record<string, string>) => Record<string, string> = (p) => p) {
  const { url } = (await host.harness.behavior.callRpc('startSignIn', null)) as { url: string }
  const response = await host.harness.behavior.fetchHttp('GET', `/oauth/callback?${new URLSearchParams(answer(betty.approve(url)))}`)
  return { url, status: response.status, html: await response.text() }
}

async function signedIn(betty: Betty) {
  const host = await start(betty)
  await signIn(host, betty)
  await vi.advanceTimersByTimeAsync(0)
  return reload(host, betty)
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
