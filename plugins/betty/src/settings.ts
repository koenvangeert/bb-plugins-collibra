import { z } from 'zod'

export const SETTINGS = {
  baseUrl: {
    type: 'string',
    label: 'BETTY address',
    description: 'The https address of the BETTY (PESTO) server.',
    default: 'https://betty.collibra.dev',
    experimental_schema: z.url({ protocol: /^https$/ }),
  },
} as const

export function mcpEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/mcp`
}
