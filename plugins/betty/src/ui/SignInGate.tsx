import type { ReactNode } from 'react'
import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from '@get-bb/plugin-sdk/app'
import { SIGN_IN_PROMPT } from '../auth/state'
import { rpcContract } from '../rpc'

export function SignInGate({ children }: { children: ReactNode }) {
  const status = experimental_useRpcQuery({ contract: rpcContract, method: 'authStatus', input: null })
  const signIn = experimental_useRpcMutation({ contract: rpcContract, method: 'startSignIn' })
  const navigate = useBbNavigate()

  if (status.error) return <p className="text-sm text-destructive">{status.error.message}</p>
  if (!status.data) return null
  const prompt = SIGN_IN_PROMPT[status.data.state]
  if (!prompt) return children

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        disabled={signIn.isPending}
        onClick={() => signIn.mutate(null).then(({ url }) => navigate.openUrl(url), () => {})}
      >
        {prompt}
      </button>
      {signIn.error && <p className="text-sm text-destructive">{signIn.error.message}</p>}
    </div>
  )
}
