import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start, statusRoute, settle } from './support/plugin-harness.mjs'

const MAC = { name: 'mac', ssh: null, python: 'python3', notifier: 'osascript' }
const USAGE = 'Your usage limits\nLimit resets\n2 available\nFable reset · 2\nAll expire Mar 9, 2027, 8:59 AM GMT+1\nLast updated: just now'
const reply = (result) => ({ stdout: JSON.stringify({ ok: true, result }) })

// The Orca CLI answers for the account `work`'s profile; the tab opens only once the test lets it.
function orcaRoute(gate) {
  const engine = statusRoute()
  return async (argv) => {
    if (argv[0] !== '/usr/local/bin/orca') return engine(argv)
    const verb = argv.slice(1, 3).join(' ')
    if (verb === 'tab profile') return reply({ profiles: [{ id: 'p-work', label: 'grazr · work' }] })
    if (verb === 'worktree list') return reply({ worktrees: [{ id: 'w1', path: '/work' }] })
    if (verb === 'tab create') {
      await gate
      return reply({ browserPageId: 'page-1' })
    }
    if (verb === 'eval --page') return reply({ result: USAGE, origin: 'https://claude.ai/new#settings/usage' })
    return reply({})
  }
}

test('a card Refresh answers before the claude.ai reading, which then lands in storage and is posted to the open panel', async () => {
  let open
  const gate = new Promise((resolve) => { open = resolve })
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: orcaRoute(gate) })
  const outcome = await fake.panelHandlers.get('refresh')({ host: 'mac' })
  assert.equal(outcome.ok, true)
  assert.equal(fake.state.storage.limitResets, undefined)
  const posted = fake.posts.length
  open()
  await settle()
  await settle()
  assert.deepEqual(fake.state.storage.limitResets, {
    work: { readAt: 1000, state: 'ok', full: 0, model: 2, kinds: [{ kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }] },
  })
  assert.ok(fake.posts.length > posted)
  assert.ok(fake.posts.at(-1).payload.main.includes('active · 2 resets available'))
})

test('with readLimitResets off a Refresh opens no tab', async () => {
  const fake = await start({ stored: { hosts: [MAC], target: 'mac', readLimitResets: false }, route: orcaRoute(Promise.resolve()) })
  await fake.panelHandlers.get('refresh')({ host: 'mac' })
  await settle()
  assert.equal(fake.execs.some((argv) => argv[0] === '/usr/local/bin/orca' && argv[1] === 'tab'), false)
  assert.equal(fake.state.storage.limitResets, undefined)
})
