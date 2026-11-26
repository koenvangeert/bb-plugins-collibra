import { z } from 'zod'

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/

export function parseRepositories(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))]
}

export const SETTINGS = {
  repositories: {
    type: 'string',
    label: 'GitHub repositories',
    description: 'The repositories to track, as owner/name, separated by commas.',
    default: 'collibra/frontend',
    experimental_schema: z
      .string()
      .refine((value) => parseRepositories(value).length > 0, 'Name at least one repository.')
      .refine((value) => parseRepositories(value).every((repo) => REPOSITORY.test(repo)), 'Write each repository as owner/name.'),
  },
} as const
