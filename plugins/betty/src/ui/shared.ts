import { useEffect } from 'react'

const REFRESH_MS = 30_000

export const money = (usd: number) => `$${usd.toFixed(2)}`

export function useRefresh(refetch: () => unknown) {
  useEffect(() => {
    const timer = setInterval(() => void refetch(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [refetch])
}
