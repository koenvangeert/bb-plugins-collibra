import type { BbPluginApi } from '@get-bb/plugin-sdk'
import { z } from 'zod'
import { createBettyAuth } from './src/auth/session'
import { SIGN_IN_PROMPT } from './src/auth/state'
import { createAuthStore, MIGRATIONS } from './src/auth/store'
import { registerAgentTools } from './src/agentTools'
import { createPestoClient } from './src/pesto/client'
import { createMcpSession, PestoError } from './src/pesto/mcp'
import { rpcContract } from './src/rpc'
import { stopRun } from './src/runs/decide'
import { createEvidenceLoader } from './src/runs/evidence'
import { loadMyRuns } from './src/runs/myRuns'
import { chipLabel } from './src/runChip'
import { createRunWatcher } from './src/runWatcher'
import { mcpEndpoint, SETTINGS } from './src/settings'
import { createThreadRuns, LINK_TOOL } from './src/threadRun'

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
    const pesto = createPestoClient(session)
    const evidence = createEvidenceLoader(pesto)

    let ownerEmail: Promise<string> | null = null
    const owner = () => {
      if (!ownerEmail) {
        ownerEmail = pesto.whoami().then(requireEmail)
        ownerEmail.catch(() => {
          ownerEmail = null
        })
      }
      return ownerEmail
    }

    const isSignedIn = () => auth.state().kind === 'signed-in'
    const watcher = createRunWatcher({
      db,
      pesto,
      sdk: bb.sdk.threads,
      isSignedIn,
      log: (line) => bb.log.warn(line),
    })
    bb.background.service('run-watcher', { start: (signal) => watcher.run(signal) })
    const runs = createThreadRuns({ sdk: bb.sdk, pesto, watch: watcher.watch })

    bb.agents.registerTool({
      name: LINK_TOOL,
      description: 'Link a submitted BETTY (PESTO) run to this thread. The thread header then shows the run status, steps and spend.',
      parameters: z.object({ runId: z.string().trim().min(1).describe('The run_id that pesto_dag_submit returned.') }),
      presentation: { label: { pending: 'Linking BETTY run', completed: 'Linked BETTY run' }, icon: { glyph: 'Workflow' } },
      execute: async ({ runId }, ctx) => {
        try {
          const chip = await runs.link(ctx.threadId, runId)
          bb.rpc.experimental_invalidateAll()
          return `Linked BETTY run ${runId} to this thread. ${chipLabel(chip)}`
        } catch (error) {
          return { content: [{ type: 'text', text: `Could not link BETTY run ${runId}: ${message(error)}` }], isError: true }
        }
      },
    })
    const answerTools = registerAgentTools(bb.agents, { pesto, evidence, linkedRunId: runs.linkedRunId, isSignedIn })
    bb.agents.configure(() => ({ tools: [LINK_TOOL, ...answerTools], skills: ['betty'] }))

    settings.onChange((next) => {
      if (next.baseUrl !== baseUrl) reload()
    })

    bb.rpc.register(rpcContract, {
      authStatus: () => ({ state: auth.state().kind }),
      startSignIn: async () => ({
        url: await auth.startSignIn(`${bb.server.loopbackBaseUrl}/api/v1/plugins/${bb.pluginId}/http${CALLBACK_PATH}`),
      }),
      myRuns: async () => loadMyRuns(pesto, await owner(), Date.now()),
      threadRun: ({ threadId }) => runs.threadRun(threadId),
      startRun: async ({ threadId }) => {
        await runs.startRun(threadId)
        return null
      },
      runDetail: ({ runId }) => pesto.dagStatus(runId),
      approveStep: async (approval) => {
        await pesto.approve(approval)
        bb.rpc.experimental_invalidateAll()
        return null
      },
      denyStep: async (denial) => {
        await pesto.deny(denial)
        bb.rpc.experimental_invalidateAll()
        return null
      },
      stopRun: async ({ runId }) => {
        const result = await stopRun(pesto, runId)
        bb.rpc.experimental_invalidateAll()
        return result
      },
      runEvidence: async ({ runId }) => evidence.load((await pesto.dagStatus(runId)).nodes),
      stepArtifacts: ({ taskId }) => pesto.taskLogs(taskId),
      artifact: ({ artifactId }) => pesto.artifact(artifactId),
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

function requireEmail({ email }: { email: string | null }): string {
  if (!email) throw new PestoError('BETTY did not tell bb your email, so bb cannot find your runs.')
  return email
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function page(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
  return `<!doctype html><meta charset="utf-8"><title>BETTY</title><p style="font-family: system-ui, sans-serif">${escaped}</p>`
}

export default createPlugin()
