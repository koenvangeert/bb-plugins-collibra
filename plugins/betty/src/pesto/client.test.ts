import { describe, expect, it } from 'vitest'
import { createPestoClient } from './client'
import { createFakePesto, fixture } from './fakePesto'
import { createMcpSession, PestoError } from './mcp'

const TOKEN = 'secret-token-abc'

const fixtureTools = {
  pesto_dag_status: (args: Record<string, unknown>) => ({ text: fixture(args.run_id ? 'dag-status.json' : 'run-list.json') }),
  pesto_artifact_get: { text: fixture('artifact-result.json') },
}

function connect(pesto: ReturnType<typeof createFakePesto>, endpoint: () => string = () => 'https://betty.test/mcp') {
  const session = createMcpSession({ endpoint, getToken: async () => TOKEN, fetch: pesto.fetch })
  return { session, client: createPestoClient(session) }
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('PESTO client', () => {
  it('reads the run list', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { client } = connect(pesto)

    const list = await client.listRuns({ ownerDev: 'koen.vangeert@collibra.com', includeFinished: true, limit: 2, offset: 3 })

    expect(pesto.toolCalls()[0]!.body!.params).toEqual({
      name: 'pesto_dag_status',
      arguments: { owner_dev: 'koen.vangeert@collibra.com', include_finished: true, limit: 2, offset: 3 },
    })
    expect(list.beyondLimit).toBe(16)
    expect(list.matched).toBe(18)
    expect(list.runs).toHaveLength(2)
    expect(list.runs[0]).toMatchObject({
      runId: 'fft-61-dev-230276-guard-to-categories',
      outcome: 'succeeded',
      ownerDev: 'koen.vangeert@collibra.com',
      progress: { nodesDone: 15, nodesTotal: 15 },
      costUsd: 3.44,
      finishedAt: '2026-10-28T15:59:21Z',
    })
    expect(list.runs[0]!.pullRequests[0]).toMatchObject({
      number: 26728,
      state: 'open',
      base: 'main',
      repo: 'collibra/frontend',
      url: 'https://github.com/collibra/frontend/pull/26728',
    })
    expect(list.runs[0]!.pullRequests[0]!.actedOnBy).toContainEqual({
      kind: 'post_review',
      name: 'revalidate-app',
      taskId: 'd8524087-6bb3-490f-af05-bf88a549fc5b',
      predicted: true,
    })
    expect(list.runs[1]!.outcome).toBe('cancelled')
  })

  it('reads one run as a graph of nodes', async () => {
    const pesto = createFakePesto({ tools: fixtureTools, sse: true })
    const { client } = connect(pesto)

    const run = await client.dagStatus('central-frontend-team-browser-validated-f153a0')

    expect(pesto.toolCalls()[0]!.body!.params!.arguments).toEqual({ run_id: 'central-frontend-team-browser-validated-f153a0' })
    expect(run.runId).toBe('central-frontend-team-browser-validated-f153a0')
    expect(run.totalCostUsd).toBeCloseTo(3.6577)
    expect(run.pullRequests.map((pr) => pr.number)).toEqual([26731])
    const node = (name: string) => run.nodes.find((candidate) => candidate.name === name)
    expect(node('implement')).toMatchObject({
      executor: 'agent',
      status: 'succeeded',
      budgetUsd: 15,
      costUsd: 1.3079,
      dependsOn: [],
      startedAt: '2026-10-28T15:11:39Z',
    })
    expect(node('remediate-app')).toMatchObject({ when: '$validate-app.output.all_met == false', skipped: true, costUsd: 0 })
    expect(node('teardown-env')).toMatchObject({ alwaysRun: true, executor: 'script', budgetUsd: null })
    expect(node('publish-review')!.executor).toBe('publisher')
  })

  it('reads an artifact by task and kind', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { client } = connect(pesto)

    const artifact = await client.artifact({ taskId: '65bee160-b71b-4d19-a614-8ff73e1cc3b3', kind: 'result' })

    expect(pesto.toolCalls()[0]!.body!.params).toEqual({
      name: 'pesto_artifact_get',
      arguments: { task_id: '65bee160-b71b-4d19-a614-8ff73e1cc3b3', kind: 'result' },
    })
    expect(artifact).toMatchObject({ artifactId: '5cf02d70-730c-4a4d-8668-cc0f752ad3b6', kind: 'result', sizeBytes: 2263 })
    expect(JSON.parse(artifact.content).all_met).toBe(true)
  })

  it('reads an artifact by id', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { client } = connect(pesto)

    await client.artifact({ artifactId: '5cf02d70-730c-4a4d-8668-cc0f752ad3b6' })

    expect(pesto.toolCalls()[0]!.body!.params!.arguments).toEqual({ artifact_id: '5cf02d70-730c-4a4d-8668-cc0f752ad3b6' })
  })

  it('keeps an outcome or status it does not know as unknown', async () => {
    const list = JSON.parse(fixture('run-list.json'))
    list.runs[0].outcome = 'hibernating'
    list.runs[0].pull_requests[0].state = 'queued'
    const run = JSON.parse(fixture('dag-status.json'))
    run.nodes[0].status = 'teleporting'
    run.nodes[0].executor = 'oracle'
    const pesto = createFakePesto({
      tools: { pesto_dag_status: (args) => ({ text: JSON.stringify(args.run_id ? run : list) }) },
    })
    const { client } = connect(pesto)

    const runs = await client.listRuns({ ownerDev: 'a@b.c' })
    const detail = await client.dagStatus('r')

    expect(runs.runs[0]!.outcome).toBe('unknown')
    expect(runs.runs[0]!.pullRequests[0]!.state).toBe('unknown')
    expect(detail.nodes[0]).toMatchObject({ status: 'unknown', executor: 'oracle' })
  })

  it('rejects an answer that misses a required field with a PestoError', async () => {
    const list = JSON.parse(fixture('run-list.json'))
    delete list.runs[0].run_id
    const pesto = createFakePesto({ tools: { pesto_dag_status: { text: JSON.stringify(list) } } })
    const { client } = connect(pesto)

    await expect(client.listRuns({ ownerDev: 'a@b.c' })).rejects.toBeInstanceOf(PestoError)
  })
})

describe('MCP session', () => {
  it('initializes once and sends every call on the same session', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { client } = connect(pesto)

    await client.listRuns({ ownerDev: 'a@b.c' })
    await client.dagStatus('r')
    await client.artifact({ artifactId: 'x' })

    expect(pesto.initializes()).toHaveLength(1)
    expect(pesto.toolCalls().map((call) => call.headers['mcp-session-id'])).toEqual(['session-1', 'session-1', 'session-1'])
    for (const call of pesto.toolCalls()) {
      expect(call.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        'mcp-protocol-version': '2025-06-18',
        accept: 'application/json, text/event-stream',
      })
    }
  })

  it('confirms the session with notifications/initialized before the first call', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { client } = connect(pesto)

    await client.dagStatus('r')

    expect(pesto.requests.map((request) => request.body?.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ])
  })

  it('sends one initialize for two concurrent first calls', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { client } = connect(pesto)

    await Promise.all([client.dagStatus('r'), client.listRuns({ ownerDev: 'a@b.c' })])

    expect(pesto.initializes()).toHaveLength(1)
    expect(pesto.toolCalls()).toHaveLength(2)
  })

  it('starts a new session once when the server forgot the session', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { client } = connect(pesto)
    await client.dagStatus('r')
    pesto.expireSessionOnNextToolCalls(1)

    const run = await client.dagStatus('r')

    expect(run.runId).toBe('central-frontend-team-browser-validated-f153a0')
    expect(pesto.initializes()).toHaveLength(2)
    expect(pesto.toolCalls().at(-1)!.headers['mcp-session-id']).toBe('session-2')
  })

  it('gives up when the new session is forgotten too', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { client } = connect(pesto)
    pesto.expireSessionOnNextToolCalls(2)

    await expect(client.dagStatus('r')).rejects.toBeInstanceOf(PestoError)
    expect(pesto.initializes()).toHaveLength(2)
  })

  it('moves to a new host with a new session when the endpoint changes', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    let endpoint = 'https://betty.test/mcp'
    const { client } = connect(pesto, () => endpoint)
    await client.dagStatus('r')

    endpoint = 'https://other.test/mcp'
    await client.dagStatus('r')

    expect(pesto.toolCalls().map((call) => [call.url, call.headers['mcp-session-id']])).toEqual([
      ['https://betty.test/mcp', 'session-1'],
      ['https://other.test/mcp', 'session-2'],
    ])
    expect(pesto.initializes().map((call) => call.url)).toEqual(['https://betty.test/mcp', 'https://other.test/mcp'])
  })

  it('ends the session on close and starts a new one on the next call', async () => {
    const pesto = createFakePesto({ tools: fixtureTools })
    const { session, client } = connect(pesto)
    await client.dagStatus('r')

    await session.close()
    await client.dagStatus('r')

    const deletes = pesto.requests.filter((request) => request.method === 'DELETE')
    expect(deletes.map((request) => request.headers['mcp-session-id'])).toEqual(['session-1'])
    expect(pesto.initializes()).toHaveLength(2)
  })

  it.each([
    ['a tool error', { text: `run not found for ${TOKEN}`, isError: true }, 'run not found'],
    ['a JSON-RPC error', { rpcError: `invalid params near ${TOKEN}` }, 'invalid params'],
  ])('surfaces %s as a PestoError with the server text and without the token', async (_, reply, text) => {
    const pesto = createFakePesto({ tools: { pesto_dag_status: reply } })
    const { client } = connect(pesto)

    const error = await caught(client.dagStatus('r'))

    expect(error).toBeInstanceOf(PestoError)
    expect(error.message).toContain(text)
    expect(error.message).not.toContain(TOKEN)
  })
})
