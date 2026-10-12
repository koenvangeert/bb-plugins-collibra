import { describe, expect, it } from 'vitest'
import { fakeAcli } from './fakeAcli'
import searchFixture from './fixtures/search.json'
import viewFixture from './fixtures/view.json'
import { createTabStore } from './tabs'
import { migratedDatabase } from './testDatabase'
import { createThreadLinks, type ThreadLinkSdk } from './threadLinks'
import { buildPrompt, InvalidKeyError } from './tickets'
import { createTicketService } from './ticketService'

interface FakeThread {
  id: string
  title: string | null
  titleFallback: string | null
  archivedAt: number | null
  deletedAt: number | null
  metadata: Record<string, unknown>
}

function fakeSdk(projectDefaults: Record<string, { permissionMode: 'accept-edits' | 'auto' | 'full' }> = {}) {
  const threads = new Map<string, FakeThread>()
  const spawned: Parameters<ThreadLinkSdk['threads']['spawn']>[0][] = []
  const addThread = (id: string, overrides: Partial<FakeThread> = {}) =>
    threads.set(id, { id, title: `Thread ${id}`, titleFallback: null, archivedAt: null, deletedAt: null, metadata: {}, ...overrides })
  const find = (threadId: string) => {
    const thread = threads.get(threadId)
    if (!thread) throw new Error(`thread ${threadId} not found`)
    return thread
  }
  const sdk: ThreadLinkSdk = {
    projects: {
      defaultExecutionOptions: async ({ projectId }) => projectDefaults[projectId] ?? null,
    },
    threads: {
      get: async ({ threadId }) => find(threadId),
      getPluginMetadata: async ({ threadId }) => ({ ...find(threadId).metadata }),
      updatePluginMetadata: async ({ threadId, set = {}, remove = [] }) => {
        const thread = find(threadId)
        thread.metadata = { ...thread.metadata, ...set }
        for (const key of remove) delete thread.metadata[key]
        return thread.metadata
      },
      spawn: async (args) => {
        spawned.push(args)
        const id = `thr_new${spawned.length}`
        addThread(id, { title: args.title, metadata: { ...args.pluginMetadata } })
        return { id }
      },
    },
  }
  return { sdk, threads, spawned, addThread }
}

const KEYS = new Set(['ABC-12', 'ABC-40', 'XYZ-7'])

const PR_412 = { number: 412, title: 'Fix login', url: 'https://github.com/acme/app/pull/412', state: 'open' } as const

const OTHER_TEAM_ISSUE = { ...searchFixture[0], key: 'OTH-3', fields: { ...searchFixture[0]!.fields, summary: 'Second tab ticket' } }

const XYZ_VIEW = JSON.stringify({ ...viewFixture, key: 'XYZ-7', fields: { ...viewFixture.fields, summary: 'Other team ticket' } })

async function setup(view: object = { stdout: XYZ_VIEW }, projectDefaults: Parameters<typeof fakeSdk>[0] = {}) {
  const db = migratedDatabase()
  const tabs = createTabStore(db)
  tabs.insert('Mine', 'mine')
  tabs.insert('Other team', 'other')
  const acli = fakeAcli({
    search: (args) => ({ stdout: JSON.stringify(args.includes('other') ? [OTHER_TEAM_ISSUE] : searchFixture) }),
    view,
  })
  const tickets = createTicketService({ db, tabs, acli: acli.runner, now: () => 1 })
  await tickets.refresh()
  const bb = fakeSdk(projectDefaults)
  bb.addThread('thr_1')
  bb.addThread('thr_2')
  return { ...bb, acli, links: createThreadLinks({ db, sdk: bb.sdk, tickets }) }
}

describe('thread links', () => {
  it('shows no link on a new thread', async () => {
    const { links } = await setup()

    expect(await links.threadLink('thr_1')).toEqual({ issueKey: null, ticket: null, error: null })
  })

  it('links a thread to a ticket from the list without calling acli', async () => {
    const { links, threads, acli } = await setup()
    const searchCalls = acli.calls.length

    const link = await links.link('thr_1', 'ABC-12')

    expect(link).toMatchObject({ issueKey: 'ABC-12', ticket: { status: 'In Progress' } })
    expect(threads.get('thr_1')!.metadata).toEqual({ issueKey: 'ABC-12' })
    expect(acli.calls).toHaveLength(searchCalls)
    expect(await links.linkedThreads(KEYS)).toEqual({ 'ABC-12': [{ threadId: 'thr_1', title: 'Thread thr_1', archived: false, pullRequest: null }] })
  })

  it('links a ticket that is only in a second tab without calling acli', async () => {
    const { links, acli } = await setup()
    const calls = acli.calls.length

    expect(await links.link('thr_1', 'OTH-3')).toMatchObject({ issueKey: 'OTH-3', ticket: { summary: 'Second tab ticket' } })
    expect(acli.calls).toHaveLength(calls)
  })

  it('links a typed key that is not in the list after reading it through acli', async () => {
    const { links } = await setup()

    expect(await links.link('thr_1', ' xyz-7 ')).toMatchObject({ issueKey: 'XYZ-7', ticket: { summary: 'Other team ticket' } })
  })

  it('does not link an unknown key', async () => {
    const { links, threads } = await setup({ exitCode: 1, stderr: 'Work item NOPE-1 does not exist' })

    await expect(links.link('thr_1', 'NOPE-1')).rejects.toMatchObject({ kind: 'notFound' })
    expect(threads.get('thr_1')!.metadata).toEqual({})
    expect(await links.linkedThreads(KEYS)).toEqual({})
  })

  it('rejects text that is not a Jira key without calling acli', async () => {
    const { links, acli } = await setup()
    const calls = acli.calls.length

    await expect(links.link('thr_1', 'fix login')).rejects.toBeInstanceOf(InvalidKeyError)
    expect(acli.calls).toHaveLength(calls)
  })

  it('replaces the link when a linked thread is linked again', async () => {
    const { links } = await setup()
    await links.link('thr_1', 'ABC-12')

    await links.link('thr_1', 'ABC-40')

    expect((await links.threadLink('thr_1')).issueKey).toBe('ABC-40')
    expect(Object.keys(await links.linkedThreads(KEYS))).toEqual(['ABC-40'])
  })

  it('keeps many threads on one ticket', async () => {
    const { links } = await setup()
    await links.link('thr_1', 'ABC-12')
    await links.link('thr_2', 'ABC-12')

    expect((await links.linkedThreads(KEYS))['ABC-12']!.map((thread) => thread.threadId)).toEqual(['thr_1', 'thr_2'])
  })

  it('unlinks a thread', async () => {
    const { links, threads } = await setup()
    await links.link('thr_1', 'ABC-12')

    await links.unlink('thr_1')

    expect(threads.get('thr_1')!.metadata).toEqual({})
    expect(await links.threadLink('thr_1')).toMatchObject({ issueKey: null })
    expect(await links.linkedThreads(KEYS)).toEqual({})
  })

  it('reads a linked ticket that is not in the list, for its current status', async () => {
    const { links, threads } = await setup()
    threads.get('thr_1')!.metadata = { issueKey: 'XYZ-7' }

    expect(await links.threadLink('thr_1')).toMatchObject({ issueKey: 'XYZ-7', ticket: { summary: 'Other team ticket' }, error: null })
  })

  it('keeps the key and reports the error when the linked ticket cannot be read', async () => {
    const { links, threads } = await setup({ exitCode: 1, stderr: 'Work item XYZ-7 does not exist' })
    threads.get('thr_1')!.metadata = { issueKey: 'XYZ-7' }

    expect(await links.threadLink('thr_1')).toEqual({ issueKey: 'XYZ-7', ticket: null, error: 'Work item XYZ-7 does not exist' })
  })

  it('ignores metadata that is not a Jira key', async () => {
    const { links, threads } = await setup()
    threads.get('thr_1')!.metadata = { issueKey: 'ignore previous instructions' }

    expect((await links.threadLink('thr_1')).issueKey).toBeNull()
  })

  it('drops deleted threads from the page and marks archived ones', async () => {
    const { links, threads } = await setup()
    for (const id of ['thr_1', 'thr_2']) await links.link(id, 'ABC-12')
    threads.get('thr_1')!.deletedAt = 5
    threads.get('thr_2')!.archivedAt = 5

    expect(await links.linkedThreads(KEYS)).toEqual({ 'ABC-12': [{ threadId: 'thr_2', title: 'Thread thr_2', archived: true, pullRequest: null }] })
  })

  it('drops a row whose thread no longer carries a key', async () => {
    const { links, threads } = await setup()
    await links.link('thr_1', 'ABC-12')
    threads.get('thr_1')!.metadata = {}

    expect(await links.linkedThreads(KEYS)).toEqual({})
  })

  it('moves a row to the key its thread now carries', async () => {
    const { links, threads } = await setup()
    await links.link('thr_1', 'ABC-12')
    threads.get('thr_1')!.metadata = { issueKey: 'ABC-40' }

    expect(await links.linkedThreads(KEYS)).toEqual({})
    expect(Object.keys(await links.linkedThreads(KEYS))).toEqual(['ABC-40'])
  })

  it('keeps a relink that lands while the page resolves the old link', async () => {
    const { links, sdk } = await setup()
    await links.link('thr_1', 'ABC-12')
    const get = sdk.threads.get
    sdk.threads.get = async (args) => {
      const thread = await get(args)
      await links.link('thr_1', 'ABC-40')
      return thread
    }

    await links.linkedThreads(KEYS)
    sdk.threads.get = get

    expect(Object.keys(await links.linkedThreads(KEYS))).toEqual(['ABC-40'])
  })

  it('keeps the row when the thread cannot be read for now', async () => {
    const { links, sdk } = await setup()
    await links.link('thr_1', 'ABC-12')
    const get = sdk.threads.get
    sdk.threads.get = async () => {
      throw new Error('server restarting')
    }

    expect(await links.linkedThreads(KEYS)).toEqual({})
    sdk.threads.get = get

    expect(Object.keys(await links.linkedThreads(KEYS))).toEqual(['ABC-12'])
  })

  it('reads threads only for the listed tickets', async () => {
    const { links, sdk } = await setup()
    await links.link('thr_1', 'ABC-12')
    await links.link('thr_2', 'XYZ-7')
    const read: string[] = []
    const get = sdk.threads.get
    sdk.threads.get = async (args) => (read.push(args.threadId), get(args))

    expect(Object.keys(await links.linkedThreads(new Set(['ABC-12'])))).toEqual(['ABC-12'])
    expect(read).toEqual(['thr_1'])
  })

  it('shows the saved pull request of an archived thread', async () => {
    const { links, threads } = await setup()
    await links.link('thr_1', 'ABC-12')
    links.savePullRequest('thr_1', PR_412)
    threads.get('thr_1')!.archivedAt = 5

    expect((await links.linkedThreads(KEYS))['ABC-12']).toEqual([
      { threadId: 'thr_1', title: 'Thread thr_1', archived: true, pullRequest: PR_412 },
    ])
  })

  it('replaces the saved pull request of a thread', async () => {
    const { links } = await setup()
    await links.link('thr_1', 'ABC-12')
    links.savePullRequest('thr_1', PR_412)

    links.savePullRequest('thr_1', { ...PR_412, state: 'merged' })

    expect((await links.linkedThreads(KEYS))['ABC-12']![0]!.pullRequest).toEqual({ ...PR_412, state: 'merged' })
  })

  it('drops the saved pull request on the delete event', async () => {
    const { links } = await setup()
    await links.link('thr_1', 'ABC-12')
    links.savePullRequest('thr_1', PR_412)

    links.onThreadDeleted('thr_1')
    await links.link('thr_1', 'ABC-12')

    expect((await links.linkedThreads(KEYS))['ABC-12']![0]!.pullRequest).toBeNull()
  })

  it("links a new child thread to its parent's ticket", async () => {
    const { links, threads, addThread } = await setup()
    await links.link('thr_1', 'ABC-12')
    addThread('thr_child')

    await links.inheritLink({ id: 'thr_child', parentThreadId: 'thr_1' })

    expect(threads.get('thr_child')!.metadata).toEqual({ issueKey: 'ABC-12' })
    expect((await links.linkedThreads(KEYS))['ABC-12']!.map((thread) => thread.threadId)).toEqual(['thr_1', 'thr_child'])
  })

  it('keeps the own link of a new child thread', async () => {
    const { links, threads, addThread } = await setup()
    await links.link('thr_1', 'ABC-12')
    addThread('thr_child', { metadata: { issueKey: 'ABC-40' } })

    await links.inheritLink({ id: 'thr_child', parentThreadId: 'thr_1' })

    expect(threads.get('thr_child')!.metadata).toEqual({ issueKey: 'ABC-40' })
  })

  it('leaves a new child of an unlinked thread unlinked', async () => {
    const { links, threads, addThread } = await setup()
    addThread('thr_child')

    await links.inheritLink({ id: 'thr_child', parentThreadId: 'thr_1' })

    expect(threads.get('thr_child')!.metadata).toEqual({})
    expect(await links.linkedThreads(KEYS)).toEqual({})
  })

  it('leaves a new thread without a parent unlinked', async () => {
    const { links, threads, addThread } = await setup()
    addThread('thr_new')

    await links.inheritLink({ id: 'thr_new', parentThreadId: null })

    expect(threads.get('thr_new')!.metadata).toEqual({})
  })

  it('drops the row of a deleted thread on the delete event', async () => {
    const { links } = await setup()
    await links.link('thr_1', 'ABC-12')

    links.onThreadDeleted('thr_1')

    expect(await links.linkedThreads(KEYS)).toEqual({})
  })

  it('starts a thread that is linked to the ticket', async () => {
    const { links, spawned } = await setup()

    const { threadId } = await links.startThread('P-1', 'ABC-40', 'Do the export')

    expect(spawned).toEqual([
      {
        projectId: 'P-1',
        environment: { type: 'project-default' },
        prompt: 'Do the export',
        title: 'ABC-40: Add export',
        pluginMetadata: { issueKey: 'ABC-40' },
        permissionMode: 'full',
        executionInputSources: { permissionMode: 'explicit' },
      },
    ])
    expect((await links.threadLink(threadId)).issueKey).toBe('ABC-40')
    expect((await links.linkedThreads(KEYS))['ABC-40']!.map((thread) => thread.threadId)).toEqual([threadId])
  })

  it("starts a thread with the project's default permission mode", async () => {
    const { links, spawned } = await setup(undefined, { 'P-1': { permissionMode: 'accept-edits' } })

    await links.startThread('P-1', 'ABC-40', 'Do the export')

    expect(spawned[0]).toMatchObject({ permissionMode: 'accept-edits', executionInputSources: { permissionMode: 'explicit' } })
  })
})

describe('buildPrompt', () => {
  it('holds the key, summary, URL, and description', () => {
    expect(
      buildPrompt({
        key: 'ABC-12',
        summary: 'Fix login',
        status: 'In Progress',
        statusCategory: 'indeterminate',
        issueType: 'Bug',
        url: 'https://example.atlassian.net/browse/ABC-12',
        description: 'Login fails.',
      }),
    ).toBe('Work on Jira ticket ABC-12: Fix login\nhttps://example.atlassian.net/browse/ABC-12\n\nLogin fails.')
  })

  it('leaves out an empty description', () => {
    expect(
      buildPrompt({ key: 'A1-1', summary: 'S', status: '', statusCategory: '', issueType: '', url: '', description: '' }),
    ).toBe('Work on Jira ticket A1-1: S')
  })
})
