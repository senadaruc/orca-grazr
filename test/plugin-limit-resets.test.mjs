import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start, statusRoute, settle, engine, report } from './support/plugin-harness.mjs'
import { ORG, answer, usageOk, proOrg, teamOrg, apiOrg, cedar, fullGrant, teamCedar } from './support/claude-data-fixture.mjs'

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
    work: { readAt: 1000, state: 'ok', full: 0, model: 2, kinds: [{ kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }], source: 'page', organizationUuid: null },
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

test("the scheduled reading reads each organization of a login with several from claude.ai's data, in one tab, stores the login's organizations and shows the one not enrolled", async () => {
  const accounts = [
    { name: 'work', id: 'a1', email: 'w@example.com', login: 'u1', organization_uuid: ORG.pro, snapshot: [] },
    { name: 'work:acme', id: 'a2', email: 'w@example.com', login: 'u1', organization_uuid: ORG.team, parked: true, snapshot: [] },
    { name: 'solo', id: 'a3', email: 's@example.com', login: 'u2', organization_uuid: ORG.max, snapshot: [] },
  ]
  const data = {
    'p-work': answer({ organizations: [proOrg('w@example.com'), teamOrg(), apiOrg()], usage: { [ORG.pro]: usageOk(cedar([fullGrant(1)])), [ORG.team]: usageOk(teamCedar()) }, selectedOrg: ORG.pro }),
  }
  const status = engine({ 'status --json': { stdout: JSON.stringify(report({ accounts })) } })
  const route = async (argv) => {
    if (argv[0] !== '/usr/local/bin/orca') return status(argv)
    const args = argv.slice(1, -1)
    const verb = args.slice(0, 2).join(' ')
    if (verb === 'tab profile') return reply({ profiles: [{ id: 'p-solo', label: 'grazr · s@example.com' }, { id: 'p-work', label: 'grazr · w@example.com' }] })
    if (verb === 'worktree list') return reply({ worktrees: [{ id: 'w1', path: '/work' }] })
    if (verb === 'tab create') return reply({ browserPageId: args[args.indexOf('--profile') + 1] })
    if (verb === 'eval --page') {
      const profile = args[args.indexOf('--page') + 1]
      if (args.at(-1).includes('XMLHttpRequest')) return data[profile] ? reply({ result: JSON.stringify(data[profile]) }) : { code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'no data' } }) }
      return reply({ result: USAGE, origin: 'https://claude.ai/new#settings/usage' })
    }
    return reply({})
  }
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route })
  await fake.panelHandlers.get('refresh')({ host: 'mac' })
  for (let i = 0; i < 8; i++) await settle()
  const readings = fake.state.storage.limitResets
  assert.deepEqual(Object.keys(readings).sort(), ['solo', 'work', 'work:acme'])
  assert.deepEqual([readings.work.organizationUuid, readings.work.full, readings.work.model], [ORG.pro, 1, 0])
  assert.deepEqual([readings['work:acme'].organizationUuid, readings['work:acme'].full, readings['work:acme'].model], [ORG.team, 0, 2])
  assert.deepEqual([readings.solo.source, readings.solo.model], ['page', 2], 'a single-organization login without data falls back to its page')
  const created = fake.execs.filter((a) => a[0] === '/usr/local/bin/orca' && a[1] === 'tab' && a[2] === 'create')
  assert.equal(created.length, 2, 'one tab per login')
  assert.deepEqual(fake.state.storage.organizations['w@example.com'].orgs.map((o) => o.kind), ['subscription', 'subscription', 'api'])
  const main = fake.posts.at(-1).payload.main
  assert.ok(main.includes('API console organization — not a Claude subscription'), 'the API organization shows greyed in the login group')
  assert.ok(main.includes('data-command="limit-reset-full" data-params="{&quot;host&quot;:&quot;mac&quot;}"'), 'the active organization offers its own full reset')
})
