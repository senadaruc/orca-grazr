import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start, engine, report, settle } from './support/plugin-harness.mjs'

// A panel that has asked the worker anything lately is open: the refreshes that follow post to it instead of rewriting
// the page, which Orca would remount (and restart the worker for, as a dev-folder edit). With no panel open, the page is written.
const PANEL_OPEN_MS = 15000
const status = (remaining) => ({ 'status --json': { stdout: JSON.stringify(report({ accounts: [{ name: 'work', id: 'a1', snapshot: [{ kind: 'session', scope: null, group: 'session', remaining }] }] })) } })

function routeFrom(state) {
  return (argv, opts) => engine(status(state.remaining))(argv, opts)
}

test('a refresh after a panel request posts the page to the panel and writes nothing', async () => {
  const state = { remaining: 40 }
  const clock = { now: 1000 }
  const fake = await start({ route: routeFrom(state), now: () => clock.now })
  const renames = fake.fs.renames.length
  await fake.panelHandlers.get('active-host')({})
  state.remaining = 10
  const outcome = await fake.panelHandlers.get('panel-refresh')({})
  assert.equal(outcome.ok, true)
  assert.equal(outcome.message, 'grazr: panel updated')
  assert.equal(fake.posts.length, 1)
  assert.equal(fake.posts[0].event, 'panel')
  assert.ok(fake.posts[0].payload.main.includes('10% left'))
  assert.equal(fake.fs.renames.length, renames)
})

test('a panel not heard from for 15 s counts as closed: the refresh writes the page again', async () => {
  const state = { remaining: 40 }
  const clock = { now: 1000 }
  const fake = await start({ route: routeFrom(state), now: () => clock.now })
  await fake.panelHandlers.get('active-host')({})
  clock.now += PANEL_OPEN_MS + 1
  const renames = fake.fs.renames.length
  state.remaining = 10
  await fake.run('drain-now')
  await settle()
  assert.equal(fake.posts.length, 0)
  assert.equal(fake.fs.renames.length, renames + 1)
})

test('a palette command with no panel open writes the page, as before', async () => {
  const state = { remaining: 40 }
  const fake = await start({ route: routeFrom(state) })
  const renames = fake.fs.renames.length
  state.remaining = 10
  await fake.run('status')
  assert.equal(fake.posts.length, 0)
  assert.equal(fake.fs.renames.length, renames + 1)
})
