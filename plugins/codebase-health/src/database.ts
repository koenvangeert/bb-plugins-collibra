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
  `CREATE TABLE pull_requests (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    merged_at INTEGER NOT NULL,
    is_betty INTEGER NOT NULL,
    reviewer_comments INTEGER NOT NULL,
    PRIMARY KEY (repo, number)
  )`,
  `CREATE INDEX pull_requests_merged_at ON pull_requests (merged_at)`,
  `CREATE TABLE synced_days (
    repo TEXT NOT NULL,
    utc_day TEXT NOT NULL,
    PRIMARY KEY (repo, utc_day)
  )`,
  `ALTER TABLE pull_requests ADD COLUMN author TEXT NOT NULL DEFAULT ''`,
  // Rows stored before the author column have no author, so every day is read again.
  `DELETE FROM synced_days`,
  `CREATE TABLE team_members (
    repo TEXT NOT NULL,
    team TEXT NOT NULL,
    login TEXT NOT NULL,
    PRIMARY KEY (repo, team, login)
  )`,
]
