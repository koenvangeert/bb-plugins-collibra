import { createHash } from 'node:crypto'

type Grant = { clientId: string; redirectUri: string; challenge: string; resource: string }

export function createFakeBetty(options: { expiresIn?: number } = {}) {
  const base = 'https://betty.test'
  const resource = `${base}/mcp`
  const registrations: { clientId: string; redirectUris: string[] }[] = []
  const codes = new Map<string, Grant>()
  const refreshTokens = new Map<string, string>()
  const issued: string[] = []
  const tokenRequests: URLSearchParams[] = []
  const behavior = { token: 'ok' as 'ok' | 'down' | 'reject-refresh', expiresIn: options.expiresIn ?? 3600 }
  let counter = 0
  let clients = 0

  function issue(clientId: string) {
    counter += 1
    const access = `secret-access-${counter}`
    const refresh = `secret-refresh-${counter}`
    issued.push(access, refresh)
    refreshTokens.set(refresh, clientId)
    return json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: behavior.expiresIn })
  }

  function token(form: URLSearchParams) {
    tokenRequests.push(form)
    if (behavior.token === 'down') return new Response('unavailable', { status: 503 })
    if (form.get('resource') !== resource) return json({ error: 'invalid_target' }, 400)
    const clientId = form.get('client_id') ?? ''
    if (form.get('grant_type') === 'authorization_code') {
      const grant = codes.get(form.get('code') ?? '')
      codes.delete(form.get('code') ?? '')
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (!grant || grant.clientId !== clientId || grant.redirectUri !== form.get('redirect_uri') || grant.challenge !== challenge) {
        return json({ error: 'invalid_grant' }, 400)
      }
      return issue(clientId)
    }
    if (form.get('grant_type') === 'refresh_token') {
      const refresh = form.get('refresh_token') ?? ''
      if (behavior.token === 'reject-refresh' || refreshTokens.get(refresh) !== clientId) return json({ error: 'invalid_grant' }, 400)
      refreshTokens.delete(refresh)
      return issue(clientId)
    }
    return json({ error: 'unsupported_grant_type' }, 400)
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve()
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const route = `${method} ${url.pathname}`
    if (route === 'GET /.well-known/oauth-protected-resource') {
      return json({ resource, authorization_servers: [base], scopes_supported: ['pesto:mcp', 'pesto:tasks:read', 'pesto:tasks:write'] })
    }
    if (route === 'GET /.well-known/oauth-authorization-server') {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        token_endpoint_auth_methods_supported: ['none'],
      })
    }
    if (route === 'POST /oauth/register') {
      const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] }
      const clientId = `client-${++clients}`
      registrations.push({ clientId, redirectUris: body.redirect_uris })
      return json({ client_id: clientId, redirect_uris: body.redirect_uris }, 201)
    }
    if (route === 'POST /oauth/token') return token(new URLSearchParams(String(init?.body)))
    return new Response('not found', { status: 404 })
  }

  return {
    base,
    fetch,
    behavior,
    registrations,
    issued,
    tokenRequests,
    approve(authorizeUrl: string): Record<string, string> {
      const url = new URL(authorizeUrl)
      const param = (name: string) => url.searchParams.get(name) ?? ''
      const registration = registrations.find((entry) => entry.clientId === param('client_id'))
      if (url.origin + url.pathname !== `${base}/oauth/authorize`) throw new Error(`unexpected authorize URL ${authorizeUrl}`)
      if (!registration?.redirectUris.includes(param('redirect_uri'))) throw new Error('unregistered redirect URI')
      if (param('response_type') !== 'code' || param('code_challenge_method') !== 'S256' || param('resource') !== resource) {
        throw new Error(`bad authorize request ${authorizeUrl}`)
      }
      const code = `code-${codes.size + 1}-${param('state')}`
      codes.set(code, { clientId: param('client_id'), redirectUri: param('redirect_uri'), challenge: param('code_challenge'), resource })
      return { code, state: param('state'), iss: base }
    },
    forgetClients: () => {
      registrations.length = 0
    },
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
