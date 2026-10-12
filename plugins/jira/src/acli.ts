import { execFile as nodeExecFile } from 'node:child_process'
import { SEARCHABLE_FIELD_IDS } from './filterFields'

export const ACLI_TIMEOUT_MS = 30_000

export interface AcliResult {
  stdout: string
  stderr: string
  exitCode: number
  spawnError?: string
  timedOut?: boolean
}

export interface AcliRunner {
  run(args: string[], signal?: AbortSignal): Promise<AcliResult>
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal },
  callback: (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => void

export function searchArgs(jql: string, limit: number): string[] {
  return [
    'jira',
    'workitem',
    'search',
    '--jql',
    jql,
    '--fields',
    ['key', 'summary', ...SEARCHABLE_FIELD_IDS].join(','),
    '--limit',
    String(limit),
    '--json',
  ]
}

export function viewArgs(key: string): string[] {
  return ['jira', 'workitem', 'view', key, '--fields', 'key,summary,status,issuetype,description', '--json']
}

export function authStatusArgs(): string[] {
  return ['jira', 'auth', 'status']
}

export function createExecFileRunner(execFile: ExecFile = nodeExecFile as unknown as ExecFile): AcliRunner {
  return {
    run: (args, signal) =>
      new Promise((resolve) => {
        try {
          execFile('acli', args, { timeout: ACLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal }, (error, stdout, stderr) => {
            resolve(toResult(error, String(stdout ?? ''), String(stderr ?? '')))
          })
        } catch (error) {
          resolve(toResult(error as Error & { code?: unknown }, '', ''))
        }
      }),
  }
}

function toResult(error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string): AcliResult {
  if (!error) return { stdout, stderr, exitCode: 0 }
  if (error.code === 'ENOENT' || error.code === 'EACCES') return { stdout, stderr, exitCode: -1, spawnError: error.code }
  if (error.killed) return { stdout, stderr, exitCode: -1, timedOut: true }
  if (typeof error.code === 'number') return { stdout, stderr, exitCode: error.code }
  return { stdout, stderr: stderr || error.message, exitCode: 1 }
}
