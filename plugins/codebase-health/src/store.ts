import type { SqlDatabase } from './database'
import type { MergedPullRequest } from './pullRequest'
import type { TeamMember } from './teams'

export function savePullRequests(db: SqlDatabase, pullRequests: readonly MergedPullRequest[]): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO pull_requests (repo, number, author, created_at, merged_at, is_betty, reviewer_comments)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const pr of pullRequests) {
    insert.run(pr.repo, pr.number, pr.author, pr.createdAt, pr.mergedAt, pr.isBetty ? 1 : 0, pr.reviewerComments)
  }
}

export function markDaySynced(db: SqlDatabase, repo: string, utcDay: string): void {
  db.prepare('INSERT OR IGNORE INTO synced_days (repo, utc_day) VALUES (?, ?)').run(repo, utcDay)
}

export function syncedDays(db: SqlDatabase, repo: string): Set<string> {
  const rows = db.prepare('SELECT utc_day FROM synced_days WHERE repo = ?').all(repo) as { utc_day: string }[]
  return new Set(rows.map((row) => row.utc_day))
}

interface PullRequestRow {
  repo: string
  number: number
  author: string
  created_at: number
  merged_at: number
  is_betty: number
  reviewer_comments: number
}

export function pullRequestsMergedSince(
  db: SqlDatabase,
  repos: readonly string[],
  since: number,
): MergedPullRequest[] {
  if (repos.length === 0) return []
  const rows = db
    .prepare(
      `SELECT repo, number, author, created_at, merged_at, is_betty, reviewer_comments FROM pull_requests
       WHERE merged_at >= ? AND repo IN (${repos.map(() => '?').join(', ')})`,
    )
    .all(since, ...repos) as PullRequestRow[]
  return rows.map((row) => ({
    repo: row.repo,
    number: Number(row.number),
    author: row.author,
    createdAt: Number(row.created_at),
    mergedAt: Number(row.merged_at),
    isBetty: Number(row.is_betty) === 1,
    reviewerComments: Number(row.reviewer_comments),
  }))
}

export function saveTeamMembers(db: SqlDatabase, repo: string, members: readonly TeamMember[]): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM team_members WHERE repo = ?').run(repo)
    const insert = db.prepare('INSERT OR IGNORE INTO team_members (repo, team, login) VALUES (?, ?, ?)')
    for (const member of members) insert.run(repo, member.team, member.login)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function teamMembers(db: SqlDatabase, repos: readonly string[]): Map<string, Set<string>> {
  const teams = new Map<string, Set<string>>()
  if (repos.length === 0) return teams
  const rows = db
    .prepare(`SELECT team, login FROM team_members WHERE repo IN (${repos.map(() => '?').join(', ')}) ORDER BY team`)
    .all(...repos) as { team: string; login: string }[]
  for (const row of rows) teams.set(row.team, (teams.get(row.team) ?? new Set()).add(row.login))
  return teams
}
