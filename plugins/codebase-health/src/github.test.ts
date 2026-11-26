import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createGhSearchPageReader,
  fetchMergedOn,
  parseSearchPage,
  type SearchPage,
} from './github'
import { createGh, type ExecFile } from './gh'

const fixture = readFileSync(new URL('./fixtures/search-page.json', import.meta.url), 'utf8')
const page = parseSearchPage(fixture)
const node = (number: number) => structuredClone(page.nodes.find((entry) => entry.number === number)!)
const onePage = (nodes: SearchPage['nodes']): SearchPage => ({
  issueCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
})

describe('fetchMergedOn', () => {
  it('reads a real search page into merged pull requests', async () => {
    const merged = await fetchMergedOn(async () => page, 'collibra/frontend', '2026-11-24')

    expect(merged).toEqual([
      {
        repo: 'collibra/frontend',
        number: 27863,
        author: 'IpsitaCollibra',
        createdAt: Date.parse('2026-11-24T16:53:46Z'),
        mergedAt: Date.parse('2026-11-24T19:30:57Z'),
        isBetty: true,
        reviewerComments: 11,
      },
      expect.objectContaining({ number: 27852, isBetty: false, reviewerComments: 0 }),
      expect.objectContaining({ number: 27844, isBetty: true, reviewerComments: 0 }),
    ])
  })

  it('counts a reviewer conversation comment and a non-empty review summary', async () => {
    const pr = node(27852)
    pr.comments.nodes.push({ author: { __typename: 'User', login: 'maximshipko' } })
    pr.reviews.nodes.push({ author: { __typename: 'User', login: 'maximshipko' }, body: 'Looks good.', comments: { totalCount: 2 } })
    pr.reviews.nodes.push({ author: { __typename: 'User', login: 'maximshipko' }, body: '   ', comments: { totalCount: 0 } })

    const [merged] = await fetchMergedOn(async () => onePage([pr]), 'collibra/frontend', '2026-11-24')

    expect(merged!.reviewerComments).toBe(4)
  })

  it('skips comments from deleted accounts', async () => {
    const pr = node(27852)
    pr.comments.nodes.push({ author: null })

    const [merged] = await fetchMergedOn(async () => onePage([pr]), 'collibra/frontend', '2026-11-24')

    expect(merged!.reviewerComments).toBe(0)
  })

  it('searches one UTC day and follows the cursor to the last page', async () => {
    const readPage = vi.fn(async (_query: string, after: string | null) =>
      after === null
        ? { ...onePage([node(27863)]), issueCount: 2, pageInfo: { hasNextPage: true, endCursor: 'c1' } }
        : { ...onePage([node(27852)]), issueCount: 2 },
    )

    const merged = await fetchMergedOn(readPage, 'collibra/frontend', '2026-11-24')

    expect(merged.map((pr) => pr.number)).toEqual([27863, 27852])
    expect(readPage.mock.calls).toEqual([
      ['repo:collibra/frontend is:pr is:merged merged:2026-11-24', null, undefined],
      ['repo:collibra/frontend is:pr is:merged merged:2026-11-24', 'c1', undefined],
    ])
  })

  it('fails instead of undercounting a day with more results than GitHub search returns', async () => {
    const readPage = async () => ({ ...onePage([]), issueCount: 1001 })

    await expect(fetchMergedOn(readPage, 'big/repo', '2026-11-24')).rejects.toThrow(
      'big/repo merged 1001 pull requests on 2026-11-24',
    )
  })
})

describe('createGhSearchPageReader', () => {
  it('passes the cursor to gh only after the first page', async () => {
    const calls: (readonly string[])[] = []
    const execFile: ExecFile = (_file, args, _options, callback) => {
      calls.push(args)
      callback(null, fixture, '')
    }
    const read = createGhSearchPageReader(createGh(execFile))

    await read('repo:a/b', null)
    await read('repo:a/b', 'c1')

    expect(calls[0]).not.toContain('after=c1')
    expect(calls[1]!.slice(-2)).toEqual(['-f', 'after=c1'])
  })

  it('hands the abort signal to gh, so a stopped service does not wait for it', async () => {
    let received: AbortSignal | undefined
    const execFile: ExecFile = (_file, _args, options, callback) => {
      received = options.signal
      callback(null, fixture, '')
    }
    const signal = new AbortController().signal

    await createGhSearchPageReader(createGh(execFile))('repo:a/b', null, signal)

    expect(received).toBe(signal)
  })

  it('rejects with the gh error output', async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) =>
      callback(new Error('exit 1'), '', 'gh: To get started with GitHub CLI, please run: gh auth login\n')

    await expect(createGhSearchPageReader(createGh(execFile))('repo:a/b', null)).rejects.toThrow('gh auth login')
  })
})
