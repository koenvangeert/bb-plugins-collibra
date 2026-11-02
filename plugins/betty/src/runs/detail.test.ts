import { describe, expect, it } from 'vitest'
import { fixture } from '../pesto/fakePesto'
import type { RunNode } from '../pesto/types'
import { runDetailSchema } from '../pesto/wire'
import { actionLabel, dagColumns, runCondition, spendCeilings, STEP_STATUS_STYLE } from './detail'

const { nodes } = runDetailSchema.parse(JSON.parse(fixture('dag-status.json')))
const named = (name: string) => nodes.find((node) => node.name === name)!

function step(name: string, overrides: Partial<RunNode> = {}): RunNode {
  return {
    taskId: name,
    name,
    executor: 'agent',
    status: 'pending',
    dependsOn: [],
    alwaysRun: false,
    costUsd: 0,
    budgetUsd: null,
    ...overrides,
  }
}

describe('run detail', () => {
  it('puts each step in the column of its longest path from a first step', () => {
    const columns = dagColumns(nodes).map((column) => column.map((node) => node.name))

    expect(columns).toEqual([
      ['implement', 'provision-env'],
      ['review'],
      ['remediate-review'],
      ['review-2'],
      ['publish-review', 'remediate-review-2'],
      ['build-frontend'],
      ['validate-app'],
      ['remediate-app'],
      ['build-after-fix'],
      ['revalidate-app'],
      ['lap-settled', 'reconcile-ci'],
      ['teardown-env'],
    ])
  })

  it('ignores a dependency that names no step', () => {
    const columns = dagColumns([step('b', { dependsOn: ['a', 'gone'] }), step('a')])

    expect(columns.map((column) => column.map((node) => node.name))).toEqual([['a'], ['b']])
  })

  it('stops on a cycle and still places and prices every step', () => {
    const cycle = [step('a', { dependsOn: ['b'], budgetUsd: 1 }), step('b', { dependsOn: ['a'], budgetUsd: 2 })]

    expect(dagColumns(cycle).flat().map((node) => node.name).sort()).toEqual(['a', 'b'])
    expect(spendCeilings(cycle)).toEqual({ cleanRunUsd: 3, worstCaseUsd: 3 })
  })

  it('shows a skipped step as skipped even when PESTO calls it succeeded', () => {
    expect(STEP_STATUS_STYLE[named('remediate-app').status].label).toBe('Skipped')
    expect(STEP_STATUS_STYLE[named('implement').status].label).toBe('Done')
    expect(STEP_STATUS_STYLE[step('wait', { status: 'suspended' }).status].label).toBe('Needs a decision')
  })

  it('says when each step runs', () => {
    expect(runCondition(named('remediate-app'))).toBe('Only when $validate-app.output.all_met == false')
    expect(runCondition(named('teardown-env'))).toBe('Always runs')
    expect(runCondition(named('implement'))).toBe('Runs first')
    expect(runCondition(named('remediate-review'))).toBe('After implement, review')
    expect(runCondition(step('x', { when: 'ok', alwaysRun: true, dependsOn: ['a'] }))).toBe('Only when ok · Always runs')
  })

  it('caps a clean run without the conditional steps and the steps that wait on them', () => {
    expect(spendCeilings(nodes)).toEqual({ cleanRunUsd: 78, worstCaseUsd: 105 })
  })

  it('counts a pending step that waits on a conditional step out of a clean run', () => {
    const pending = [
      step('validate', { budgetUsd: 5 }),
      step('fix', { when: 'failed', dependsOn: ['validate'], budgetUsd: 10 }),
      step('revalidate', { dependsOn: ['fix'], budgetUsd: 3 }),
      step('teardown', { dependsOn: ['revalidate'], alwaysRun: true, budgetUsd: 1 }),
    ]

    expect(spendCeilings(pending)).toEqual({ cleanRunUsd: 6, worstCaseUsd: 19 })
  })

  it('names what each step did on the pull request', () => {
    expect(actionLabel('post_review')).toBe('Review')
    expect(actionLabel('remediation_comment')).toBe('Remediation')
    expect(actionLabel('ci_watch')).toBe('CI watch')
    expect(actionLabel('merge_gate_check')).toBe('merge gate check')
  })
})
