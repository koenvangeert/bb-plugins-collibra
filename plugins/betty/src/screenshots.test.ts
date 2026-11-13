import { describe, expect, it } from 'vitest'
import { createScreenshotLoader, parseScreenshotUrl, type ExecFile } from './screenshots'

const SHA = 'a9fb6c68e4baf54aee0c53004be3b2220db61d32'
const URL = `https://github.com/collibra/frontend/raw/${SHA}/ac-image-AC-1-1-drawer-flag-off.png`

function fakeGh(answer: { stdout?: Buffer; stderr?: string; error?: Error & { code?: unknown } }) {
  const calls: string[][] = []
  const execFile: ExecFile = (file, args, _options, callback) => {
    calls.push([file, ...args])
    callback(answer.error ?? null, answer.stdout ?? Buffer.alloc(0), Buffer.from(answer.stderr ?? ''))
  }
  return { execFile, calls }
}

describe('parseScreenshotUrl', () => {
  it('reads a GitHub raw URL pinned to a commit', () => {
    expect(parseScreenshotUrl(URL)).toEqual({
      owner: 'collibra',
      repo: 'frontend',
      sha: SHA,
      path: 'ac-image-AC-1-1-drawer-flag-off.png',
      mediaType: 'image/png',
    })
  })

  it.each([
    ['a branch ref', 'https://github.com/collibra/frontend/raw/main/shot.png'],
    ['another host', `https://example.com/collibra/frontend/raw/${SHA}/shot.png`],
    ['a path that climbs', `https://github.com/collibra/frontend/raw/${SHA}/../secrets/shot.png`],
    ['a query in the path', `https://github.com/collibra/frontend/raw/${SHA}/shot.png?x=1`],
    ['a file that is not an image', `https://github.com/collibra/frontend/raw/${SHA}/notes.txt`],
  ])('refuses %s', (_name, url) => {
    expect(parseScreenshotUrl(url)).toBeNull()
  })
})

describe('createScreenshotLoader', () => {
  it('asks gh for the raw file at the commit and answers a data URL', async () => {
    const gh = fakeGh({ stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })

    const result = await createScreenshotLoader(gh.execFile).load(URL)

    expect(gh.calls).toEqual([
      ['gh', 'api', '-H', 'Accept: application/vnd.github.raw', `repos/collibra/frontend/contents/ac-image-AC-1-1-drawer-flag-off.png?ref=${SHA}`],
    ])
    expect(result).toEqual({ src: 'data:image/png;base64,iVBORw==' })
  })

  it('does not run gh for a URL it refuses', async () => {
    const gh = fakeGh({})

    await expect(createScreenshotLoader(gh.execFile).load('https://github.com/collibra/frontend/raw/main/shot.png')).rejects.toThrow(
      'GitHub raw URL pinned to a commit',
    )
    expect(gh.calls).toEqual([])
  })

  it('tells the user to install gh when it is missing', async () => {
    const gh = fakeGh({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) })

    await expect(createScreenshotLoader(gh.execFile).load(URL)).rejects.toThrow('needs the GitHub CLI (gh)')
  })

  it('passes on what gh said when it fails', async () => {
    const gh = fakeGh({ error: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'gh: Not Found (HTTP 404)\n' })

    await expect(createScreenshotLoader(gh.execFile).load(URL)).rejects.toThrow('gh could not load the screenshot: gh: Not Found (HTTP 404)')
  })
})
