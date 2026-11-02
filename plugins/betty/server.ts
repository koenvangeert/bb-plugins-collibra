import type { BbPluginApi } from '@get-bb/plugin-sdk'
import { createBettyAuth } from './src/auth/session'
import { SIGN_IN_PROMPT } from './src/auth/state'
import { createAuthStore, MIGRATIONS } from './src/auth/store'
import { createMcpSession } from './src/pesto/mcp'
import { rpcContract } from './src/rpc'
import { mcpEndpoint, SETTINGS } from './src/settings'

const CALLBACK_PATH = '/oauth/callback'

export const createPlugin = (deps: { fetch?: typeof fetch } = {}) =>
  async function plugin(bb: BbPluginApi) {
    const fetchFn = deps.fetch ?? fetch
    const settings = bb.settings.define(SETTINGS)
    const { baseUrl } = await settings.get()
    const db = bb.storage.database()
    bb.storage.migrate(db, MIGRATIONS)

    const reload = () => {
      setTimeout(() => {
        bb.sdk.plugins.reload({ pluginId: bb.pluginId }).catch((error: unknown) => bb.log.warn(`Could not reload BETTY: ${message(error)}`))
      }, 0)
    }

    const auth = createBettyAuth({
      store: createAuthStore(db),
      fetch: fetchFn,
      baseUrl,
      onTransition: () => {
        bb.rpc.experimental_invalidateAll()
        reload()
      },
      log: (line) => bb.log.warn(line),
    })
    bb.onDispose(() => auth.dispose())

    const session = createMcpSession({ endpoint: () => mcpEndpoint(baseUrl), getToken: auth.token, fetch: fetchFn })
    bb.onDispose(() => session.close())

    settings.onChange((next) => {
      if (next.baseUrl !== baseUrl) reload()
    })

    bb.rpc.register(rpcContract, {
      authStatus: () => ({ state: auth.state().kind }),
      startSignIn: async () => ({
        url: await auth.startSignIn(`${bb.server.loopbackBaseUrl}/api/v1/plugins/${bb.pluginId}/http${CALLBACK_PATH}`),
      }),
    })

    bb.http.route(
      'GET',
      CALLBACK_PATH,
      async (c) => {
        const { code, state, iss, error, error_description } = c.req.query()
        try {
          if (error) throw new Error(`BETTY did not sign you in: ${error_description ?? error}`)
          if (!code || !state) throw new Error('The sign-in answer has no code or state.')
          await auth.finishSignIn({ code, state, iss })
          return c.html(page('Signed in to BETTY. You can close this tab.'))
        } catch (cause) {
          bb.log.warn(`BETTY sign-in failed: ${message(cause)}`)
          return c.html(page(message(cause)), 400)
        }
      },
      { auth: 'local' },
    )

    const prompt = SIGN_IN_PROMPT[auth.state().kind]
    if (prompt) bb.status.needsConfiguration(prompt)
  }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function page(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
  return `<!doctype html><meta charset="utf-8"><title>BETTY</title><p style="font-family: system-ui, sans-serif">${escaped}</p>`
}

export default createPlugin()
