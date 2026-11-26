import { z } from 'zod'
import type { Gh } from './gh'
import type { MergedPullRequest } from './pullRequest'

export const BETTY_LABEL = 'betty-pr-factory-app'
/** Service accounts that GitHub types as `User`, so the `Bot` check misses them. */
const SERVICE_ACCOUNTS = new Set(['collibra-cicd'])
/** GitHub search returns at most 1000 results per query, however many pages you read. */
const SEARCH_RESULT_CAP = 1000

export const PULL_REQUEST_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        createdAt
        mergedAt
        author { login }
        labels(first: 30) { nodes { name } }
        comments(first: 100) { nodes { author { __typename login } } }
        reviews(first: 100) { nodes { author { __typename login } body comments { totalCount } } }
      }
    }
  }
}`

const commenter = z.object({ __typename: z.string(), login: z.string() }).nullable()

const pullRequestNode = z.object({
  number: z.number(),
  createdAt: z.string(),
  mergedAt: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  comments: z.object({ nodes: z.array(z.object({ author: commenter })) }),
  reviews: z.object({
    nodes: z.array(z.object({ author: commenter, body: z.string(), comments: z.object({ totalCount: z.number() }) })),
  }),
})

const searchPage = z.object({
  data: z.object({
    search: z.object({
      issueCount: z.number(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(pullRequestNode),
    }),
  }),
})

export type SearchPage = z.infer<typeof searchPage>['data']['search']
type PullRequestNode = z.infer<typeof pullRequestNode>

/** Bots and the author's own replies (BETTY posts its reviews as the author) are not review feedback. */
export function reviewerComments(node: PullRequestNode): number {
  const prAuthor = node.author?.login
  const byReviewer = (author: z.infer<typeof commenter>) =>
    author !== null &&
    author.__typename !== 'Bot' &&
    !SERVICE_ACCOUNTS.has(author.login) &&
    author.login !== prAuthor
  const conversation = node.comments.nodes.filter((comment) => byReviewer(comment.author)).length
  const reviews = node.reviews.nodes
    .filter((review) => byReviewer(review.author))
    .reduce((sum, review) => sum + (review.body.trim() ? 1 : 0) + review.comments.totalCount, 0)
  return conversation + reviews
}

export function toMergedPullRequest(repo: string, node: PullRequestNode): MergedPullRequest {
  return {
    repo,
    number: node.number,
    author: node.author?.login ?? '',
    createdAt: Date.parse(node.createdAt),
    mergedAt: Date.parse(node.mergedAt),
    isBetty: node.labels.nodes.some((label) => label.name === BETTY_LABEL),
    reviewerComments: reviewerComments(node),
  }
}

export function parseSearchPage(stdout: string): SearchPage {
  return searchPage.parse(JSON.parse(stdout)).data.search
}

export function searchQuery(repo: string, utcDay: string): string {
  return `repo:${repo} is:pr is:merged merged:${utcDay}`
}

export type ReadSearchPage = (query: string, after: string | null, signal?: AbortSignal) => Promise<SearchPage>

export async function fetchMergedOn(
  readPage: ReadSearchPage,
  repo: string,
  utcDay: string,
  signal?: AbortSignal,
): Promise<MergedPullRequest[]> {
  const merged: MergedPullRequest[] = []
  let after: string | null = null
  for (;;) {
    const page: SearchPage = await readPage(searchQuery(repo, utcDay), after, signal)
    if (page.issueCount > SEARCH_RESULT_CAP) {
      throw new Error(`${repo} merged ${page.issueCount} pull requests on ${utcDay}, more than GitHub search returns`)
    }
    merged.push(...page.nodes.map((node) => toMergedPullRequest(repo, node)))
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return merged
    after = page.pageInfo.endCursor
  }
}

export function createGhSearchPageReader(gh: Gh): ReadSearchPage {
  return async (query, after, signal) => {
    const args = ['api', 'graphql', '-f', `query=${PULL_REQUEST_QUERY}`, '-f', `q=${query}`]
    if (after) args.push('-f', `after=${after}`)
    return parseSearchPage(await gh(args, signal))
  }
}
