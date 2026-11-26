import { execFile as nodeExecFile } from 'node:child_process'

const GH_TIMEOUT_MS = 60_000

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void

export type Gh = (args: readonly string[], signal?: AbortSignal) => Promise<string>

export function createGh(execFile: ExecFile = nodeExecFile as unknown as ExecFile): Gh {
  return (args, signal) =>
    new Promise((resolve, reject) => {
      execFile('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal }, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr).trim() || error.message))
        resolve(String(stdout))
      })
    })
}

export const isNotFound = (error: unknown) => error instanceof Error && error.message.includes('HTTP 404')
