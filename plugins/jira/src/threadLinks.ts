import { inTransaction, type SqlDatabase } from './database'
import { errorMessage } from './errorMessage'
import { InvalidKeyError, isTicketKey, type Ticket } from './tickets'
import type { TicketService } from './ticketService'

type PermissionMode = 'accept-edits' | 'auto' | 'full'

export interface ThreadLinkSdk {
  projects: {
    defaultExecutionOptions(args: { projectId: string }): Promise<{ permissionMode: PermissionMode } | null>
  }
  threads: {
    get(args: { threadId: string }): Promise<{
      id: string
      title: string | null
      titleFallback: string | null
      archivedAt: number | null
      deletedAt: number | null
    }>
    getPluginMetadata(args: { threadId: string }): Promise<Record<string, unknown>>
    updatePluginMetadata(args: { threadId: string; set?: Record<string, string>; remove?: string[] }): Promise<unknown>
    spawn(args: {
      projectId: string
      environment: { type: 'project-default' }
      prompt: string
      title: string
      pluginMetadata: { issueKey: string }
      permissionMode: PermissionMode
      executionInputSources: { permissionMode: 'explicit' }
    }): Promise<{ id: string }>
  }
}

export interface ThreadLink {
  issueKey: string | null
  ticket: Ticket | null
  error: string | null
}

export interface SavedPullRequest {
  number: number
  title: string
  url: string
  state: 'closed' | 'draft' | 'merged' | 'open'
}

export interface LinkedThread {
  threadId: string
  title: string
  archived: boolean
  pullRequest: SavedPullRequest | null
}

export function createThreadLinks(options: { db: SqlDatabase; sdk: ThreadLinkSdk; tickets: TicketService }) {
  const { db, sdk, tickets } = options

  const cachedTicket = (key: string) => tickets.allTickets().find((ticket) => ticket.key === key) ?? null

  const resolveTicket = async (key: string): Promise<Ticket> => cachedTicket(key) ?? (await tickets.ticket(key))

  const index = (threadId: string, issueKey: string) =>
    db
      .prepare(
        'INSERT INTO thread_links (thread_id, issue_key) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET issue_key = excluded.issue_key',
      )
      .run(threadId, issueKey)

  const unindex = (threadId: string) => db.prepare('DELETE FROM thread_links WHERE thread_id = ?').run(threadId)

  const unindexIfStill = (threadId: string, issueKey: string) =>
    db.prepare('DELETE FROM thread_links WHERE thread_id = ? AND issue_key = ?').run(threadId, issueKey)

  const reindexIfStill = (threadId: string, issueKey: string, current: string | null) =>
    current
      ? db.prepare('UPDATE thread_links SET issue_key = ? WHERE thread_id = ? AND issue_key = ?').run(current, threadId, issueKey)
      : unindexIfStill(threadId, issueKey)

  const linkedKey = async (threadId: string): Promise<string | null> => {
    const { issueKey } = await sdk.threads.getPluginMetadata({ threadId })
    return typeof issueKey === 'string' && isTicketKey(issueKey) ? issueKey : null
  }

  return {
    async threadLink(threadId: string): Promise<ThreadLink> {
      const issueKey = await linkedKey(threadId)
      if (!issueKey) return { issueKey: null, ticket: null, error: null }
      try {
        return { issueKey, ticket: await resolveTicket(issueKey), error: null }
      } catch (error) {
        return { issueKey, ticket: null, error: errorMessage(error) }
      }
    },

    async link(threadId: string, rawKey: string): Promise<ThreadLink> {
      const issueKey = rawKey.trim().toUpperCase()
      if (!isTicketKey(issueKey)) throw new InvalidKeyError(rawKey)
      const ticket = await resolveTicket(issueKey)
      await sdk.threads.updatePluginMetadata({ threadId, set: { issueKey } })
      index(threadId, issueKey)
      return { issueKey, ticket, error: null }
    },

    async inheritLink(thread: { id: string; parentThreadId: string | null }): Promise<void> {
      if (!thread.parentThreadId) return
      const issueKey = await linkedKey(thread.parentThreadId)
      if (!issueKey || (await linkedKey(thread.id))) return
      await sdk.threads.updatePluginMetadata({ threadId: thread.id, set: { issueKey } })
      index(thread.id, issueKey)
    },

    async unlink(threadId: string): Promise<void> {
      await sdk.threads.updatePluginMetadata({ threadId, remove: ['issueKey'] })
      unindex(threadId)
    },

    async startThread(projectId: string, issueKey: string, prompt: string): Promise<{ threadId: string }> {
      if (!isTicketKey(issueKey)) throw new InvalidKeyError(issueKey)
      const ticket = await resolveTicket(issueKey)
      const defaults = await sdk.projects.defaultExecutionOptions({ projectId })
      const thread = await sdk.threads.spawn({
        projectId,
        environment: { type: 'project-default' },
        prompt,
        title: `${issueKey}: ${ticket.summary}`,
        pluginMetadata: { issueKey },
        permissionMode: defaults?.permissionMode ?? 'full',
        executionInputSources: { permissionMode: 'explicit' },
      })
      index(thread.id, issueKey)
      return { threadId: thread.id }
    },

    async linkedThreads(keys: ReadonlySet<string>): Promise<Record<string, LinkedThread[]>> {
      const rows = (
        db
          .prepare(
            `SELECT l.thread_id, l.issue_key, p.number, p.title, p.url, p.state
             FROM thread_links l LEFT JOIN thread_pull_requests p ON p.thread_id = l.thread_id
             ORDER BY l.rowid`,
          )
          .all() as ({ thread_id: string; issue_key: string } & (SavedPullRequest | NullFields<SavedPullRequest>))[]
      ).filter((row) => keys.has(row.issue_key))
      const resolved = await Promise.all(
        rows.map(async (row) => {
          try {
            const thread = await sdk.threads.get({ threadId: row.thread_id })
            if (thread.deletedAt !== null) return void unindexIfStill(row.thread_id, row.issue_key)
            const current = await linkedKey(row.thread_id)
            if (current !== row.issue_key) return void reindexIfStill(row.thread_id, row.issue_key, current)
            const pullRequest = row.number === null ? null : { number: row.number, title: row.title, url: row.url, state: row.state }
            return { issueKey: row.issue_key, thread: toLinkedThread(thread, pullRequest) }
          } catch {
            return undefined
          }
        }),
      )
      const byKey: Record<string, LinkedThread[]> = {}
      for (const entry of resolved) if (entry) (byKey[entry.issueKey] ??= []).push(entry.thread)
      return byKey
    },

    savePullRequest(threadId: string, { number, title, url, state }: SavedPullRequest): void {
      db.prepare(
        `INSERT INTO thread_pull_requests (thread_id, number, title, url, state) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET number = excluded.number, title = excluded.title, url = excluded.url, state = excluded.state`,
      ).run(threadId, number, title, url, state)
    },

    onThreadDeleted(threadId: string): void {
      inTransaction(db, () => {
        unindex(threadId)
        db.prepare('DELETE FROM thread_pull_requests WHERE thread_id = ?').run(threadId)
      })
    },
  }
}

export type ThreadLinks = ReturnType<typeof createThreadLinks>

type NullFields<T> = { [K in keyof T]: null }

function toLinkedThread(
  thread: { id: string; title: string | null; titleFallback: string | null; archivedAt: number | null },
  pullRequest: SavedPullRequest | null,
): LinkedThread {
  return { threadId: thread.id, title: threadTitle(thread.title, thread.titleFallback), archived: thread.archivedAt !== null, pullRequest }
}

function threadTitle(title: string | null, fallback: string | null): string {
  const firstLine = (title ?? fallback ?? '').split('\n', 1)[0]!.trim()
  if (firstLine.length === 0) return 'Untitled thread'
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
}

