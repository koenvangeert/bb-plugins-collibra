export interface MergedPullRequest {
  repo: string
  number: number
  author: string
  createdAt: number
  mergedAt: number
  isBetty: boolean
  reviewerComments: number
}
