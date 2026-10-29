import type { BbPluginApi } from '@get-bb/plugin-sdk'
import { createMcpSession, PestoError } from './src/pesto/mcp'
import { mcpEndpoint, SETTINGS } from './src/settings'

const SIGN_IN = 'Sign in to BETTY'

export const createPlugin = (deps: { getToken: () => Promise<string>; fetch?: typeof fetch }) =>
  async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define(SETTINGS)
    const session = createMcpSession({
      endpoint: async () => mcpEndpoint((await settings.get()).baseUrl),
      getToken: deps.getToken,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    })
    bb.onDispose(() => session.close())
    bb.status.needsConfiguration(SIGN_IN)
  }

export default createPlugin({
  getToken: async () => {
    throw new PestoError(SIGN_IN)
  },
})
