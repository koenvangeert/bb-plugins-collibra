import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Tokens } from './state'

export class SignInRejected extends Error {
  override name = 'SignInRejected'
}

export type AuthServer = {
  resource: string
  issuer: string
  requiresIss: boolean
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
}

const SCOPE = 'pesto:mcp pesto:tasks:read pesto:tasks:write'

const httpsUrl = z.url({ protocol: /^https$/ })

const protectedResource = z.object({ resource: z.string().min(1), authorization_servers: z.array(httpsUrl).min(1) })

const authorizationServer = z.object({
  issuer: z.string(),
  authorization_endpoint: httpsUrl,
  token_endpoint: httpsUrl,
  registration_endpoint: httpsUrl,
  code_challenge_methods_supported: z.array(z.string()).refine((methods) => methods.includes('S256')),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
})

const registration = z.object({ client_id: z.string().min(1) })

const tokenAnswer = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
})

const tokenError = z.object({ error: z.string(), error_description: z.string().optional() })

const DEFAULT_LIFETIME_SECONDS = 3600

export async function discover(fetchFn: typeof fetch, baseUrl: string): Promise<AuthServer> {
  const prm = await getJson(fetchFn, new URL('/.well-known/oauth-protected-resource', baseUrl), protectedResource, 'protected resource')
  const issuer = prm.authorization_servers[0]!
  const as = await getJson(fetchFn, wellKnown(issuer), authorizationServer, 'authorization server')
  if (as.issuer !== issuer) throw new Error(`BETTY names issuer ${as.issuer}, expected ${issuer}`)
  return {
    resource: prm.resource,
    issuer,
    requiresIss: as.authorization_response_iss_parameter_supported === true,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
  }
}

export async function register(fetchFn: typeof fetch, server: AuthServer, redirectUri: string): Promise<string> {
  const response = await send(fetchFn, server.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'bb BETTY plugin',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  if (!response.ok) throw new Error(`BETTY refused to register the plugin (HTTP ${response.status})`)
  return (await parse(response, registration, 'registration')).client_id
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function newState(): string {
  return randomBytes(16).toString('base64url')
}

export function authorizeUrl(server: AuthServer, request: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(server.authorizationEndpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
    state: request.state,
    scope: SCOPE,
    resource: server.resource,
  }).toString()
  return url.toString()
}

export function exchangeCode(
  fetchFn: typeof fetch,
  server: AuthServer,
  grant: { clientId: string; code: string; redirectUri: string; verifier: string },
  now: number,
): Promise<Tokens> {
  return requestTokens(fetchFn, server, now, null, {
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: grant.redirectUri,
    client_id: grant.clientId,
    code_verifier: grant.verifier,
  })
}

export function refresh(fetchFn: typeof fetch, server: AuthServer, grant: { clientId: string; refreshToken: string }, now: number): Promise<Tokens> {
  return requestTokens(fetchFn, server, now, grant.refreshToken, {
    grant_type: 'refresh_token',
    refresh_token: grant.refreshToken,
    client_id: grant.clientId,
  })
}

async function requestTokens(
  fetchFn: typeof fetch,
  server: AuthServer,
  now: number,
  previousRefreshToken: string | null,
  form: Record<string, string>,
): Promise<Tokens> {
  const response = await send(fetchFn, server.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ ...form, resource: server.resource }).toString(),
  })
  if (response.status === 400 || response.status === 401) {
    const reason = tokenError.safeParse(await response.json().catch(() => null))
    throw new SignInRejected(`BETTY refused the sign-in${reason.success ? ` (${reason.data.error})` : ''}`)
  }
  if (!response.ok) throw new Error(`BETTY could not issue a token (HTTP ${response.status})`)
  const answer = await parse(response, tokenAnswer, 'token')
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? previousRefreshToken,
    expiresAt: now + (answer.expires_in ?? DEFAULT_LIFETIME_SECONDS) * 1000,
  }
}

async function getJson<T>(fetchFn: typeof fetch, url: URL, schema: z.ZodType<T>, what: string): Promise<T> {
  const response = await send(fetchFn, url.toString(), { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`BETTY ${what} metadata answered HTTP ${response.status}`)
  return parse(response, schema, `${what} metadata`)
}

async function send(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init)
  } catch (error) {
    throw new Error(`Could not reach BETTY at ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function parse<T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  const result = schema.safeParse(await response.json().catch(() => undefined))
  if (!result.success) throw new Error(`BETTY sent an unreadable ${what} answer`)
  return result.data
}

function wellKnown(issuer: string): URL {
  const url = new URL(issuer)
  const path = url.pathname === '/' ? '' : url.pathname
  return new URL(`/.well-known/oauth-authorization-server${path}`, url.origin)
}
