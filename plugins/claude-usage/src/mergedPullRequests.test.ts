import { describe, expect, it, vi } from 'vitest'
import type { DailySpend } from './dashboard'
import {
  createGhMergedPullRequestLoader,
  createMergedPullRequestCache,
  MERGED_PULL_REQUESTS_TTL_MS,
  mergedSearchArgs,
  parseMergedAt,
  withMergedPullRequests,
  type ExecFile,
} from './mergedPullRequests'

const GH_OUTPUT = JSON.stringify([
  { closedAt: '2026-11-23T16:22:52Z' },
  { closedAt: '2026-11-23T15:47:24Z' },
  { closedAt: '2026-11-21T09:00:00Z' },
])

function day(name: string): DailySpend {
  return { day: name, total: 0, breakdown: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, mergedPullRequests: 0 }
}

function localNoon(name: string): number {
  const [year, month, dayOfMonth] = name.split('-').map(Number)
  return new Date(year!, month! - 1, dayOfMonth!, 12).getTime()
}

describe('gh search', () => {
  it('asks for my merged pull requests from the UTC day before the first local day', () => {
    expect(mergedSearchArgs('2026-11-01')).toEqual([
      'search',
      'prs',
      '--author=@me',
      '--merged',
      '--merged-at=>=2026-10-31',
      '--limit',
      '1000',
      '--json',
      'closedAt',
    ])
  })

  it('reads each merge time from the JSON gh prints', () => {
    expect(parseMergedAt(GH_OUTPUT)).toEqual([
      Date.parse('2026-11-23T16:22:52Z'),
      Date.parse('2026-11-23T15:47:24Z'),
      Date.parse('2026-11-21T09:00:00Z'),
    ])
  })

  it('runs gh and resolves the merge times', async () => {
    const execFile = vi.fn<ExecFile>((_file, _args, _options, callback) => callback(null, GH_OUTPUT, ''))

    const mergedAt = await createGhMergedPullRequestLoader(execFile)('2026-11-01')

    expect(execFile.mock.calls[0]![0]).toBe('gh')
    expect(mergedAt).toHaveLength(3)
  })

  it('rejects with what gh printed when it fails', async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) =>
      callback(new Error('exit 1'), '', 'gh: not logged in\n')

    await expect(createGhMergedPullRequestLoader(execFile)('2026-11-01')).rejects.toThrow('gh: not logged in')
  })
})

describe('withMergedPullRequests', () => {
  it('counts merges per local day and zero on days without any', () => {
    const merged = [localNoon('2026-11-23'), localNoon('2026-11-23'), localNoon('2026-11-21')]

    const series = withMergedPullRequests([day('2026-11-21'), day('2026-11-22'), day('2026-11-23')], merged)

    expect(series.map((entry) => entry.mergedPullRequests)).toEqual([1, 0, 2])
  })

  it('leaves the series alone when GitHub could not be read', () => {
    const series = [day('2026-11-23')]

    expect(withMergedPullRequests(series, null)).toBe(series)
  })
})

describe('createMergedPullRequestCache', () => {
  function cacheWith(load: (sinceDay: string) => Promise<number[]>) {
    let now = 0
    const onError = vi.fn()
    const cache = createMergedPullRequestCache({ load, now: () => now, onError })
    return { cache, onError, advance: (ms: number) => (now += ms) }
  }

  it('answers null at once while the first load runs, then the merge times', async () => {
    const { cache } = cacheWith(async () => [1, 2])

    expect(cache.mergedSince('2026-11-01')).toBeNull()
    await vi.waitFor(() => expect(cache.mergedSince('2026-11-01')).toEqual([1, 2]))
  })

  it('reuses a fresh answer that covers the range', async () => {
    const load = vi.fn(async () => [1])
    const { cache } = cacheWith(load)
    cache.mergedSince('2026-11-01')
    await vi.waitFor(() => expect(cache.mergedSince('2026-11-01')).toEqual([1]))

    cache.mergedSince('2026-11-05')

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps the narrower answer while it loads a range that reaches further back', async () => {
    const load = vi.fn(async (sinceDay: string) => (sinceDay === '2026-10-01' ? [1, 2] : [2]))
    const { cache } = cacheWith(load)
    cache.mergedSince('2026-11-01')
    await vi.waitFor(() => expect(cache.mergedSince('2026-11-01')).toEqual([2]))

    expect(cache.mergedSince('2026-10-01')).toEqual([2])
    await vi.waitFor(() => expect(cache.mergedSince('2026-10-01')).toEqual([1, 2]))
  })

  it('serves a stale answer and refreshes it behind the read', async () => {
    const load = vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([1, 2])
    const { cache, advance } = cacheWith(load)
    cache.mergedSince('2026-11-01')
    await vi.waitFor(() => expect(cache.mergedSince('2026-11-01')).toEqual([1]))
    advance(MERGED_PULL_REQUESTS_TTL_MS)

    expect(cache.mergedSince('2026-11-01')).toEqual([1])
    await vi.waitFor(() => expect(cache.mergedSince('2026-11-01')).toEqual([1, 2]))
  })

  it('stays null and logs when gh fails, without retrying before the cache expires', async () => {
    const load = vi.fn(async () => {
      throw new Error('gh: not logged in')
    })
    const { cache, onError } = cacheWith(load)

    cache.mergedSince('2026-11-01')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('failed to read merged pull requests', expect.any(Error)))
    expect(cache.mergedSince('2026-11-01')).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps the last answer when a refresh fails', async () => {
    const load = vi.fn().mockResolvedValueOnce([1]).mockRejectedValueOnce(new Error('rate limited'))
    const { cache, onError, advance } = cacheWith(load)
    cache.mergedSince('2026-11-01')
    await vi.waitFor(() => expect(cache.mergedSince('2026-11-01')).toEqual([1]))
    advance(MERGED_PULL_REQUESTS_TTL_MS)

    cache.mergedSince('2026-11-01')
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())

    expect(cache.mergedSince('2026-11-01')).toEqual([1])
    expect(load).toHaveBeenCalledTimes(2)
  })
})
