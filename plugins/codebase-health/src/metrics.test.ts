import { describe, expect, it } from 'vitest'
import { buildMetrics, workHoursBetween } from './metrics'
import type { MergedPullRequest } from './pullRequest'

const NOW = new Date(2026, 10, 25, 15, 0).getTime()
const HOUR = 3_600_000

function pr(overrides: Partial<MergedPullRequest>): MergedPullRequest {
  const mergedAt = overrides.mergedAt ?? NOW - HOUR
  return { repo: 'a/b', number: 1, author: 'dev', createdAt: mergedAt - 2 * HOUR, mergedAt, isBetty: false, reviewerComments: 0, ...overrides }
}

describe('workHoursBetween', () => {
  it('leaves the weekend out of a pull request opened on Friday and merged on Monday', () => {
    expect(workHoursBetween(new Date(2026, 10, 20, 16).getTime(), new Date(2026, 10, 23, 10).getTime())).toBe(18)
  })

  it('counts nothing for a pull request opened and merged on one weekend', () => {
    expect(workHoursBetween(new Date(2026, 10, 21, 9).getTime(), new Date(2026, 10, 22, 18).getTime())).toBe(0)
  })

  it('counts plain hours within a work week', () => {
    expect(workHoursBetween(new Date(2026, 10, 23, 9).getTime(), new Date(2026, 10, 24, 11).getTime())).toBe(26)
  })
})

describe('buildMetrics', () => {
  it('gives each local work day its BETTY and other merges with its mean reviewer comments and median time to merge, oldest day first', () => {
    const metrics = buildMetrics(
      [
        pr({ mergedAt: new Date(2026, 10, 25, 0, 30).getTime(), isBetty: true, reviewerComments: 5 }),
        pr({ mergedAt: new Date(2026, 10, 25, 9).getTime(), reviewerComments: 2 }),
        pr({ mergedAt: new Date(2026, 10, 23, 23, 59).getTime(), reviewerComments: 1 }),
      ],
      NOW,
      7,
    )

    expect(metrics.daily.map((entry) => entry.day)).toEqual([
      '2026-11-19',
      '2026-11-20',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
    ])
    expect(metrics.daily.slice(-3).map(({ rolling: _rolling, ...figures }) => figures)).toEqual([
      { day: '2026-11-23', betty: 0, other: 1, avgReviewerComments: 1, medianHoursToMerge: 2 },
      { day: '2026-11-24', betty: 0, other: 0, avgReviewerComments: null, medianHoursToMerge: null },
      { day: '2026-11-25', betty: 1, other: 1, avgReviewerComments: 3.5, medianHoursToMerge: 2 },
    ])
    expect(metrics.mergedPerDay).toBeCloseTo(3 / 5)
  })

  it('gives the median time to merge of a day, not the mean', () => {
    const at = new Date(2026, 10, 25, 12).getTime()
    const metrics = buildMetrics(
      [1, 2, 9].map((hours, number) => pr({ number, mergedAt: at, createdAt: at - hours * HOUR })),
      NOW,
      7,
    )

    expect(metrics.daily.at(-1)!.medianHoursToMerge).toBe(2)
  })

  it('averages each day over the last five work days, from the pull requests of those days', () => {
    const on = (date: number, hours: number) => new Date(2026, 10, date, 12 + hours).getTime()
    const metrics = buildMetrics(
      [
        pr({ number: 1, mergedAt: on(18, 0), reviewerComments: 9, isBetty: true }),
        pr({ number: 2, mergedAt: on(19, 0), reviewerComments: 1 }),
        pr({ number: 3, mergedAt: on(19, 1), reviewerComments: 1 }),
        pr({ number: 4, mergedAt: on(25, 0), reviewerComments: 4, isBetty: true }),
      ],
      NOW,
      7,
    )
    const rolling = (day: string) => metrics.daily.find((entry) => entry.day === day)!.rolling

    expect(rolling('2026-11-19')).toEqual({ mergedPerDay: 3 / 5, avgReviewerComments: 11 / 3, medianHoursToMerge: 2, bettyShare: 1 / 3 })
    expect(rolling('2026-11-24')).toEqual(rolling('2026-11-19'))
    expect(rolling('2026-11-25')).toEqual({ mergedPerDay: 3 / 5, avgReviewerComments: 2, medianHoursToMerge: 2, bettyShare: 1 / 3 })
    expect(metrics.all.merged).toBe(3)
  })

  it('leaves weekends out of the chart but keeps their merges in the totals', () => {
    const metrics = buildMetrics([pr({ mergedAt: new Date(2026, 10, 22, 11).getTime() })], NOW, 7)

    expect(metrics.daily.every((entry) => entry.betty + entry.other === 0)).toBe(true)
    expect(metrics.all.merged).toBe(1)
    expect(metrics.mergedPerDay).toBeCloseTo(1 / 5)
  })

  it('leaves out merges before the first day of the window', () => {
    const metrics = buildMetrics([pr({ mergedAt: new Date(2026, 10, 18, 23).getTime() })], NOW, 7)

    expect(metrics.all.merged).toBe(0)
  })

  it('compares BETTY with other pull requests on comments and time to merge', () => {
    const metrics = buildMetrics(
      [
        pr({ isBetty: true, reviewerComments: 6, createdAt: NOW - 11 * HOUR }),
        pr({ isBetty: false, reviewerComments: 1, createdAt: NOW - 2 * HOUR }),
        pr({ isBetty: false, reviewerComments: 2, createdAt: NOW - 4 * HOUR }),
        pr({ isBetty: false, reviewerComments: 3, createdAt: NOW - 27 * HOUR }),
      ],
      NOW,
      7,
    )

    expect(metrics.bettyShare).toBe(0.25)
    expect(metrics.betty).toEqual({ merged: 1, avgReviewerComments: 6, medianHoursToMerge: 10, avgHoursToMerge: 10 })
    expect(metrics.other).toEqual({ merged: 3, avgReviewerComments: 2, medianHoursToMerge: 3, avgHoursToMerge: 10 })
    expect(metrics.all.medianHoursToMerge).toBe(6.5)
  })

  it('reports no figure instead of zero when nothing merged', () => {
    const metrics = buildMetrics([], NOW, 7)

    expect(metrics.bettyShare).toBeNull()
    expect(metrics.all).toEqual({ merged: 0, avgReviewerComments: null, medianHoursToMerge: null, avgHoursToMerge: null })
  })
})
