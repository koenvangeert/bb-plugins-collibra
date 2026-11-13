import { execFile as nodeExecFile } from 'node:child_process'

const GH_TIMEOUT_MS = 30_000
const MAX_BYTES = 20 * 1024 * 1024

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const RAW_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/raw\/([0-9a-f]{40})\/(.+)$/

type GithubFile = { owner: string; repo: string; sha: string; path: string; mediaType: string }

export function parseScreenshotUrl(url: string): GithubFile | null {
  const match = RAW_URL.exec(url)
  if (!match) return null
  const [, owner, repo, sha, path] = match as unknown as [string, string, string, string, string]
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[?#%]/.test(segment))) return null
  const mediaType = MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
  if (!mediaType) return null
  return { owner, repo, sha, path, mediaType }
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: 'buffer' },
  callback: (error: (Error & { code?: unknown }) | null, stdout: Buffer, stderr: Buffer) => void,
) => void

export function createScreenshotLoader(execFile: ExecFile = nodeExecFile as unknown as ExecFile) {
  return {
    load: (url: string): Promise<{ src: string }> => {
      const file = parseScreenshotUrl(url)
      if (!file) return Promise.reject(new Error('bb can only show screenshots from a GitHub raw URL pinned to a commit.'))
      const endpoint = `repos/${file.owner}/${file.repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${file.sha}`
      return new Promise((resolve, reject) => {
        execFile(
          'gh',
          ['api', '-H', 'Accept: application/vnd.github.raw', endpoint],
          { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BYTES, encoding: 'buffer' },
          (error, stdout, stderr) => {
            if (error) return reject(new Error(ghFailure(error, stderr)))
            resolve({ src: `data:${file.mediaType};base64,${stdout.toString('base64')}` })
          },
        )
      })
    },
  }
}

function ghFailure(error: Error & { code?: unknown }, stderr: Buffer): string {
  if (error.code === 'ENOENT') return 'bb needs the GitHub CLI (gh) to show screenshots. Install it and run gh auth login.'
  const detail = stderr.toString().trim() || error.message
  return `gh could not load the screenshot: ${detail}`
}
