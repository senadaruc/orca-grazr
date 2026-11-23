import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLimitResetSchedule } from '../lib/limit-reset-schedule.mjs'

const HOUR = 3600000
const START = 1_800_000_000_000

// Timers that fire only when a test says so; cleared ones are dropped.
function manualTimers() {
  const armed = []
  return {
    armed,
    setTimeout: (fn, ms) => { const t = { fn, ms }; armed.push(t); return t },
    clearTimeout: (t) => { const i = armed.indexOf(t); if (i !== -1) armed.splice(i, 1) },
    fire: async () => { const t = armed.shift(); await t.fn() },
  }
}

function setup({ stored, enabled = true, read } = {}) {
  let clock = START
  const timers = manualTimers()
  const values = stored === undefined ? {} : { limitResets: stored }
  const reads = []
  const afterRuns = []
  const asked = []
  const schedule = createLimitResetSchedule({
    loadSettings: async () => ({ readLimitResets: enabled }),
    enrolledAccounts: async (settings, host) => { asked.push(host); return ['a', 'b'] },
    read: read ?? (async ({ accounts, previous }) => {
      reads.push(accounts)
      return { ...previous, ...Object.fromEntries(accounts.map((name) => [name, { readAt: clock, state: 'ok', full: 0, model: 1, kinds: [] }])) }
    }),
    storage: { get: async (key) => values[key], set: async (key, value) => { values[key] = value } },
    timers,
    now: () => clock,
    log: () => {},
    afterRun: async () => { afterRuns.push(clock) },
  })
  return { schedule, timers, values, reads, afterRuns, asked, advance: (ms) => { clock += ms } }
}

test('the first check comes a minute after start, reads every account with no reading yet, and the next comes three hours on', async () => {
  const s = setup()
  s.schedule.start()
  assert.deepEqual(s.timers.armed.map((t) => t.ms), [60000])
  s.advance(60000)
  await s.timers.fire()
  assert.deepEqual(s.reads, [['a', 'b']])
  assert.deepEqual(s.asked, [null])
  assert.deepEqual(Object.keys(s.values.limitResets), ['a', 'b'])
  assert.deepEqual(s.afterRuns, [START + 60000])
  assert.deepEqual(s.timers.armed.map((t) => t.ms), [3 * HOUR])
})

test('a reading under three hours old is not read again at start; the check comes back when it turns three hours old', async () => {
  const s = setup({ stored: { a: { readAt: START - HOUR, state: 'ok', full: 0, model: 0 } } })
  s.schedule.start()
  s.advance(60000)
  await s.timers.fire()
  assert.deepEqual(s.reads, [])
  assert.deepEqual(s.timers.armed.map((t) => t.ms), [2 * HOUR - 60000])
})

test('a reading three hours old or more is read again at start', async () => {
  const s = setup({ stored: { a: { readAt: START - 4 * HOUR, state: 'ok', full: 0, model: 0 } } })
  s.schedule.start()
  await s.timers.fire()
  assert.equal(s.reads.length, 1)
})

test('every three hours while the worker runs', async () => {
  const s = setup()
  s.schedule.start()
  await s.timers.fire()
  s.advance(3 * HOUR)
  await s.timers.fire()
  s.advance(3 * HOUR)
  await s.timers.fire()
  assert.equal(s.reads.length, 3)
})

test('a run asked for while one is under way joins it: never two at once', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let reads = 0
  const s = setup({ read: async ({ previous }) => { reads++; await gate; return previous } })
  const first = s.schedule.run()
  const second = s.schedule.run({ host: 'mac' })
  assert.equal(first, second)
  release()
  await first
  assert.equal(reads, 1)
  await s.schedule.run({ host: 'mac' })
  assert.equal(reads, 2)
})

test('a Refresh reads the accounts of its own host', async () => {
  const s = setup()
  assert.equal(await s.schedule.run({ host: 'devbox' }), 'read')
  assert.deepEqual(s.asked, ['devbox'])
})

test('with the setting off nothing is read, at start or on a Refresh, and the check comes back in three hours', async () => {
  const s = setup({ enabled: false })
  s.schedule.start()
  await s.timers.fire()
  assert.equal(await s.schedule.run({ host: 'mac' }), 'off')
  assert.deepEqual(s.reads, [])
  assert.deepEqual(s.asked, [])
  assert.deepEqual(s.timers.armed.map((t) => t.ms), [3 * HOUR])
})

test('a read that could not run stores nothing and redraws nothing', async () => {
  const s = setup({ read: async () => null })
  assert.equal(await s.schedule.run(), 'skipped')
  assert.equal(s.values.limitResets, undefined)
  assert.deepEqual(s.afterRuns, [])
})

test('a read that failed everywhere still waits three hours before the next', async () => {
  const s = setup({ read: async () => null })
  s.schedule.start()
  await s.timers.fire()
  assert.deepEqual(s.timers.armed.map((t) => t.ms), [3 * HOUR])
})

test('stop clears the armed check', () => {
  const s = setup()
  s.schedule.start()
  s.schedule.stop()
  assert.deepEqual(s.timers.armed, [])
})
