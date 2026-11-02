import { PestoError } from '../pesto/mcp'
import * as oauth from './oauth'
import { SIGN_IN_PROMPT, type AuthState, type Tokens } from './state'
import type { AuthStore } from './store'

type SignedIn = Extract<AuthState, { kind: 'signed-in' }>

type PendingSignIn = { verifier: string; clientId: string; redirectUri: string; server: oauth.AuthServer; expiresAt: number }

const PENDING_TTL_MS = 10 * 60_000
const REFRESH_MARGIN_MS = 60_000
const RETRY_MS = 30_000
const MAX_TIMER_MS = 2 ** 31 - 1

export type BettyAuth = ReturnType<typeof createBettyAuth>

export function createBettyAuth(options: {
  store: AuthStore
  fetch: typeof fetch
  baseUrl: string
  onTransition: () => void
  log: (message: string) => void
  now?: () => number
}) {
  const { store, baseUrl, log } = options
  const now = options.now ?? Date.now
  const pending = new Map<string, PendingSignIn>()
  let server: Promise<oauth.AuthServer> | null = null
  let refreshing: Promise<string> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  function state(): AuthState {
    const saved = store.state()
    return saved.kind === 'signed-out' || saved.baseUrl === baseUrl ? saved : { kind: 'signed-out' }
  }

  function authServer(): Promise<oauth.AuthServer> {
    if (server) return server
    const discovery = oauth.discover(options.fetch, baseUrl)
    discovery.catch(() => {
      if (server === discovery) server = null
    })
    server = discovery
    return discovery
  }

  function schedule(delay: number) {
    clearTimeout(timer)
    timer = setTimeout(() => void refreshNow().catch(() => {}), Math.min(Math.max(0, delay), MAX_TIMER_MS))
  }

  function scheduleRefresh(tokens: Tokens) {
    schedule(tokens.expiresAt - REFRESH_MARGIN_MS - now())
  }

  function transition(next: AuthState) {
    store.save(next)
    clearTimeout(timer)
    if (next.kind === 'signed-in') scheduleRefresh(next.tokens)
    options.onTransition()
  }

  async function refreshOnce(signedIn: SignedIn): Promise<string> {
    try {
      const refreshToken = signedIn.tokens.refreshToken
      if (!refreshToken) throw new oauth.SignInRejected('BETTY gave no refresh token')
      const tokens = await oauth.refresh(options.fetch, await authServer(), { clientId: signedIn.clientId, refreshToken }, now())
      store.save({ ...signedIn, tokens })
      scheduleRefresh(tokens)
      return tokens.accessToken
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof oauth.SignInRejected) {
        log(`BETTY sign-in ended: ${message}`)
        transition({ kind: 'expired', baseUrl })
        throw new PestoError(SIGN_IN_PROMPT.expired)
      }
      log(`Could not refresh the BETTY sign-in, trying again in ${RETRY_MS / 1000} seconds: ${message}`)
      schedule(RETRY_MS)
      throw new PestoError(`Could not refresh the BETTY sign-in: ${message}`)
    }
  }

  function refreshNow(): Promise<string> {
    const current = state()
    if (current.kind !== 'signed-in') return Promise.reject(new PestoError(SIGN_IN_PROMPT[current.kind]))
    refreshing ??= refreshOnce(current).finally(() => {
      refreshing = null
    })
    return refreshing
  }

  const initial = state()
  if (initial.kind === 'signed-in') scheduleRefresh(initial.tokens)

  return {
    state,

    async startSignIn(redirectUri: string): Promise<string> {
      const authorizationServer = await authServer()
      const clientId = await oauth.register(options.fetch, authorizationServer, redirectUri)
      for (const [key, request] of pending) if (request.expiresAt <= now()) pending.delete(key)
      const { verifier, challenge } = oauth.pkce()
      const key = oauth.newState()
      pending.set(key, { verifier, clientId, redirectUri, server: authorizationServer, expiresAt: now() + PENDING_TTL_MS })
      return oauth.authorizeUrl(authorizationServer, { clientId, redirectUri, challenge, state: key })
    },

    async finishSignIn(answer: { code: string; state: string; iss: string | undefined }) {
      const request = pending.get(answer.state)
      pending.delete(answer.state)
      if (!request || request.expiresAt <= now()) throw new oauth.SignInRejected('This sign-in is unknown or too old. Start it again from bb.')
      if ((answer.iss !== undefined || request.server.requiresIss) && answer.iss !== request.server.issuer) {
        throw new oauth.SignInRejected('The sign-in answer did not come from BETTY.')
      }
      const tokens = await oauth.exchangeCode(
        options.fetch,
        request.server,
        { clientId: request.clientId, code: answer.code, redirectUri: request.redirectUri, verifier: request.verifier },
        now(),
      )
      transition({ kind: 'signed-in', baseUrl, clientId: request.clientId, tokens })
    },

    async token(): Promise<string> {
      const current = state()
      if (current.kind !== 'signed-in') throw new PestoError(SIGN_IN_PROMPT[current.kind])
      if (now() < current.tokens.expiresAt - REFRESH_MARGIN_MS) return current.tokens.accessToken
      try {
        return await refreshNow()
      } catch (error) {
        if (state().kind === 'signed-in' && now() < current.tokens.expiresAt) return current.tokens.accessToken
        throw error
      }
    },

    dispose() {
      clearTimeout(timer)
      pending.clear()
    },
  }
}
