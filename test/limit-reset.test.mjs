import { test } from 'node:test'
import assert from 'node:assert/strict'
import { limitResetText } from '../lib/limit-reset.mjs'
import { start, engine, label } from './support/plugin-harness.mjs'

const hostCalls = (fake, name) => fake.calls.filter((c) => c.name === name).map((c) => c.params)
const call = (fake, id, params) => fake.plugin.commands[id](params)
const TERMINALS = { branch: 'main', displayName: 'x', terminals: [{ id: 'agent' }, { id: 'shell' }] }

test('on this Mac the reset command is Claude Code with its own /limit-reset and the kind', () => {
  assert.equal(limitResetText({ name: 'mac', ssh: null }, 'fable'), "claude '/limit-reset fable'")
  assert.equal(limitResetText({ name: 'mac', ssh: null }, 'full'), "claude '/limit-reset full'")
})

test('on a remote host the reset command runs Claude there, in a login shell over ssh -t', () => {
  assert.equal(
    limitResetText({ name: 'devbox', ssh: 'devbox' }, 'full'),
    `ssh -t devbox 'exec "$SHELL" -lic '\\''claude "/limit-reset full"'\\'''`,
  )
})

test('the model reset is typed into the newest terminal, not run, and the toast says Claude asks first', async () => {
  const fake = await start({ context: TERMINALS })
  const outcome = await call(fake, 'limit-reset-model', { host: 'mac' })
  assert.deepEqual(hostCalls(fake, 'terminal.sendText'), [{ terminalId: 'shell', text: "claude '/limit-reset fable'", enter: false }])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.message, 'mac: Typed the reset command into the newest terminal\nPress Return there. Claude asks before it uses the reset.')
})

test('the full reset on a remote host types the ssh form for that host', async () => {
  const fake = await start({ context: TERMINALS })
  await call(fake, 'limit-reset-full', { host: 'devbox' })
  const [sent] = hostCalls(fake, 'terminal.sendText')
  assert.equal(sent.text, `ssh -t devbox 'exec "$SHELL" -lic '\\''claude "/limit-reset full"'\\'''`)
  assert.equal(sent.enter, false)
})

test('with no terminal open nothing is typed, and the message gives the command to run', async () => {
  const fake = await start({ context: null })
  const outcome = await call(fake, 'limit-reset-model', { host: 'mac' })
  assert.equal(hostCalls(fake, 'terminal.sendText').length, 0)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.message, "mac: Open a shell terminal in a worktree first\nThen run: claude '/limit-reset fable'")
})

test('a reset for a host the settings do not name types nothing', async () => {
  const fake = await start({ context: TERMINALS })
  const outcome = await call(fake, 'limit-reset-full', { host: 'nowhere' })
  assert.equal(hostCalls(fake, 'terminal.sendText').length, 0)
  assert.equal(outcome.message, 'unknown host nowhere; refresh the panel')
})

test('a reset for a parked account swaps to it on that host first, then types the command', async () => {
  const fake = await start({ context: TERMINALS, route: engine({ 'swap a@b': { stdout: 'Rotated x -> a@b\n' } }) })
  const outcome = await call(fake, 'limit-reset-full', { host: 'mac', account: 'a@b' })
  assert.ok(fake.execs.some((a) => label(a) === 'swap a@b'))
  assert.deepEqual(hostCalls(fake, 'terminal.sendText'), [{ terminalId: 'shell', text: "claude '/limit-reset full'", enter: false }])
  assert.equal(outcome.message, 'mac: Swapped to a@b and typed the reset command into the newest terminal\nPress Return there. Claude asks before it uses the reset.')
})

test('a swap the engine refuses types nothing', async () => {
  const fake = await start({ context: TERMINALS, route: engine({ 'swap a@b': { code: 1, stdout: 'grazr: a@b failed with authentication_failed, enrol it again first\n' } }) })
  const outcome = await call(fake, 'limit-reset-model', { host: 'mac', account: 'a@b' })
  assert.equal(outcome.ok, false)
  assert.equal(hostCalls(fake, 'terminal.sendText').length, 0)
})

test('with no terminal open a parked account is not swapped to', async () => {
  const fake = await start({ context: null, route: engine({ 'swap a@b': { stdout: 'ok\n' } }) })
  const outcome = await call(fake, 'limit-reset-model', { host: 'mac', account: 'a@b' })
  assert.equal(outcome.ok, false)
  assert.equal(fake.execs.some((a) => label(a) === 'swap a@b'), false)
})
