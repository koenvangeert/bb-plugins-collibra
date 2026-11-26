import { describe, expect, it } from 'vitest'
import { parseRepositories, SETTINGS } from './settings'

const schema = SETTINGS.repositories.experimental_schema

describe('repositories setting', () => {
  it('splits on commas and spaces and drops duplicates', () => {
    expect(parseRepositories('collibra/frontend, collibra/dgc-core  collibra/frontend')).toEqual([
      'collibra/frontend',
      'collibra/dgc-core',
    ])
  })

  it('accepts owner/name entries only', () => {
    expect(schema.safeParse('collibra/frontend,collibra/dq').success).toBe(true)
    expect(schema.safeParse('frontend').success).toBe(false)
    expect(schema.safeParse(' , ').success).toBe(false)
  })
})
