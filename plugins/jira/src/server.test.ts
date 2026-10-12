import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing'
import { createPlugin } from '../server'
import { fakeAcli } from './fakeAcli'
import type { TicketList } from './rpc'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

async function start(acli: ReturnType<typeof fakeAcli>) {
  const metadata: Record<string, Record<string, unknown>> = { thr_1: {}, thr_child: {} }
  const { bb, harness } = createFakePluginHost({
    pluginId: 'jira',
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, title: 'Fix it' }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) => ({ ...metadata[threadId] }),
        updatePluginMetadata: async ({ threadId, set = {} }: { threadId: string; set?: Record<string, unknown> }) =>
          (metadata[threadId] = { ...metadata[threadId], ...set }),
      },
    },
  })
  await createPlugin(acli.runner)(bb)
  return harness
}

type Harness = Awaited<ReturnType<typeof start>>

const ticketList = (harness: Harness) => harness.behavior.callRpc('tickets', null) as Promise<TicketList>

async function refreshOnce(harness: Harness) {
  const service = harness.behavior.runService('ticket-refresh')
  await expect.poll(async () => {
    const [tab] = (await ticketList(harness)).tabs
    return tab?.refreshedAt ?? tab?.error
  }).toBeTruthy()
  service.controller.abort()
  await service.done
}

describe('jira plugin server', () => {
  it('starts with one "My tickets" tab on the default query', async () => {
    const harness = await start(fakeAcli())

    expect((await ticketList(harness)).tabs).toEqual([
      expect.objectContaining({ name: 'My tickets', jql: 'assignee = currentUser() AND statusCategory != Done' }),
    ])
  })

  it('marks the plugin as needing configuration when acli is logged out', async () => {
    const harness = await start(fakeAcli({ search: { exitCode: 1, stderr: fixture('auth-status-logged-out.txt') } }))

    await refreshOnce(harness)

    expect(harness.needsConfigurationMessages).toEqual([expect.stringContaining('acli jira auth login')])
  })

  it('marks the plugin as needing configuration when acli is missing', async () => {
    const harness = await start(fakeAcli({ search: { exitCode: -1, spawnError: 'ENOENT' } }))

    await refreshOnce(harness)

    expect(harness.needsConfigurationMessages).toEqual([expect.stringContaining('not installed')])
  })

  it('serves the refreshed tickets with linked threads over RPC', async () => {
    const harness = await start(fakeAcli({ search: { stdout: fixture('search.json') }, auth: { stdout: fixture('auth-status.txt') } }))
    await refreshOnce(harness)

    await harness.behavior.callRpc('link', { threadId: 'thr_1', key: 'abc-12' })
    const list = await ticketList(harness)

    expect(harness.needsConfigurationMessages).toEqual([])
    expect(list.tabs[0]!.tickets[0]).toMatchObject({
      key: 'ABC-12',
      url: 'https://example.atlassian.net/browse/ABC-12',
      threads: [{ threadId: 'thr_1', title: 'Fix it', archived: false, pullRequest: null }],
    })
  })

  it('stops the ticket-refresh service while acli is still running', async () => {
    const hungUntilAbort = (_args: string[], signal?: AbortSignal) =>
      new Promise<{ exitCode: number }>((resolve) => signal?.addEventListener('abort', () => resolve({ exitCode: 1 })))
    const acli = fakeAcli({ search: hungUntilAbort })
    const harness = await start(acli)
    const service = harness.behavior.runService('ticket-refresh')
    await expect.poll(() => acli.calls.length).toBe(1)

    service.controller.abort()

    await expect(service.done).resolves.toBeUndefined()
  })

  it("links a new child thread to its parent's ticket", async () => {
    const harness = await start(fakeAcli({ search: { stdout: fixture('search.json') } }))
    await refreshOnce(harness)
    await harness.behavior.callRpc('link', { threadId: 'thr_1', key: 'ABC-12' })

    await harness.behavior.emitThreadEvent('thread.created', {
      thread: makeThreadResponse({ id: 'thr_child', parentThreadId: 'thr_1' }),
    })

    const list = await ticketList(harness)

    expect(list.tabs[0]!.tickets[0]!.threads.map(({ threadId }) => threadId)).toEqual(['thr_1', 'thr_child'])
  })

  it('serves the saved pull request of a linked thread', async () => {
    const harness = await start(fakeAcli({ search: { stdout: fixture('search.json') } }))
    await refreshOnce(harness)
    await harness.behavior.callRpc('link', { threadId: 'thr_1', key: 'ABC-12' })
    const pullRequest = { number: 412, title: 'Fix login', url: 'https://github.com/acme/app/pull/412', state: 'merged' }

    await harness.behavior.callRpc('savePullRequest', { threadId: 'thr_1', pullRequest })

    expect((await ticketList(harness)).tabs[0]!.tickets[0]!.threads[0]!.pullRequest).toEqual(pullRequest)
  })

  it('drops the link of a deleted thread', async () => {
    const harness = await start(fakeAcli({ search: { stdout: fixture('search.json') } }))
    await refreshOnce(harness)
    await harness.behavior.callRpc('link', { threadId: 'thr_1', key: 'ABC-12' })

    await harness.behavior.emitThreadEvent('thread.deleted', { thread: makeThreadResponse({ id: 'thr_1' }) })
    const list = await ticketList(harness)

    expect(list.tabs[0]!.tickets[0]!.threads).toEqual([])
  })
})
