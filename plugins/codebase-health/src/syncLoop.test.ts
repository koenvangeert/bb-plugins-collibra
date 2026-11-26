import { describe, expect, it } from 'vitest'
import { runSyncLoop, SYNC_INTERVAL_MS } from './syncLoop'

describe('runSyncLoop', () => {
  it('syncs at start and then once per interval until aborted', async () => {
    const controller = new AbortController()
    const waits: number[] = []
    let syncs = 0

    await runSyncLoop({
      signal: controller.signal,
      sync: async () => {
        syncs += 1
        if (syncs === 3) controller.abort()
      },
      sleep: async (ms) => {
        waits.push(ms)
      },
    })

    expect(syncs).toBe(3)
    expect(waits).toEqual([SYNC_INTERVAL_MS, SYNC_INTERVAL_MS, SYNC_INTERVAL_MS])
  })
})
