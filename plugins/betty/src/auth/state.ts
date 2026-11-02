export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number }

export type AuthState =
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; baseUrl: string; clientId: string; tokens: Tokens }
  | { kind: 'expired'; baseUrl: string }

export type AuthKind = AuthState['kind']

export const AUTH_KINDS = ['signed-out', 'signed-in', 'expired'] as const satisfies readonly AuthKind[]

export const SIGN_IN_PROMPT = {
  'signed-out': 'Sign in to BETTY',
  expired: 'Sign in to BETTY again',
  'signed-in': null,
} as const satisfies Record<AuthKind, string | null>
