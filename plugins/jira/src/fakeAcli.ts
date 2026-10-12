import type { AcliResult, AcliRunner } from './acli'

type Reply =
  | Partial<AcliResult>
  | ((args: string[], signal?: AbortSignal) => Partial<AcliResult> | Promise<Partial<AcliResult>>)

export function fakeAcli(replies: { search?: Reply; view?: Reply; auth?: Reply } = {}) {
  const calls: string[][] = []
  const runner: AcliRunner = {
    async run(args, signal) {
      calls.push(args)
      const reply = replies[args[2] === 'search' ? 'search' : args[2] === 'view' ? 'view' : 'auth']
      const result = typeof reply === 'function' ? await reply(args, signal) : reply
      return { stdout: '', stderr: '', exitCode: 0, ...result }
    },
  }
  return { runner, calls }
}
