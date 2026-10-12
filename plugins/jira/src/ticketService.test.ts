import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { fakeAcli } from './fakeAcli'
import { EMPTY_VALUE, type Filter } from './filterFields'
import searchFixture from './fixtures/search.json'
import viewFixture from './fixtures/view.json'
import { createTabStore, TabNotFoundError } from './tabs'
import { migratedDatabase } from './testDatabase'
import { InvalidKeyError, TICKET_LIMIT } from './tickets'
import { createTicketService, VIEW_CACHE_MS, type TicketSnapshot } from './ticketService'

const NO_VALUES = { fieldValues: {}, valuesLimitReached: false }
const SEARCH_OK = { stdout: JSON.stringify(searchFixture) }
const LOGGED_OUT = { exitCode: 1, stderr: "✗ Error: unauthorized: use 'acli jira auth login' to authenticate" }

function service(acli = fakeAcli({ search: SEARCH_OK }), onHealth = vi.fn(), now = () => 1_000, db = migratedDatabase()) {
  const tabs = createTabStore(db)
  if (tabs.list().length === 0) tabs.insert('Mine', 'my jql')
  return { db, tabs, onHealth, acli, tickets: createTicketService({ db, tabs, acli: acli.runner, now, onHealth }) }
}

const firstTab = (snapshot: TicketSnapshot) => snapshot.tabs[0]!
const searches = (acli: ReturnType<typeof fakeAcli>) => acli.calls.filter((args) => args[2] === 'search')

describe('ticket service', () => {
  it('starts empty before the first refresh', () => {
    expect(service().tickets.snapshot()).toMatchObject({
      tabs: [{ name: 'Mine', jql: 'my jql', tickets: [], refreshedAt: null, error: null, limitReached: false }],
      health: 'ok',
    })
  })

  it('stores the tickets from a refresh in query order', async () => {
    const { tickets, acli } = service()

    const snapshot = await tickets.refresh()

    expect(firstTab(snapshot).tickets.map((ticket) => ticket.key)).toEqual(['ABC-12', 'ABC-40', 'ABC-77'])
    expect(firstTab(snapshot)).toMatchObject({ refreshedAt: 1_000, error: null, limitReached: false })
    expect(snapshot.health).toBe('ok')
    expect(acli.calls[0]).toContain('my jql')
  })

  it('keeps the last good list and stores the error when a refresh fails', async () => {
    let fail = false
    const acli = fakeAcli({ search: () => (fail ? { exitCode: 1, stderr: 'connection reset' } : SEARCH_OK) })
    let clock = 1_000
    const { tickets } = service(acli, vi.fn(), () => clock)
    await tickets.refresh()
    fail = true
    clock = 2_000

    const snapshot = await tickets.refresh()

    expect(firstTab(snapshot).tickets).toHaveLength(3)
    expect(firstTab(snapshot)).toMatchObject({ refreshedAt: 1_000, error: 'connection reset' })
    expect(snapshot.health).toBe('ok')
  })

  it('replaces the list on the next good refresh', async () => {
    let result = SEARCH_OK
    const { tickets } = service(fakeAcli({ search: () => result }))
    await tickets.refresh()
    result = { stdout: JSON.stringify([searchFixture[1]]) }

    expect(firstTab(await tickets.refresh()).tickets.map((ticket) => ticket.key)).toEqual(['ABC-40'])
  })

  it('runs acli once when a manual refresh joins a running refresh', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const acli = fakeAcli({ search: async () => (await gate, SEARCH_OK) })
    const { tickets } = service(acli)

    const first = tickets.refresh()
    expect(tickets.snapshot().refreshing).toBe(true)
    const second = tickets.refresh()
    release()

    expect(await second).toEqual(await first)
    expect(searches(acli)).toHaveLength(1)
    expect(tickets.snapshot().refreshing).toBe(false)
  })

  it('stops an aborted refresh without more acli calls, errors or health changes', async () => {
    const controller = new AbortController()
    const acli = fakeAcli({
      search: () => {
        controller.abort()
        return LOGGED_OUT
      },
    })
    const { tickets, tabs, onHealth } = service(acli)
    tabs.insert('Second', 'second jql')

    const snapshot = await tickets.refresh(controller.signal)

    expect(searches(acli)).toHaveLength(1)
    expect(snapshot.tabs.map((tab) => tab.error)).toEqual([null, null])
    expect(snapshot.health).toBe('ok')
    expect(onHealth).not.toHaveBeenCalled()
  })

  it('keeps the last list when the refresh is aborted while it reads the site URL', async () => {
    const controller = new AbortController()
    const acli = fakeAcli({
      search: SEARCH_OK,
      auth: () => {
        controller.abort()
        return { exitCode: 1 }
      },
    })
    const { tickets } = service(acli)

    const snapshot = await tickets.refresh(controller.signal)

    expect(firstTab(snapshot)).toMatchObject({ tickets: [], refreshedAt: null, error: null })
  })

  it('reports a logged-out acli once, and recovery after the next good refresh', async () => {
    let result: object = LOGGED_OUT
    const { tickets, onHealth } = service(fakeAcli({ search: () => result }))

    const loggedOut = await tickets.refresh()
    expect(loggedOut.health).toBe('loggedOut')
    expect(firstTab(loggedOut)).toMatchObject({ error: expect.stringContaining('acli jira auth login') })
    expect(onHealth).toHaveBeenLastCalledWith('loggedOut', expect.stringContaining('acli jira auth login'))

    result = SEARCH_OK
    const recovered = await tickets.refresh()
    expect(recovered.health).toBe('ok')
    expect(firstTab(recovered).error).toBeNull()
    expect(onHealth).toHaveBeenLastCalledWith('ok', null)
  })

  it('reports a missing acli', async () => {
    const { tickets, onHealth } = service(fakeAcli({ search: { exitCode: -1, spawnError: 'ENOENT' } }))

    expect(await tickets.refresh()).toMatchObject({ health: 'missing' })
    expect(onHealth).toHaveBeenCalledWith('missing', expect.stringContaining('not installed'))
  })

  it('does not report health for an ordinary failure', async () => {
    const { tickets, onHealth } = service(fakeAcli({ search: { exitCode: 1, stderr: 'bad JQL' } }))

    await tickets.refresh()

    expect(onHealth).not.toHaveBeenCalled()
  })

  const issues = (count: number) =>
    JSON.stringify(Array.from({ length: count }, (_, index) => ({ ...searchFixture[0], key: `ABC-${index + 1}` })))

  it('asks for one ticket more than the limit, keeps the limit, and flags the cut', async () => {
    const acli = fakeAcli({ search: { stdout: issues(TICKET_LIMIT + 1) } })
    const { tickets } = service(acli)

    const snapshot = await tickets.refresh()

    expect(acli.calls[0]).toEqual(expect.arrayContaining(['--limit', String(TICKET_LIMIT + 1)]))
    expect(firstTab(snapshot).tickets).toHaveLength(TICKET_LIMIT)
    expect(firstTab(snapshot).limitReached).toBe(true)
  })

  it('does not flag a list of exactly the limit', async () => {
    const { tickets } = service(fakeAcli({ search: { stdout: issues(TICKET_LIMIT) } }))

    expect(firstTab(await tickets.refresh()).limitReached).toBe(false)
  })

  it('keeps a logged-out state through an ordinary failure', async () => {
    let result: object = LOGGED_OUT
    const { tickets, onHealth } = service(fakeAcli({ search: () => result }))
    await tickets.refresh()
    result = { timedOut: true, exitCode: -1 }

    const snapshot = await tickets.refresh()
    expect(snapshot.health).toBe('loggedOut')
    expect(firstTab(snapshot).error).toContain('30 seconds')
    expect(onHealth).toHaveBeenCalledTimes(1)
  })

  it('builds browse URLs from the acli site and reads the site once', async () => {
    const acli = fakeAcli({
      search: SEARCH_OK,
      auth: { stdout: readFileSync(new URL('./fixtures/auth-status.txt', import.meta.url), 'utf8') },
    })
    const { tickets } = service(acli)

    expect(firstTab(await tickets.refresh()).tickets[0]!.url).toBe('https://example.atlassian.net/browse/ABC-12')
    await tickets.refresh()
    expect(acli.calls.filter((args) => args[1] === 'auth')).toHaveLength(1)
  })

  describe('with more tabs', () => {
    const replies: Record<string, object> = {
      'my jql': SEARCH_OK,
      'release jql': { stdout: JSON.stringify([searchFixture[2], searchFixture[0]]) },
    }
    const byJql = (args: string[]) => replies[args[args.indexOf('--jql') + 1]!] ?? { exitCode: 1, stderr: 'bad JQL' }

    it('refreshes every tab in order with its own query', async () => {
      const { tickets, tabs, acli } = service(fakeAcli({ search: byJql }))
      tabs.insert('Release', 'release jql')

      const snapshot = await tickets.refresh()

      expect(searches(acli).map((args) => args[args.indexOf('--jql') + 1])).toEqual(['my jql', 'release jql'])
      expect(snapshot.tabs.map((tab) => tab.tickets.map((ticket) => ticket.key))).toEqual([
        ['ABC-12', 'ABC-40', 'ABC-77'],
        ['ABC-77', 'ABC-12'],
      ])
    })

    it('keeps the new list of a good tab when another tab has a bad query', async () => {
      const { tickets, tabs } = service(fakeAcli({ search: byJql }))
      tabs.insert('Warning', 'broken jql')
      tabs.insert('Release', 'release jql')

      const snapshot = await tickets.refresh()

      expect(snapshot.tabs.map((tab) => [tab.name, tab.tickets.length, tab.error])).toEqual([
        ['Mine', 3, null],
        ['Warning', 0, 'bad JQL'],
        ['Release', 2, null],
      ])
      expect(snapshot.health).toBe('ok')
    })

    it('stops at the first tab when acli is logged out', async () => {
      const acli = fakeAcli({ search: LOGGED_OUT })
      const { tickets, tabs } = service(acli)
      tabs.insert('Release', 'release jql')

      expect((await tickets.refresh()).health).toBe('loggedOut')
      expect(searches(acli)).toHaveLength(1)
    })

    it('drops a result for a tab whose query changed during the refresh', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const { tickets, tabs } = service(fakeAcli({ search: async (args) => (args.includes('my jql') && (await gate), byJql(args)) }))
      const tab = tabs.list()[0]!

      const refreshing = tickets.refresh()
      await tickets.saveTab({ id: tab.id, name: 'Mine', jql: 'release jql' })
      release()
      const snapshot = await refreshing

      expect(firstTab(snapshot).tickets.map((ticket) => ticket.key)).toEqual(['ABC-77', 'ABC-12'])
    })

    it('drops a result for a tab deleted during the refresh', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const { tickets, tabs, db } = service(fakeAcli({ search: async (args) => (await gate, byJql(args)) }))

      const refreshing = tickets.refresh()
      tickets.deleteTab(tabs.list()[0]!.id)
      release()

      expect((await refreshing).tabs).toEqual([])
      expect(db.prepare('SELECT COUNT(*) AS n FROM tab_tickets').all()).toEqual([{ n: 0 }])
    })
  })

  describe('with filters', () => {
    const toDo: Filter = { field: 'status', label: 'Status', operator: 'in', values: [{ label: 'In Review', jql: '"In Review"' }] }
    const filteredJql = '(my jql) AND status in ("In Review")'
    const replies: Record<string, object> = {
      'my jql': SEARCH_OK,
      [filteredJql]: { stdout: JSON.stringify([searchFixture[1]]) },
    }
    const byJql = (args: string[]) => replies[args[args.indexOf('--jql') + 1]!] ?? { exitCode: 1, stderr: 'bad JQL' }
    const jqls = (acli: ReturnType<typeof fakeAcli>) => searches(acli).map((args) => args[args.indexOf('--jql') + 1])

    it('refreshes a filtered tab with the filtered query and reads its values from the tab query', async () => {
      const { tickets, tabs, acli } = service(fakeAcli({ search: byJql }))
      tabs.setFilters(tabs.list()[0]!, [toDo], { tickets: [], limitReached: false, refreshedAt: 1, values: NO_VALUES })

      const tab = firstTab(await tickets.refresh())

      expect(jqls(acli)).toEqual(['my jql', filteredJql])
      expect(tab.tickets.map((ticket) => ticket.key)).toEqual(['ABC-40'])
      expect(tab.filters).toEqual([toDo])
      expect(tab.fieldValues.status).toEqual([
        { label: 'In Progress', jql: '"In Progress"' },
        { label: 'In Review', jql: '"In Review"' },
        EMPTY_VALUE,
      ])
    })

    it('reads a tab without filters with one search and stores its values', async () => {
      const { tickets, acli } = service(fakeAcli({ search: byJql }))

      const tab = firstTab(await tickets.refresh())

      expect(jqls(acli)).toEqual(['my jql'])
      expect(tab.fieldValues.assignee).toEqual([{ label: 'Ann Lee', jql: '"712020:ann"' }, EMPTY_VALUE])
      expect(tab.valuesLimitReached).toBe(false)
    })

    it('keeps the last good list and values when the filtered search fails', async () => {
      let filteredFails = false
      const acli = fakeAcli({ search: (args) => (filteredFails && args.includes(filteredJql) ? { exitCode: 1, stderr: 'timeout' } : byJql(args)) })
      const { tickets, tabs } = service(acli)
      tabs.setFilters(tabs.list()[0]!, [toDo], { tickets: [], limitReached: false, refreshedAt: 1, values: NO_VALUES })
      const good = firstTab(await tickets.refresh())
      filteredFails = true

      const tab = firstTab(await tickets.refresh())

      expect(tab).toMatchObject({ tickets: good.tickets, fieldValues: good.fieldValues, error: 'timeout' })
    })

    it('saves filters with their list after the filtered query runs, and keeps the values', async () => {
      const { tickets, tabs, acli } = service(fakeAcli({ search: byJql }))
      await tickets.refresh()
      const values = firstTab(tickets.snapshot()).fieldValues

      const tab = firstTab(await tickets.setFilters({ id: tabs.list()[0]!.id, filters: [toDo] }))

      expect(jqls(acli)).toEqual(['my jql', filteredJql])
      expect(tab).toMatchObject({ filters: [toDo], fieldValues: values })
      expect(tab.tickets.map((ticket) => ticket.key)).toEqual(['ABC-40'])
    })

    it('saves nothing when the filtered query fails', async () => {
      const { tickets, tabs } = service(fakeAcli({ search: byJql }))
      const broken: Filter = { ...toDo, values: [{ label: 'x', jql: '"x"' }] }

      await expect(tickets.setFilters({ id: tabs.list()[0]!.id, filters: [broken] })).rejects.toThrow('bad JQL')

      expect(tabs.list()[0]!.filters).toEqual([])
    })

    it('removes all filters with one search of the tab query', async () => {
      const { tickets, tabs, acli } = service(fakeAcli({ search: byJql }))
      tabs.setFilters(tabs.list()[0]!, [toDo], { tickets: [], limitReached: false, refreshedAt: 1, values: NO_VALUES })

      const tab = firstTab(await tickets.setFilters({ id: tabs.list()[0]!.id, filters: [] }))

      expect(jqls(acli)).toEqual(['my jql'])
      expect(tab.tickets).toHaveLength(3)
      expect(tab.fieldValues.status).toHaveLength(3)
    })

    it('rejects filters for a tab that does not exist', async () => {
      await expect(service().tickets.setFilters({ id: 999, filters: [] })).rejects.toBeInstanceOf(TabNotFoundError)
    })

    it('keeps the filters when the tab query changes', async () => {
      const { tickets, tabs, acli } = service(fakeAcli({ search: (args) => (args.includes('(new jql) AND status in ("In Review")') ? { stdout: '[]' } : SEARCH_OK) }))
      tabs.setFilters(tabs.list()[0]!, [toDo], { tickets: [], limitReached: false, refreshedAt: 1, values: NO_VALUES })

      const tab = firstTab(await tickets.saveTab({ id: tabs.list()[0]!.id, name: 'Mine', jql: 'new jql' }))

      expect(jqls(acli)).toEqual(['new jql', '(new jql) AND status in ("In Review")'])
      expect(tab).toMatchObject({ jql: 'new jql', filters: [toDo], tickets: [] })
    })
  })

  describe('saving a tab', () => {
    it('saves a new tab with its first list after the query runs', async () => {
      const { tickets } = service()

      const snapshot = await tickets.saveTab({ name: 'Release', jql: 'fixVersion in unreleasedVersions()' })

      expect(snapshot.tabs[1]).toMatchObject({ name: 'Release', jql: 'fixVersion in unreleasedVersions()', refreshedAt: 1_000 })
      expect(snapshot.tabs[1]!.tickets).toHaveLength(3)
    })

    it('saves nothing when the query fails', async () => {
      const { tickets } = service(fakeAcli({ search: { exitCode: 1, stderr: "Error in the JQL Query: '=' unexpected" } }))

      await expect(tickets.saveTab({ name: 'Broken', jql: 'status = = Done' })).rejects.toThrow("'=' unexpected")

      expect(tickets.snapshot().tabs.map((tab) => tab.name)).toEqual(['Mine'])
    })

    it('renames a tab without calling acli', async () => {
      const { tickets, tabs, acli } = service()
      const tab = tabs.list()[0]!

      const snapshot = await tickets.saveTab({ id: tab.id, name: 'Overdue', jql: tab.jql })

      expect(snapshot.tabs.map((entry) => entry.name)).toEqual(['Overdue'])
      expect(acli.calls).toHaveLength(0)
    })

    it('keeps the old query when a changed query fails', async () => {
      const { tickets, tabs } = service(fakeAcli({ search: { exitCode: 1, stderr: 'bad JQL' } }))
      const tab = tabs.list()[0]!

      await expect(tickets.saveTab({ id: tab.id, name: 'Mine', jql: 'broken' })).rejects.toThrow('bad JQL')

      expect(tabs.get(tab.id)!.jql).toBe('my jql')
    })

    it('rejects an edit of a tab deleted while its new query runs', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const { tickets, tabs } = service(fakeAcli({ search: async () => (await gate, SEARCH_OK) }))
      const tab = tabs.list()[0]!

      const saving = tickets.saveTab({ id: tab.id, name: 'Mine', jql: 'new jql' })
      tickets.deleteTab(tab.id)
      release()

      await expect(saving).rejects.toBeInstanceOf(TabNotFoundError)
      expect(tickets.allTickets()).toEqual([])
    })

    it('clears a logged-out state when a new query runs', async () => {
      let result: object = LOGGED_OUT
      const { tickets, onHealth } = service(fakeAcli({ search: () => result }))
      await tickets.refresh()
      result = SEARCH_OK

      expect((await tickets.saveTab({ name: 'Release', jql: 'q' })).health).toBe('ok')
      expect(onHealth).toHaveBeenLastCalledWith('ok', null)
    })

    it('reports a logged-out acli found while saving', async () => {
      const { tickets, onHealth } = service(fakeAcli({ search: LOGGED_OUT }))

      await expect(tickets.saveTab({ name: 'Release', jql: 'q' })).rejects.toThrow('acli jira auth login')

      expect(tickets.snapshot().health).toBe('loggedOut')
      expect(onHealth).toHaveBeenCalledWith('loggedOut', expect.stringContaining('acli jira auth login'))
    })

    it('rejects an edit of a tab that does not exist', async () => {
      await expect(service().tickets.saveTab({ id: 999, name: 'X', jql: 'q' })).rejects.toBeInstanceOf(TabNotFoundError)
    })
  })

  it('lists the tickets of all tabs once each', async () => {
    const { tickets, tabs } = service()
    tabs.insert('Same query', 'my jql')
    await tickets.refresh()

    expect(tickets.allTickets().map((ticket) => ticket.key)).toEqual(['ABC-12', 'ABC-40', 'ABC-77'])
  })

  it('reads one ticket with its description', async () => {
    const { tickets, acli } = service(fakeAcli({ view: { stdout: JSON.stringify(viewFixture) } }))

    expect(await tickets.ticket('ABC-12')).toMatchObject({ key: 'ABC-12', description: expect.stringContaining('password reset') })
    expect(acli.calls[0]!.slice(0, 4)).toEqual(['jira', 'workitem', 'view', 'ABC-12'])
  })

  it('reuses a ticket read within the cache window', async () => {
    let clock = 1_000
    const acli = fakeAcli({ view: { stdout: JSON.stringify(viewFixture) } })
    const { tickets } = service(acli, vi.fn(), () => clock)

    await tickets.ticket('ABC-12')
    await tickets.ticket('ABC-12')
    clock += VIEW_CACHE_MS
    await tickets.ticket('ABC-12')

    expect(acli.calls.filter((args) => args[2] === 'view')).toHaveLength(2)
  })

  it('reads a ticket again after a failed read', async () => {
    let fail = true
    const acli = fakeAcli({ view: () => (fail ? { timedOut: true, exitCode: -1 } : { stdout: JSON.stringify(viewFixture) }) })
    const { tickets } = service(acli)

    await expect(tickets.ticket('ABC-12')).rejects.toMatchObject({ kind: 'timeout' })
    fail = false

    expect(await tickets.ticket('ABC-12')).toMatchObject({ key: 'ABC-12' })
  })

  it('reports a stored logged-out state again after a plugin reload', async () => {
    const acli = fakeAcli({ search: LOGGED_OUT })
    const { db } = service(acli)
    await service(acli, vi.fn(), () => 1, db).tickets.refresh()
    const onHealth = vi.fn()

    await service(acli, onHealth, () => 2, db).tickets.refresh()

    expect(onHealth).toHaveBeenCalledWith('loggedOut', expect.stringContaining('acli jira auth login'))
  })

  it('reads the site once for parallel reads, and again after a logout', async () => {
    let search: object = SEARCH_OK
    const acli = fakeAcli({
      search: () => search,
      view: { stdout: JSON.stringify(viewFixture) },
      auth: { stdout: readFileSync(new URL('./fixtures/auth-status.txt', import.meta.url), 'utf8') },
    })
    const { tickets } = service(acli)
    const authCalls = () => acli.calls.filter((args) => args[1] === 'auth').length

    await Promise.all([tickets.refresh(), tickets.ticket('ABC-12')])
    expect(authCalls()).toBe(1)

    search = LOGGED_OUT
    await tickets.refresh()
    search = SEARCH_OK
    await tickets.refresh()
    expect(authCalls()).toBe(2)
  })

  it('rejects text that is not a key without calling acli', async () => {
    const { tickets, acli } = service()

    await expect(tickets.ticket('--web')).rejects.toBeInstanceOf(InvalidKeyError)
    expect(acli.calls).toHaveLength(0)
  })

  it('rejects an unknown ticket as not found', async () => {
    const { tickets } = service(fakeAcli({ view: { exitCode: 1, stderr: 'Work item NOPE-1 does not exist' } }))

    await expect(tickets.ticket('NOPE-1')).rejects.toMatchObject({ kind: 'notFound' })
  })
})
