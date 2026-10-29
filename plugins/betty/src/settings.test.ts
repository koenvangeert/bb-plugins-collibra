import { describe, expect, it } from 'vitest'
import { mcpEndpoint, SETTINGS } from './settings'

const accepts = (value: string) => SETTINGS.baseUrl.experimental_schema.safeParse(value).success

describe('settings', () => {
  it('accepts the default BETTY address', () => {
    expect(accepts(SETTINGS.baseUrl.default)).toBe(true)
  })

  it.each(['http://betty.collibra.dev', 'betty.collibra.dev', 'not a url', ''])('rejects %j as the BETTY address', (value) => {
    expect(accepts(value)).toBe(false)
  })

  it.each(['https://betty.collibra.dev', 'https://betty.collibra.dev/'])('talks MCP at /mcp under %s', (baseUrl) => {
    expect(mcpEndpoint(baseUrl)).toBe('https://betty.collibra.dev/mcp')
  })
})
