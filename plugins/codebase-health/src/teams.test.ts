import { describe, expect, it } from 'vitest'
import type { Gh } from './gh'
import { codeOwnerTeams, fetchTeamMembers } from './teams'

const notFound = () => Promise.reject(new Error('gh: Not Found (HTTP 404)'))

function fakeGh(routes: Record<string, string | (() => Promise<string>)>): Gh {
  return async (args) => {
    const route = routes[args[1]!]
    if (route === undefined) return notFound()
    return typeof route === 'string' ? route : route()
  }
}

describe('codeOwnerTeams', () => {
  it('lists each team once and skips comments and single users', () => {
    const codeowners = [
      '# owned by @collibra/old-team',
      '/libs/ai @collibra/ai-governance @someone',
      '/libs/dq @collibra/dq-frontend @collibra/ai-governance # also @collibra/commented',
    ].join('\n')

    expect(codeOwnerTeams(codeowners)).toEqual(['collibra/ai-governance', 'collibra/dq-frontend'])
  })
})

describe('fetchTeamMembers', () => {
  it('reads CODEOWNERS from the first place GitHub looks that has one', async () => {
    const gh = fakeGh({
      'repos/a/b/contents/CODEOWNERS': '* @org/ui',
      'orgs/org/teams/ui/members': 'ann\nbob\n',
    })

    expect(await fetchTeamMembers(gh, 'a/b')).toEqual([
      { team: 'org/ui', login: 'ann' },
      { team: 'org/ui', login: 'bob' },
    ])
  })

  it('has no teams when the repository has no CODEOWNERS', async () => {
    expect(await fetchTeamMembers(fakeGh({}), 'a/b')).toEqual([])
  })

  it('leaves out a team that gh cannot see', async () => {
    const gh = fakeGh({
      'repos/a/b/contents/.github/CODEOWNERS': '* @org/secret @org/ui',
      'orgs/org/teams/ui/members': 'ann\n',
    })

    expect(await fetchTeamMembers(gh, 'a/b')).toEqual([{ team: 'org/ui', login: 'ann' }])
  })

  it('fails on any other gh error, so the stored teams stay', async () => {
    const gh = fakeGh({
      'repos/a/b/contents/.github/CODEOWNERS': '* @org/ui',
      'orgs/org/teams/ui/members': () => Promise.reject(new Error('API rate limit exceeded (HTTP 403)')),
    })

    await expect(fetchTeamMembers(gh, 'a/b')).rejects.toThrow('rate limit')
  })
})
