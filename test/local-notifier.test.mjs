import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engine, label, start, statusRoute, hostCalls } from './support/plugin-harness.mjs'
import { report } from './support/plugin-harness.mjs'

const mac = (notifier) => ({ name: 'mac', ssh: null, python: 'python3', notifier })
const cloud = { name: 'devbox', ssh: 'devbox', python: 'python3', notifier: 'queue' }
const connected = () => engine({ 'status --json': { stdout: JSON.stringify({ ...report(), installed: true }) }, install: { stdout: 'ok\n' } })
const labels = (fake) => [...fake.activation, ...fake.execs].map(label)

test('a Mac still on the old osascript default moves to queue once, and its status line is reinstalled', async () => {
  const fake = await start({ stored: { hosts: [mac('osascript'), cloud] }, route: connected() })
  assert.equal(fake.state.settings.hosts[0].notifier, 'queue')
  assert.deepEqual(fake.state.settings.hosts[1], cloud)
  assert.equal(fake.state.storage.notifierMigrated, true)
  assert.ok(labels(fake).includes('install'))
  assert.deepEqual(fake.state.storage.shimNotifiers, { mac: 'queue' })
})

test('an osascript the user sets after the migration is kept and not migrated again', async () => {
  const fake = await start({ stored: { hosts: [mac('osascript'), cloud] }, storage: { notifierMigrated: true }, route: connected() })
  assert.equal(fake.state.settings.hosts[0].notifier, 'osascript')
  assert.ok(!labels(fake).includes('install'))
})

test('a Mac that is not connected is never reinstalled by the migration', async () => {
  const route = engine({ 'status --json': { stdout: JSON.stringify({ ...report(), installed: false }) }, install: { stdout: 'ok\n' } })
  const fake = await start({ stored: { hosts: [mac('osascript'), cloud] }, route })
  assert.equal(fake.state.settings.hosts[0].notifier, 'queue')
  assert.ok(!labels(fake).includes('install'))
})

test('a recorded notifier that differs from the setting reinstalls the shim', async () => {
  const fake = await start({ stored: { hosts: [mac('queue,osascript'), cloud] }, storage: { notifierMigrated: true, shimNotifiers: { mac: 'queue' } }, route: connected() })
  assert.ok(labels(fake).includes('install'))
  assert.deepEqual(fake.state.storage.shimNotifiers, { mac: 'queue,osascript' })
  assert.equal(hostCalls(fake, 'settings.set').filter((p) => p.key === 'hosts').length, 0)
})

test('the install command records the notifier its shim now carries', async () => {
  const fake = await start({ stored: { hosts: [mac('queue'), cloud] }, route: connected() })
  await fake.run('install')
  assert.deepEqual(fake.state.storage.shimNotifiers, { mac: 'queue' })
})
