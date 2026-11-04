import { z } from 'zod'
import type { AuthState } from './state'

export interface SqlDatabase {
  prepare(sql: string): {
    run(...params: string[]): unknown
    get(...params: string[]): unknown
  }
}

export const MIGRATIONS = [
  `CREATE TABLE auth_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL
  )`,
  // Unused, but a prototype already applied it to the shared plugin database at this index.
  `CREATE TABLE client_registrations (
    base_url TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    client_id TEXT NOT NULL,
    PRIMARY KEY (base_url, redirect_uri)
  )`,
  `CREATE TABLE watched_runs (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL
  )`,
]

const tokens = z.object({ accessToken: z.string(), refreshToken: z.string().nullable(), expiresAt: z.number() })

const authState: z.ZodType<AuthState> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('signed-out') }),
  z.object({ kind: z.literal('signed-in'), baseUrl: z.string(), clientId: z.string(), tokens }),
  z.object({ kind: z.literal('expired'), baseUrl: z.string() }),
])

const stateRow = z.object({ state: z.string() })

export type AuthStore = ReturnType<typeof createAuthStore>

export function createAuthStore(db: SqlDatabase) {
  return {
    state(): AuthState {
      const row = stateRow.safeParse(db.prepare('SELECT state FROM auth_state WHERE id = 1').get())
      if (!row.success) return { kind: 'signed-out' }
      const saved = authState.safeParse(JSON.parse(row.data.state))
      return saved.success ? saved.data : { kind: 'signed-out' }
    },
    save(state: AuthState) {
      db.prepare('INSERT INTO auth_state (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state').run(
        JSON.stringify(state),
      )
    },
  }
}
