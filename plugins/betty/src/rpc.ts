import { defineRpcContract } from '@get-bb/plugin-sdk'
import { z } from 'zod'
import { AUTH_KINDS } from './auth/state'

export const rpcContract = defineRpcContract({
  authStatus: { input: z.null(), output: z.object({ state: z.enum(AUTH_KINDS) }) },
  startSignIn: { input: z.null(), output: z.object({ url: z.url({ protocol: /^https$/ }) }) },
})
