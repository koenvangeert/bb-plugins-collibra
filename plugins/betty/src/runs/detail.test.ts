import { describe, expect, it } from 'vitest'
import { fixture } from '../pesto/fakePesto'
import type { RunNode } from '../pesto/types'
import { runDetailSchema } from '../pesto/wire'
import {
  actionLabel,
  attentionFirst,
  baseMayMislead,
  dagColumns,
  nextAction,
  orderedActions,
  spendCeilings,
  spendMeter,
  STEP_STATUS_STYLE,
  stepConditions,
  stepProgress,
} from './detail'

const { nodes, pullRequests } = runDetailSchema.parse(JSON.parse(fixture('dag-status.json')))
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
    expect(stepConditions(named('remediate-app'))).toEqual([{ kind: 'when', expression: '$validate-app.output.all_met == false' }])
    expect(stepConditions(named('teardown-env'))).toEqual([{ kind: 'always' }])
    expect(stepConditions(named('implement'))).toEqual([{ kind: 'first' }])
    expect(stepConditions(named('remediate-review'))).toEqual([{ kind: 'after', steps: ['implement', 'review'] }])
    expect(stepConditions(step('x', { when: 'ok', alwaysRun: true, dependsOn: ['a'] }))).toEqual([
      { kind: 'when', expression: 'ok' },
      { kind: 'always' },
    ])
  })

  it('counts finished steps, skipped ones included', () => {
    expect(stepProgress(nodes)).toEqual({ done: 15, total: 15 })
    expect(stepProgress([step('a', { status: 'failed' }), step('b', { status: 'running' }), step('c')])).toEqual({ done: 1, total: 3 })
  })

  it('says what happens next', () => {
    expect(nextAction(nodes)).toEqual({ kind: 'done' })
    expect(nextAction([step('a', { status: 'running' }), step('b', { status: 'suspended' }), step('c', { status: 'failed' })])).toEqual({
      kind: 'decide',
      step: 'b',
    })
    expect(nextAction([step('a', { status: 'running' }), step('c', { status: 'failed' })])).toEqual({ kind: 'failed', step: 'c' })
    expect(nextAction([step('b', { status: 'running' }), step('a', { status: 'running' }), step('c')])).toEqual({ kind: 'running', steps: ['a', 'b'] })
    expect(nextAction([step('a', { status: 'succeeded' }), step('b')])).toEqual({ kind: 'waiting' })
    expect(nextAction([step('a', { status: 'succeeded' }), step('b', { status: 'cancelled' })])).toEqual({ kind: 'cancelled' })
    expect(nextAction([])).toEqual({ kind: 'waiting' })
  })

  it('lists the steps that need attention first, then the rest in DAG order', () => {
    const steps = [
      step('a', { status: 'succeeded' }),
      step('b', { dependsOn: ['a'], status: 'running' }),
      step('c', { dependsOn: ['a'] }),
      step('d', { dependsOn: ['c'], status: 'suspended' }),
    ]

    expect(attentionFirst(steps).map((node) => node.name)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('orders what was done on the pull request as reviews, remediations, then CI', () => {
    const kinds = orderedActions(pullRequests[0]!.actedOnBy).map((action) => `${action.kind} ${action.name}`)

    expect(kinds).toEqual([
      'post_review publish-review',
      'post_review revalidate-app',
      'post_review validate-app',
      'remediation_comment remediate-review',
      'remediation_comment remediate-review-2',
      'ci_watch reconcile-ci',
    ])
  })

  it.each([
    [4, 'clean', 0.04],
    [80, 'over-clean', 0.8],
    [120, 'over-worst', 1],
  ] as const)('colours a spend of $%d as %s', (spent, tone, spentShare) => {
    const meter = spendMeter(spent, { cleanRunUsd: 78, worstCaseUsd: 100 })

    expect(meter.tone).toBe(tone)
    expect(meter.spentShare).toBeCloseTo(spentShare)
  })

  it('puts the clean run mark on the worst case scale, and copes with no budget', () => {
    expect(spendMeter(4, { cleanRunUsd: 78, worstCaseUsd: 104 }).cleanShare).toBeCloseTo(0.75)
    expect(spendMeter(0, { cleanRunUsd: 0, worstCaseUsd: 0 })).toEqual({ tone: 'clean', spentShare: 0, cleanShare: 0 })
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

  it.each([
    ['main', false],
    ['', false],
    ['release/1', true],
  ])('warns about a pull request on base %j: %s', (base, warns) => {
    expect(baseMayMislead({ ...pullRequests[0]!, base })).toBe(warns)
  })

  it('names what each step did on the pull request', () => {
    expect(actionLabel('post_review')).toBe('Review')
    expect(actionLabel('remediation_comment')).toBe('Remediation')
    expect(actionLabel('ci_watch')).toBe('CI watch')
    expect(actionLabel('merge_gate_check')).toBe('merge gate check')
  })
})
