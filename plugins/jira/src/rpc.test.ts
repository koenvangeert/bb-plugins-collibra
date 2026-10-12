import { describe, expect, it } from 'vitest'
import { fakeAcli } from './fakeAcli'
import searchFixture from './fixtures/search.json'
import viewFixture from './fixtures/view.json'
import { createRpcHandlers, rpcContract } from './rpc'
import { createTabStore } from './tabs'
import { migratedDatabase } from './testDatabase'
import { createThreadLinks, type ThreadLinkSdk } from './threadLinks'
import { createTicketService } from './ticketService'

let threadReads: string[] = []

function handlers() {
  threadReads = []
  const db = migratedDatabase()
  const tabs = createTabStore(db)
  tabs.insert('Mine', 'mine')
  const acli = fakeAcli({
    search: (args) => (args.includes('broken') ? { exitCode: 1, stderr: 'bad JQL' } : { stdout: JSON.stringify(searchFixture) }),
    view: { stdout: JSON.stringify(viewFixture) },
  })
  const tickets = createTicketService({ db, tabs, acli: acli.runner, now: () => 7 })
  const metadata: Record<string, Record<string, unknown>> = { thr_1: {} }
  const sdk: ThreadLinkSdk = {
    projects: { defaultExecutionOptions: async () => null },
    threads: {
      get: async ({ threadId }) => (threadReads.push(threadId), { id: threadId, title: 'Fix it', titleFallback: null, archivedAt: null, deletedAt: null }),
      getPluginMetadata: async ({ threadId }) => ({ ...metadata[threadId] }),
      updatePluginMetadata: async ({ threadId, set = {}, remove = [] }) => {
        const next = { ...metadata[threadId], ...set }
        for (const key of remove) delete next[key]
        return (metadata[threadId] = next)
      },
      spawn: async ({ pluginMetadata }) => {
        metadata.thr_new = { ...pluginMetadata }
        return { id: 'thr_new' }
      },
    },
  }
  const projects = [{ id: 'P-1', name: 'catalog', sources: [] }]
  return createRpcHandlers({
    tickets,
    links: createThreadLinks({ db, sdk, tickets }),
    listProjects: async () => projects,
  })
}

describe('rpc handlers', () => {
  it('return an empty tab before, and its tickets after, a refresh', async () => {
    const rpc = handlers()

    expect(rpcContract.tickets.output.parse(await rpc.tickets())).toMatchObject({ tabs: [{ name: 'Mine', tickets: [], refreshedAt: null }] })
    const refreshed = rpcContract.refresh.output.parse(await rpc.refresh())
    expect(refreshed.tabs[0]!.tickets.map((entry) => entry.key)).toEqual(['ABC-12', 'ABC-40', 'ABC-77'])
    expect(refreshed.tabs[0]!.refreshedAt).toBe(7)
  })

  it('add, rename, and delete a tab', async () => {
    const rpc = handlers()

    const added = rpcContract.saveTab.output.parse(await rpc.saveTab({ name: 'Release', jql: 'fixVersion = 1.0' }))
    const release = added.tabs[1]!
    expect(release).toMatchObject({ name: 'Release', jql: 'fixVersion = 1.0' })
    expect(release.tickets).toHaveLength(3)

    const renamed = rpcContract.saveTab.output.parse(await rpc.saveTab({ id: release.id, name: 'This release', jql: release.jql }))
    expect(renamed.tabs.map((entry) => entry.name)).toEqual(['Mine', 'This release'])

    const deleted = rpcContract.deleteTab.output.parse(await rpc.deleteTab({ id: release.id }))
    expect(deleted.tabs.map((entry) => entry.name)).toEqual(['Mine'])
  })

  it('fail a save with the acli error of a bad query', async () => {
    await expect(handlers().saveTab({ name: 'Broken', jql: 'broken' })).rejects.toThrow('bad JQL')
  })

  it('reject a tab with an empty name or query', () => {
    expect(rpcContract.saveTab.input.safeParse({ name: '  ', jql: 'q' }).success).toBe(false)
    expect(rpcContract.saveTab.input.safeParse({ name: 'N', jql: '  ' }).success).toBe(false)
  })

  it('set and remove the filters of a tab', async () => {
    const rpc = handlers()
    const id = (await rpc.tickets()).tabs[0]!.id
    const filter = { field: 'status' as const, label: 'Status', operator: 'not in' as const, values: [{ label: 'Done', jql: '"Done"' }] }

    const filtered = rpcContract.setFilters.output.parse(await rpc.setFilters({ id, filters: [filter] }))
    expect(filtered.tabs[0]).toMatchObject({ filters: [filter], valuesLimitReached: false })

    const cleared = rpcContract.setFilters.output.parse(await rpc.setFilters({ id, filters: [] }))
    expect(cleared.tabs[0]!.filters).toEqual([])
    expect(cleared.tabs[0]!.fieldValues.status).toContainEqual({ label: 'In Review', jql: '"In Review"' })
  })

  it.each([
    ['no values', { values: [] }],
    ['an unknown operator', { operator: '=' }],
    ['a field outside the field list', { field: 'customfield_10020' }],
    ['a value that is not a quoted literal', { values: [{ label: 'x', jql: 'x OR project = OPS' }] }],
  ])('reject a filter with %s', (_case, change) => {
    const filter = { field: 'status', label: 'Status', operator: 'in', values: [{ label: 'Done', jql: '"Done"' }], ...change }

    expect(rpcContract.setFilters.input.safeParse({ id: 1, filters: [filter] }).success).toBe(false)
  })

  it('accept the empty value and a quoted literal with escapes', () => {
    const values = [
      { label: '(empty)', jql: 'EMPTY' },
      { label: 'a "b"', jql: '"a \\"b\\""' },
    ]

    expect(rpcContract.setFilters.input.safeParse({ id: 1, filters: [{ field: 'labels', label: 'Labels', operator: 'in', values }] }).success).toBe(true)
  })

  it('resolve linked threads once for a ticket in two tabs', async () => {
    const rpc = handlers()
    await rpc.refresh()
    await rpc.saveTab({ name: 'Same', jql: 'same' })
    await rpc.link({ threadId: 'thr_1', key: 'ABC-12' })
    threadReads = []

    const list = rpcContract.tickets.output.parse(await rpc.tickets())

    expect(list.tabs.map((entry) => entry.tickets[0]!.threads)).toEqual([
      [{ threadId: 'thr_1', title: 'Fix it', archived: false, pullRequest: null }],
      [{ threadId: 'thr_1', title: 'Fix it', archived: false, pullRequest: null }],
    ])
    expect(threadReads).toEqual(['thr_1'])
  })

  it('list picker tickets from all tabs without threads', async () => {
    const rpc = handlers()
    await rpc.refresh()
    await rpc.saveTab({ name: 'Same', jql: 'same' })

    const picker = rpcContract.pickerTickets.output.parse(await rpc.pickerTickets())

    expect(picker.map((entry) => entry.key)).toEqual(['ABC-12', 'ABC-40', 'ABC-77'])
  })

  it('return one ticket with a prompt prefill', async () => {
    const detail = rpcContract.ticket.output.parse(await handlers().ticket({ key: 'ABC-12' }))

    expect(detail.prompt).toContain('Work on Jira ticket ABC-12: Fix login')
    expect(detail.prompt).toContain('password reset')
  })

  it('link, show, and unlink a thread, with the link on the ticket row', async () => {
    const rpc = handlers()
    await rpc.refresh()

    expect(rpcContract.link.output.parse(await rpc.link({ threadId: 'thr_1', key: 'ABC-12' }))).toMatchObject({ issueKey: 'ABC-12' })
    expect(rpcContract.threadLink.output.parse(await rpc.threadLink({ threadId: 'thr_1' }))).toMatchObject({ issueKey: 'ABC-12' })
    const list = rpcContract.tickets.output.parse(await rpc.tickets())
    expect(list.tabs[0]!.tickets[0]!.threads).toEqual([{ threadId: 'thr_1', title: 'Fix it', archived: false, pullRequest: null }])

    expect(rpcContract.unlink.output.parse(await rpc.unlink({ threadId: 'thr_1' }))).toEqual({ ok: true })
    expect((await rpc.threadLink({ threadId: 'thr_1' })).issueKey).toBeNull()
  })

  it('list projects by id and name only', async () => {
    expect(rpcContract.projects.output.parse(await handlers().projects())).toEqual([{ id: 'P-1', name: 'catalog' }])
  })

  it('start a linked thread', async () => {
    const rpc = handlers()
    await rpc.refresh()

    const started = rpcContract.startThread.output.parse(await rpc.startThread({ projectId: 'P-1', key: 'ABC-40', prompt: 'Go' }))

    expect(started).toEqual({ threadId: 'thr_new' })
    expect((await rpc.threadLink({ threadId: 'thr_new' })).issueKey).toBe('ABC-40')
  })

  it('reject an empty prompt', () => {
    expect(rpcContract.startThread.input.safeParse({ projectId: 'P-1', key: 'ABC-40', prompt: '  ' }).success).toBe(false)
  })
})
