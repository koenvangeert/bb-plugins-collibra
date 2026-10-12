import { describe, expect, it, vi } from 'vitest'
import { authStatusArgs, createExecFileRunner, searchArgs, viewArgs, type ExecFile } from './acli'

function recordingExecFile(result: { stdout?: string; stderr?: string; code?: number | string } = {}) {
  const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = []
  const execFile: ExecFile = (file, args, options, callback) => {
    calls.push({ file, args, options })
    const error =
      result.code === undefined ? null : Object.assign(new Error('exec failed'), { code: result.code })
    callback(error, result.stdout ?? '', result.stderr ?? '')
  }
  return { execFile, calls }
}

describe('acli commands', () => {
  it('pass the whole JQL as one argument', () => {
    const jql = 'assignee = currentUser() AND summary ~ "a; rm -rf /"'

    const args = searchArgs(jql, 200)

    expect(args).toContain(jql)
    expect(args.slice(0, 3)).toEqual(['jira', 'workitem', 'search'])
    expect(args).toEqual(expect.arrayContaining(['--json', '--limit', '200']))
  })

  it('search the fields that filters offer values for', () => {
    const args = searchArgs('q', 1)

    expect(args[args.indexOf('--fields') + 1]).toBe('key,summary,status,issuetype,priority,assignee,reporter,creator,labels')
  })

  it('view one key with its description', () => {
    expect(viewArgs('ABC-12')).toEqual([
      'jira',
      'workitem',
      'view',
      'ABC-12',
      '--fields',
      'key,summary,status,issuetype,description',
      '--json',
    ])
  })

  it('check the login with auth status', () => {
    expect(authStatusArgs()).toEqual(['jira', 'auth', 'status'])
  })
})

describe('createExecFileRunner', () => {
  it('runs acli without a shell and with a timeout', async () => {
    const { execFile, calls } = recordingExecFile({ stdout: '[]' })

    const result = await createExecFileRunner(execFile).run(['jira', 'auth', 'status'])

    expect(result).toEqual({ stdout: '[]', stderr: '', exitCode: 0 })
    expect(calls).toEqual([
      { file: 'acli', args: ['jira', 'auth', 'status'], options: expect.objectContaining({ timeout: 30_000 }) },
    ])
    expect(calls[0]!.options.shell).toBeUndefined()
  })

  it('hands the abort signal to execFile so an abort kills acli', async () => {
    const { execFile, calls } = recordingExecFile()
    const { signal } = new AbortController()

    await createExecFileRunner(execFile).run(['x'], signal)

    expect(calls[0]!.options.signal).toBe(signal)
  })

  it('returns the exit code and output of a failed command', async () => {
    const { execFile } = recordingExecFile({ stderr: 'unauthorized', code: 1 })

    expect(await createExecFileRunner(execFile).run(['x'])).toEqual({ stdout: '', stderr: 'unauthorized', exitCode: 1 })
  })

  it('reports a missing acli binary', async () => {
    const { execFile } = recordingExecFile({ code: 'ENOENT' })

    expect(await createExecFileRunner(execFile).run(['x'])).toMatchObject({ spawnError: 'ENOENT' })
  })

  it('reports an output overflow as a failure, not as a start problem', async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) =>
      callback(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', '')

    const result = await createExecFileRunner(execFile).run(['x'])

    expect(result.spawnError).toBeUndefined()
    expect(result).toMatchObject({ exitCode: 1, stderr: 'stdout maxBuffer length exceeded' })
  })

  it('reports a timeout', async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) =>
      callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', '')

    expect(await createExecFileRunner(execFile).run(['x'])).toMatchObject({ timedOut: true })
  })

  it('does not throw when execFile throws synchronously', async () => {
    const execFile: ExecFile = vi.fn(() => {
      throw Object.assign(new Error('spawn failed'), { code: 'EACCES' })
    })

    expect(await createExecFileRunner(execFile).run(['x'])).toMatchObject({ spawnError: 'EACCES' })
  })
})
