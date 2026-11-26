import { isNotFound, type Gh } from './gh'

/** The places GitHub looks for CODEOWNERS, in its own order. */
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']

export interface TeamMember {
  team: string
  login: string
}

export function codeOwnerTeams(codeowners: string): string[] {
  const teams = new Set<string>()
  for (const line of codeowners.split('\n')) {
    for (const match of line.replace(/#.*/, '').matchAll(/@([\w.-]+\/[\w.-]+)/g)) teams.add(match[1]!)
  }
  return [...teams].sort()
}

async function readCodeowners(gh: Gh, repo: string, signal?: AbortSignal): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      return await gh(['api', `repos/${repo}/contents/${path}`, '-H', 'Accept: application/vnd.github.raw'], signal)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  return null
}

/** A team is a GitHub team named in the repository's CODEOWNERS. A team gh cannot see is left out. */
export async function fetchTeamMembers(gh: Gh, repo: string, signal?: AbortSignal): Promise<TeamMember[]> {
  const codeowners = await readCodeowners(gh, repo, signal)
  if (codeowners === null) return []
  const members: TeamMember[] = []
  for (const team of codeOwnerTeams(codeowners)) {
    const [org, slug] = team.split('/')
    try {
      const logins = await gh(['api', `orgs/${org}/teams/${slug}/members`, '--paginate', '--jq', '.[].login'], signal)
      members.push(...logins.split('\n').filter(Boolean).map((login) => ({ team, login })))
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  return members
}
