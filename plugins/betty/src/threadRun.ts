import type { PestoClient } from './pesto/client'
import { runChip, type RunChip, type ThreadRun } from './runChip'

export const LINK_TOOL = 'betty_link_run'

export interface ThreadRunSdk {
  threads: {
    getPluginMetadata(args: { threadId: string; pluginId?: string }): Promise<Record<string, unknown>>
    updatePluginMetadata(args: { threadId: string; set: { runId: string } }): Promise<unknown>
    send(args: {
      threadId: string
      input: [{ type: 'text'; text: string; mentions: [] }]
      mode: 'queue-if-active'
    }): Promise<unknown>
  }
}

const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/

export function startRunPrompt(ticketKey: string | null): string {
  const target = ticketKey ? `Jira ticket ${ticketKey}` : 'the work in this thread'
  return [
    `Start a BETTY run for ${target} with the pesto MCP tools.`,
    'Follow the pesto flow: get the workflow template, show me the DAG and what each node costs, and submit only after I agree.',
    `After pesto_dag_submit returns, call the ${LINK_TOOL} tool with the run id so this thread links to the run.`,
    'Stay in this thread. Do not start a new thread.',
  ].join('\n')
}

export function createThreadRuns({ sdk, pesto }: { sdk: ThreadRunSdk; pesto: Pick<PestoClient, 'dagStatus'> }) {
  const linkedRunId = async (threadId: string): Promise<string | null> => {
    const { runId } = await sdk.threads.getPluginMetadata({ threadId })
    return typeof runId === 'string' && runId !== '' ? runId : null
  }

  const ticketKey = async (threadId: string): Promise<string | null> => {
    try {
      const { issueKey } = await sdk.threads.getPluginMetadata({ threadId, pluginId: 'jira' })
      return typeof issueKey === 'string' && TICKET_KEY.test(issueKey) ? issueKey : null
    } catch {
      return null
    }
  }

  return {
    async threadRun(threadId: string): Promise<ThreadRun> {
      const runId = await linkedRunId(threadId)
      if (!runId) return { kind: 'none', ticketKey: await ticketKey(threadId) }
      try {
        const run = await pesto.dagStatus(runId)
        const pullRequests = run.pullRequests.map(({ number, url, state, repo }) => ({ number, url, state, repo }))
        return { kind: 'linked', runId, chip: runChip(run), pullRequests, error: null }
      } catch (error) {
        return { kind: 'linked', runId, chip: null, pullRequests: [], error: error instanceof Error ? error.message : String(error) }
      }
    },

    async link(threadId: string, runId: string): Promise<RunChip> {
      const chip = runChip(await pesto.dagStatus(runId))
      await sdk.threads.updatePluginMetadata({ threadId, set: { runId } })
      return chip
    },

    async startRun(threadId: string): Promise<void> {
      const text = startRunPrompt(await ticketKey(threadId))
      await sdk.threads.send({ threadId, input: [{ type: 'text', text, mentions: [] }], mode: 'queue-if-active' })
    },
  }
}
