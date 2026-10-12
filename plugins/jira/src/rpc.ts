import { defineRpcContract } from '@get-bb/plugin-sdk'
import { z } from 'zod'
import { EMPTY_VALUE, FIELD_IDS, SEARCHABLE_FIELD_IDS, type Filter } from './filterFields'
import { isQuotedLiteral } from './filterJql'
import type { SavedPullRequest, ThreadLinks } from './threadLinks'
import { buildPrompt, isTicketKey } from './tickets'
import type { FiltersInput, TabInput, TicketService, TicketSnapshot } from './ticketService'

const ticket = z.object({
  key: z.string(),
  summary: z.string(),
  status: z.string(),
  statusCategory: z.string(),
  issueType: z.string(),
  url: z.string(),
})

const filterValue = z.object({
  label: z.string(),
  jql: z.string().refine((jql) => jql === EMPTY_VALUE.jql || isQuotedLiteral(jql), 'Not a quoted JQL value.'),
})

const filter: z.ZodType<Filter> = z.object({
  field: z.enum(FIELD_IDS),
  label: z.string().min(1),
  operator: z.enum(['in', 'not in']),
  values: z.array(filterValue).min(1),
})

const pullRequest: z.ZodType<SavedPullRequest> = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url({ protocol: /^https?$/ }),
  state: z.enum(['closed', 'draft', 'merged', 'open']),
})

const linkedThread = z.object({ threadId: z.string(), title: z.string(), archived: z.boolean(), pullRequest: pullRequest.nullable() })

const tab = z.object({
  id: z.number(),
  name: z.string(),
  jql: z.string(),
  filters: z.array(filter),
  tickets: z.array(ticket.extend({ threads: z.array(linkedThread) })),
  refreshedAt: z.number().nullable(),
  error: z.string().nullable(),
  limitReached: z.boolean(),
  fieldValues: z.partialRecord(z.enum(SEARCHABLE_FIELD_IDS), z.array(filterValue)),
  valuesLimitReached: z.boolean(),
})

const ticketList = z.object({
  tabs: z.array(tab),
  health: z.enum(['ok', 'missing', 'loggedOut']),
  refreshing: z.boolean(),
})

const tabId = z.number().int().positive()

const threadLink = z.object({ issueKey: z.string().nullable(), ticket: ticket.nullable(), error: z.string().nullable() })

const threadInput = z.object({ threadId: z.string().min(1) }).strict()

const ticketKey = z.string().trim().toUpperCase().refine(isTicketKey, 'Not a Jira key. Use the form ABC-123.')

export type TicketList = z.infer<typeof ticketList>
export type TicketTab = z.infer<typeof tab>
export type ThreadLinkResult = z.infer<typeof threadLink>

export const rpcContract = defineRpcContract({
  tickets: { input: z.null(), output: ticketList },
  refresh: { input: z.null(), output: ticketList },
  saveTab: {
    input: z.object({ id: tabId.optional(), name: z.string().trim().min(1), jql: z.string().trim().min(1) }).strict(),
    output: ticketList,
  },
  deleteTab: { input: z.object({ id: tabId }).strict(), output: ticketList },
  setFilters: { input: z.object({ id: tabId, filters: z.array(filter) }).strict(), output: ticketList },
  pickerTickets: { input: z.null(), output: z.array(ticket) },
  ticket: {
    input: z.object({ key: ticketKey }).strict(),
    output: ticket.extend({ prompt: z.string() }),
  },
  threadLink: { input: threadInput, output: threadLink },
  link: { input: z.object({ threadId: z.string().min(1), key: ticketKey }).strict(), output: threadLink },
  unlink: { input: threadInput, output: z.object({ ok: z.literal(true) }) },
  savePullRequest: {
    input: z.object({ threadId: z.string().min(1), pullRequest }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  projects: { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string() })) },
  startThread: {
    input: z.object({ projectId: z.string().min(1), key: ticketKey, prompt: z.string().trim().min(1) }).strict(),
    output: z.object({ threadId: z.string() }),
  },
})

export function createRpcHandlers(deps: {
  tickets: TicketService
  links: ThreadLinks
  listProjects(): Promise<{ id: string; name: string }[]>
}) {
  const { tickets, links, listProjects } = deps

  const withThreads = async (snapshot: TicketSnapshot): Promise<TicketList> => {
    const byKey = await links.linkedThreads(new Set(snapshot.tabs.flatMap((entry) => entry.tickets.map(({ key }) => key))))
    return {
      ...snapshot,
      tabs: snapshot.tabs.map((entry) => ({
        ...entry,
        tickets: entry.tickets.map((row) => ({ ...row, threads: byKey[row.key] ?? [] })),
      })),
    }
  }

  return {
    tickets: () => withThreads(tickets.snapshot()),
    refresh: async () => withThreads(await tickets.refresh()),
    saveTab: async (input: TabInput) => withThreads(await tickets.saveTab(input)),
    deleteTab: ({ id }: { id: number }) => withThreads(tickets.deleteTab(id)),
    setFilters: async (input: FiltersInput) => withThreads(await tickets.setFilters(input)),
    pickerTickets: async () => tickets.allTickets(),
    ticket: async ({ key }: { key: string }) => {
      const { description, ...detail } = await tickets.ticket(key)
      return { ...detail, prompt: buildPrompt({ ...detail, description }) }
    },
    threadLink: ({ threadId }: { threadId: string }) => links.threadLink(threadId),
    link: ({ threadId, key }: { threadId: string; key: string }) => links.link(threadId, key),
    unlink: async ({ threadId }: { threadId: string }) => {
      await links.unlink(threadId)
      return { ok: true as const }
    },
    savePullRequest: async ({ threadId, pullRequest }: { threadId: string; pullRequest: SavedPullRequest }) => {
      links.savePullRequest(threadId, pullRequest)
      return { ok: true as const }
    },
    projects: async () => (await listProjects()).map(({ id, name }) => ({ id, name })),
    startThread: ({ projectId, key, prompt }: { projectId: string; key: string; prompt: string }) =>
      links.startThread(projectId, key, prompt),
  }
}
