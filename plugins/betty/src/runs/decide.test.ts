import { describe, expect, it } from 'vitest'
import type { RunNode } from '../pesto/types'
import { approveBudget, stopPlan } from './decide'

function step(name: string, overrides: Partial<RunNode> = {}): RunNode {
  return {
    taskId: `task-${name}`,
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

const plan = (nodes: RunNode[]) => {
  const { steps, stillRuns } = stopPlan(nodes)
  return { steps: steps.map(({ node, action }) => [node.name, action]), stillRuns: stillRuns.map((node) => node.name) }
}

describe('stop plan', () => {
  it('stops only the running step and leaves its pending dependants and the cleanup to PESTO', () => {
    const nodes = [
      step('provision-env', { status: 'running', executor: 'script' }),
      step('implement', { dependsOn: ['provision-env'] }),
      step('review', { dependsOn: ['implement'] }),
      step('teardown-env', { dependsOn: ['review'], alwaysRun: true, executor: 'script' }),
    ]

    expect(plan(nodes)).toEqual({ steps: [['provision-env', 'stop']], stillRuns: ['teardown-env'] })
  })

  it('denies a step that waits for a decision', () => {
    const nodes = [
      step('implement', { status: 'succeeded' }),
      step('watch-ci', { status: 'suspended', dependsOn: ['implement'] }),
      step('publish', { dependsOn: ['watch-ci'] }),
    ]

    expect(plan(nodes)).toEqual({ steps: [['watch-ci', 'deny']], stillRuns: [] })
  })

  it('stops a pending step whose dependencies are all finished', () => {
    const nodes = [
      step('implement', { status: 'succeeded' }),
      step('lint', { status: 'skipped' }),
      step('review', { dependsOn: ['implement', 'lint'] }),
      step('publish', { dependsOn: ['review'] }),
    ]

    expect(plan(nodes)).toEqual({ steps: [['review', 'stop']], stillRuns: [] })
  })

  it('has nothing to stop in a finished run', () => {
    const nodes = [
      step('implement', { status: 'succeeded' }),
      step('review', { status: 'failed', dependsOn: ['implement'] }),
      step('publish', { status: 'cancelled', dependsOn: ['review'] }),
      step('teardown-env', { status: 'succeeded', alwaysRun: true, dependsOn: ['publish'] }),
    ]

    expect(plan(nodes)).toEqual({ steps: [], stillRuns: [] })
  })
})

describe('approve budget', () => {
  it('doubles the budget of the step', () => {
    expect(approveBudget(step('watch-ci', { budgetUsd: 6 }))).toBe(12)
  })

  it('has no budget to propose when the step has none', () => {
    expect(approveBudget(step('watch-ci'))).toBeNull()
  })
})
