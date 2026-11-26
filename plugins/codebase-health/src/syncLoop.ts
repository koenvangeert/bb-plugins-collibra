export const SYNC_INTERVAL_MS = 30 * 60_000

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

export async function runSyncLoop(options: {
  signal: AbortSignal
  sync(signal: AbortSignal): Promise<void>
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}): Promise<void> {
  const { signal, sync, sleep = abortableSleep } = options
  while (!signal.aborted) {
    await sync(signal)
    await sleep(SYNC_INTERVAL_MS, signal)
  }
}
