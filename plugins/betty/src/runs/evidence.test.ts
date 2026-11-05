import { describe, expect, it } from 'vitest'
import { createPestoClient } from '../pesto/client'
import { createFakePesto, fixture } from '../pesto/fakePesto'
import { createMcpSession } from '../pesto/mcp'
import type { RunNode } from '../pesto/types'
import { createEvidenceLoader, fakedBackendSentence } from './evidence'

const evidenceOf = (name: string): string[] =>
  JSON.parse(JSON.parse(fixture(name)).content).acs.map((ac: { evidence: string }) => ac.evidence)

const [CLEAN_AC_1, CLEAN_AC_2] = evidenceOf('artifact-result.json')
const [FAKED_AC_1, FAKED_AC_2] = evidenceOf('artifact-result-faked.json')

const FAKED_SENTENCE =
  'The DGC has the aicc.agents.guardian/overview feature flags off and no Guardian Overview or contract backend, so the browser rewrote the feature-flag, AI Command Center general-config, agent-contract list/rules and guardianOverview responses (magneto_playwright_route).'

describe('faked backend sentence', () => {
  it.each([
    ['evidence that ran against the real backend', CLEAN_AC_1, null],
    ['evidence that did not exercise anything', FAKED_AC_2, null],
    [
      'a rewritten flag response',
      CLEAN_AC_2,
      "Extra, not counted: I rewrote the flag to true in the browser's flags response and saw the same order, but could not confirm the override took effect.",
    ],
    [
      'responses rewritten in the browser',
      FAKED_AC_1,
      FAKED_SENTENCE,
    ],
    ['simulated backend state', 'The tab rendered. This is simulated backend state. It looked right.', 'This is simulated backend state.'],
    ['data that is not real', 'Counts showed 4, which is not real data!', 'Counts showed 4, which is not real data!'],
    ['a mocked response', 'I mocked the contracts response to return two rules.', 'I mocked the contracts response to return two rules.'],
    ['a response without a faking verb', 'The flags response returned false.', null],
  ])('finds %s', (_name, evidence, sentence) => {
    expect(fakedBackendSentence(evidence!)).toBe(sentence)
  })
})

function node(name: string, overrides: Partial<RunNode> = {}): RunNode {
  return {
    taskId: `t-${name}`,
    name,
    executor: 'agent',
    status: 'succeeded',
    dependsOn: [],
    alwaysRun: false,
    costUsd: 0,
    budgetUsd: null,
    completedAt: '2026-10-28T15:00:00Z',
    ...overrides,
  }
}

const TASKS: Record<string, unknown> = {
  't-validate-app': JSON.parse(fixture('task-show-validate.json')),
  't-revalidate-app': {
    required_artifacts: ['post_review', 'result'],
    acceptance_criteria: 'AC-3: The other menus keep their order\nAC-1: The Compliance group is in order',
  },
  't-implement': { required_artifacts: ['open_pr'], acceptance_criteria: 'AC-1: The Compliance group is in order' },
  't-review': { required_artifacts: ['post_review', 'result'] },
  't-reconcile-ci': { required_artifacts: ['push_branch'], acceptance_criteria_list: null },
}

const RESULTS: Record<string, () => { text: string; isError?: boolean }> = {
  't-validate-app': () => ({ text: fixture('artifact-result-faked.json') }),
  't-revalidate-app': () => ({ text: fixture('artifact-result.json') }),
}

function loaderWith(results = RESULTS) {
  const pesto = createFakePesto({
    tools: {
      pesto_artifact_get: (args) => results[String(args.task_id)]!(),
      pesto_task_show: (args) => ({ text: JSON.stringify(TASKS[String(args.task_id)]) }),
    },
  })
  const session = createMcpSession({ endpoint: () => 'https://betty.test/mcp', getToken: async () => 'token', fetch: pesto.fetch })
  const asked = (tool: string) =>
    pesto
      .toolCalls()
      .filter((call) => call.body!.params!.name === tool)
      .map((call) => call.body!.params!.arguments!.task_id)
  return { loader: createEvidenceLoader(createPestoClient(session)), asked }
}

const RUN: RunNode[] = [
  node('revalidate-app', { status: 'failed', dependsOn: ['validate-app'] }),
  node('validate-app', { dependsOn: ['implement'] }),
  node('implement'),
  node('review', { dependsOn: ['implement'] }),
  node('reconcile-ci', { dependsOn: ['implement'] }),
  node('build-frontend', { executor: 'script' }),
  node('remediate-app', { status: 'running', completedAt: undefined }),
  node('remediate-review', { status: 'skipped' }),
]

describe('evidence loader', () => {
  it('keeps the steps that must prove acceptance criteria in a result, in DAG order, with the AC text by id', async () => {
    const { loader } = loaderWith()

    const steps = await loader.load(RUN)

    expect(steps.map((step) => step.step)).toEqual(['validate-app', 'revalidate-app'])
    expect(steps[0]!.criteria).toEqual([
      {
        id: 'AC-1',
        text: 'On an AI Agent asset with Guardian off, the tab bar has no Guardian tab',
        met: true,
        evidence: FAKED_AC_1,
        images: [
          'https://github.com/collibra/frontend/raw/82b29b6597a8c10f636464c3c60cce0f24884b6e/ac-image-AC-1-1-settings-guardian-off.png',
          'https://github.com/collibra/frontend/raw/82b29b6597a8c10f636464c3c60cce0f24884b6e/ac-image-AC-1-2-ac1-tabbar-guardian-off.png',
        ],
        fakedBackend: FAKED_SENTENCE,
      },
      {
        id: 'AC-2',
        text: 'With AI Agent contracts off, the asset has no Contract tab',
        met: false,
        evidence: 'Not exercised: contracts off with Guardian off, and an AI Agent Version asset.',
        images: [],
        fakedBackend: null,
      },
    ])
    expect(steps[1]!.criteria.map((criterion) => [criterion.id, criterion.text])).toEqual([
      ['AC-1', 'The Compliance group is in order'],
      ['AC-2', null],
      ['AC-3', 'The other menus keep their order'],
    ])
  })

  it('reads the result only of finished agent steps that require one and have criteria', async () => {
    const { loader, asked } = loaderWith()

    await loader.load(RUN)

    expect(asked('pesto_task_show').sort()).toEqual(['t-implement', 't-reconcile-ci', 't-revalidate-app', 't-review', 't-validate-app'])
    expect(asked('pesto_artifact_get').sort()).toEqual(['t-revalidate-app', 't-validate-app'])
  })

  it('passes on an error while it reads a result', async () => {
    const { loader } = loaderWith({ ...RESULTS, 't-validate-app': () => ({ text: 'BETTY is down', isError: true }) })

    await expect(loader.load(RUN)).rejects.toThrow('BETTY is down')
  })

  it('does not ask again for a finished step it already read', async () => {
    const { loader, asked } = loaderWith()

    const first = await loader.load(RUN)
    const second = await loader.load(RUN)

    expect(second).toEqual(first)
    expect(asked('pesto_task_show')).toHaveLength(5)
    expect(asked('pesto_artifact_get')).toHaveLength(2)
  })

  it('asks again for a step that finished again after a retry', async () => {
    const { loader, asked } = loaderWith()
    await loader.load(RUN)

    await loader.load(RUN.map((step) => (step.name === 'validate-app' ? { ...step, completedAt: '2026-10-28T16:00:00Z' } : step)))

    expect(asked('pesto_artifact_get').filter((taskId) => taskId === 't-validate-app')).toHaveLength(2)
    expect(asked('pesto_artifact_get')).toHaveLength(3)
  })

  it('asks again after a failed read', async () => {
    let down = true
    const { loader, asked } = loaderWith({
      ...RESULTS,
      't-validate-app': () => (down ? { text: 'BETTY is down', isError: true } : { text: fixture('artifact-result-faked.json') }),
    })
    await expect(loader.load(RUN)).rejects.toThrow('BETTY is down')

    down = false

    await expect(loader.load(RUN)).resolves.toHaveLength(2)
    expect(asked('pesto_artifact_get').filter((taskId) => taskId === 't-validate-app')).toHaveLength(2)
  })
})
