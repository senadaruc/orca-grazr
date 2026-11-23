import { READINGS_KEY, lastTriedAt, loadReadings } from './limit-reset-readings.mjs'
import { describe } from './errors.mjs'

export const READ_INTERVAL_MS = 3 * 3600 * 1000
// The worker's first minute belongs to its activation refresh; the first check comes after it.
export const FIRST_CHECK_MS = 60000

// When to read each account's claude.ai usage page: every READ_INTERVAL_MS while the worker runs, a minute after
// start when the last try is that old, and on run() (a card's Refresh). Runs never overlap: one asked for while another is
// under way joins it. exclusive(fn) runs other work on the usage pages (a reset) in turn with the reads, never beside one. The readLimitResets setting is re-read each time, so turning it off stops the reads without a restart.
// read({ settings, accounts, previous }) returns the new readings, or null when nothing could be read.
export function createLimitResetSchedule({ loadSettings, enrolledAccounts, read, storage, timers = { setTimeout, clearTimeout }, now = Date.now, log = () => {}, afterRun }) {
  let handle = null
  let running = false
  let inFlight = null
  // Kept in memory as well, so a run that stored nothing still waits its interval.
  let lastRunAt = -Infinity
  // The last piece of work on the usage pages; the next one starts when it has settled.
  let tail = Promise.resolve()

  function exclusive(fn) {
    const turn = tail.then(() => fn())
    tail = turn.then(() => {}, () => {})
    return turn
  }

  const stored = () => loadReadings(storage, log)

  async function runOnce(host) {
    const settings = await loadSettings()
    if (settings.readLimitResets === false) return 'off'
    lastRunAt = now()
    const accounts = await enrolledAccounts(settings, host)
    if (accounts.length === 0) return 'none'
    const readings = await read({ settings, accounts, previous: await stored() })
    if (readings === null) return 'skipped'
    await storage.set(READINGS_KEY, readings)
    // The redraw is the panel's own business; a failure there does not undo the stored readings.
    try {
      await afterRun?.()
    } catch (err) {
      log(`grazr limit resets: the panel was not redrawn: ${describe(err)}`)
    }
    return 'read'
  }

  // host names the server whose accounts are read; null reads every enrolled account.
  function run({ host = null } = {}) {
    if (inFlight) return inFlight
    inFlight = exclusive(() => runOnce(host))
      .catch((err) => {
        log(`grazr limit resets: ${describe(err)}`)
        return 'failed'
      })
      .finally(() => { inFlight = null })
    return inFlight
  }

  function arm(ms) {
    timers.clearTimeout(handle)
    handle = running ? timers.setTimeout(tick, ms) : null
  }

  async function tick() {
    handle = null
    let next = READ_INTERVAL_MS
    try {
      const settings = await loadSettings()
      if (settings.readLimitResets !== false) {
        const lastAt = async () => Math.max(lastTriedAt(await stored()), lastRunAt)
        if (now() - (await lastAt()) >= READ_INTERVAL_MS) await run()
        next = Math.max(FIRST_CHECK_MS, (await lastAt()) + READ_INTERVAL_MS - now())
      }
    } catch (err) {
      log(`grazr limit resets: the check failed: ${describe(err)}`)
    } finally {
      arm(next)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      arm(FIRST_CHECK_MS)
    },
    stop() {
      running = false
      timers.clearTimeout(handle)
      handle = null
    },
    run,
    exclusive,
  }
}
