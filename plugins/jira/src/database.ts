/** The subset of better-sqlite3 that node:sqlite also implements, so tests need no native build. */
export interface SqlDatabase {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

/** Append-only: `bb.storage.migrate` keys each statement by its position. */
export const MIGRATIONS = [
  `CREATE TABLE tickets (
    key TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    status_category TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    url TEXT NOT NULL,
    position INTEGER NOT NULL
  )`,
  `CREATE TABLE refresh_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    refreshed_at REAL,
    error TEXT,
    health TEXT NOT NULL,
    limit_reached INTEGER NOT NULL
  )`,
  `CREATE TABLE thread_links (
    thread_id TEXT PRIMARY KEY,
    issue_key TEXT NOT NULL
  )`,
  `CREATE INDEX thread_links_issue_key ON thread_links (issue_key)`,
  `DROP TABLE tickets`,
  `CREATE TABLE tabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    jql TEXT NOT NULL
  )`,
  `CREATE TABLE tab_tickets (
    tab_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    status_category TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    url TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (tab_id, key)
  )`,
  `CREATE TABLE tab_state (
    tab_id INTEGER PRIMARY KEY,
    refreshed_at REAL,
    error TEXT,
    limit_reached INTEGER NOT NULL
  )`,
  `CREATE TABLE tab_seed (id INTEGER PRIMARY KEY CHECK (id = 1))`,
  `ALTER TABLE tabs ADD COLUMN filters TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE tab_state ADD COLUMN field_values TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE tab_state ADD COLUMN values_limit_reached INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS tickets (
    key TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    status_category TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    url TEXT NOT NULL,
    position INTEGER NOT NULL
  )`,
  `CREATE TABLE thread_pull_requests (
    thread_id TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    state TEXT NOT NULL
  )`,
]

export function inTransaction<T>(db: SqlDatabase, work: () => T): T {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // SQLite already rolled back on its own (for example SQLITE_FULL); keep the original error.
    }
    throw error
  }
}
