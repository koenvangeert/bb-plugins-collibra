import { describe, expect, it } from 'vitest'
import { createGh, isNotFound, type ExecFile } from './gh'

describe('createGh', () => {
  it('resolves with the gh output', async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) => callback(null, 'ann\n', '')

    expect(await createGh(execFile)(['api', 'x'])).toBe('ann\n')
  })

  it('names a missing resource as not found', async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) =>
      callback(new Error('exit 1'), '', 'gh: Not Found (HTTP 404)\n')

    const error = await createGh(execFile)(['api', 'x']).catch((cause: unknown) => cause)

    expect(isNotFound(error)).toBe(true)
  })
})
