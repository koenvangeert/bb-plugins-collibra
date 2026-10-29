import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeBetty } from './fakeBetty'
import { createBettyAuth } from './session'
import { createAuthStore, MIGRATIONS } from './store'

const REDIRECT = 'http://127.0.0.1:1111/api/v1/plugins/betty/http/oauth/callback'

function setup(options: { expiresIn?: number } = {}) {
  const db = new DatabaseSync(':memory:')
  for (const statement of MIGRATIONS) db.exec(statement)
  const betty = createFakeBetty(options)
  const store = createAuthStore(db)
  const transitions: string[] = []
  const open = (baseUrl = betty.base) => {
    const auth = createBettyAuth({
      store,
      fetch: betty.fetch,
      baseUrl,
      onTransition: () => transitions.push(auth.state().kind),
      log: () => {},
    })
    return auth
  }
  return { betty, transitions, open }
}

async function signIn(auth: ReturnType<ReturnType<typeof setup>['open']>, betty: ReturnType<typeof createFakeBetty>, redirectUri = REDIRECT) {
  await auth.finishSignIn(betty.approve(await auth.startSignIn(redirectUri)) as { code: string; state: string; iss: string })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createBettyAuth', () => {
  it('returns the access token after sign-in', async () => {
    const { betty, transitions, open } = setup()
    const auth = open()

    await signIn(auth, betty)

    expect(transitions).toEqual(['signed-in'])
    expect(await auth.token()).toBe('secret-access-1')
  })

  it('refreshes once when the token is about to expire', async () => {
    const { betty, open } = setup({ expiresIn: 120 })
    const auth = open()
    await signIn(auth, betty)
    vi.setSystemTime(Date.now() + 61_000)

    const tokens = await Promise.all([auth.token(), auth.token()])

    expect(tokens).toEqual(['secret-access-2', 'secret-access-2'])
    expect(betty.tokenRequests.filter((form) => form.get('grant_type') === 'refresh_token')).toHaveLength(1)
  })

  it('refreshes ahead of expiry on a timer', async () => {
    const { betty, transitions, open } = setup({ expiresIn: 120 })
    const auth = open()
    await signIn(auth, betty)

    await vi.advanceTimersByTimeAsync(60_000)
    const requests = betty.tokenRequests.length

    expect(await auth.token()).toBe('secret-access-2')
    expect(betty.tokenRequests).toHaveLength(requests)
    expect(transitions).toEqual(['signed-in'])
  })

  it('sends the refresh token BETTY gave last time', async () => {
    const { betty, open } = setup({ expiresIn: 120 })
    const auth = open()
    await signIn(auth, betty)

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(betty.tokenRequests.slice(1).map((form) => form.get('refresh_token'))).toEqual(['secret-refresh-1', 'secret-refresh-2'])
    expect(await auth.token()).toBe('secret-access-3')
  })

  it('expires the sign-in when BETTY refuses the refresh token', async () => {
    const { betty, transitions, open } = setup({ expiresIn: 120 })
    const auth = open()
    await signIn(auth, betty)
    betty.behavior.token = 'reject-refresh'

    await vi.advanceTimersByTimeAsync(60_000)

    expect(transitions).toEqual(['signed-in', 'expired'])
    await expect(auth.token()).rejects.toThrow('Sign in to BETTY again')
  })

  it('keeps the old token while it is valid and BETTY cannot refresh', async () => {
    const { betty, transitions, open } = setup({ expiresIn: 120 })
    const auth = open()
    await signIn(auth, betty)
    betty.behavior.token = 'down'

    await vi.advanceTimersByTimeAsync(60_000)

    expect(await auth.token()).toBe('secret-access-1')
    vi.setSystemTime(Date.now() + 60_000)
    const error = (await auth.token().catch((cause: unknown) => cause)) as Error
    expect(error.message).toMatch(/^Could not refresh the BETTY sign-in/)
    expect(error.message).not.toContain('secret')
    expect(transitions).toEqual(['signed-in'])
  })

  it('treats a sign-in for another BETTY address as signed out', async () => {
    const { betty, open } = setup()
    await signIn(open(), betty)

    expect(open('https://other.test').state()).toEqual({ kind: 'signed-out' })
    await expect(open('https://other.test').token()).rejects.toThrow('Sign in to BETTY')
  })

  it('signs in again after BETTY forgets the registered client', async () => {
    const { betty, open } = setup()
    await signIn(open(), betty)

    betty.forgetClients()
    await signIn(open(), betty)

    expect(open().state()).toMatchObject({ kind: 'signed-in', clientId: 'client-2' })
  })

  it('refuses a sign-in answer older than ten minutes', async () => {
    const { betty, open } = setup()
    const auth = open()
    const answer = betty.approve(await auth.startSignIn(REDIRECT)) as { code: string; state: string; iss: string }

    vi.setSystemTime(Date.now() + 10 * 60_000)

    await expect(auth.finishSignIn(answer)).rejects.toThrow('unknown or too old')
    expect(auth.state()).toEqual({ kind: 'signed-out' })
  })
})
