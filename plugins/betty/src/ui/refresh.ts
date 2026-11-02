import { useEffect, useRef } from 'react'

const REFRESH_MS = 30_000

export function useRefresh(refetch: () => unknown) {
  const latest = useRef(refetch)
  useEffect(() => {
    latest.current = refetch
  })
  useEffect(() => {
    const timer = setInterval(() => void latest.current(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
}
