import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start, engine, label, report, toasts } from './support/plugin-harness.mjs'
import { CLAUDE_URL } from '../lib/browser-profiles.mjs'

// The plugin's claude.ai opening: the open-browser command and the swap's follow-up, against a fake Orca CLI.
const ORCA = '/usr/local/bin/orca'
const WORKTREE = { id: 'fc5::/p/orca-grazr', path: '/p/orca-grazr', repo: { displayName: 'orca-grazr' } }
const call = (fake, id, params) => fake.plugin.commands[id](params)
const argAfter = (args, flag) => args[args.indexOf(flag) + 1]

// Answers Orca by the command's words and the engine from its table; the profiles and tabs Orca keeps are returned.
function withOrca(table = {}, { tabs = [] } = {}) {
  const profiles = []
  const engineRoute = engine({ 'status --json': { stdout: JSON.stringify(report()) }, ...table })
  const route = (argv, opts) => {
    if (argv[0] !== ORCA) return engineRoute(argv, opts)
    const args = argv.slice(1, -1)
    const line = args.join(' ')
    const answer = (reply) => ({ code: reply.ok ? 0 : 1, stdout: JSON.stringify(reply) })
    if (line.startsWith('tab profile list')) return answer({ ok: true, result: { profiles } })
    if (line.startsWith('tab profile create')) {
      const profile = { id: `p${profiles.length + 1}`, label: argAfter(args, '--label') }
      profiles.push(profile)
      return answer({ ok: true, result: { profile } })
    }
    if (line.startsWith('tab list')) return answer({ ok: true, result: { tabs } })
    if (line.startsWith('worktree list')) return answer({ ok: true, result: { worktrees: [WORKTREE] } })
    if (line.startsWith('tab create')) return answer({ ok: true, result: { browserPageId: 'page-1' } })
    if (line.startsWith('tab switch')) return answer({ ok: true, result: {} })
    return answer({ ok: false, error: { message: `no route for ${line}` } })
  }
  return { route, profiles }
}

const orcaCalls = (fake, text) => fake.execs.filter((a) => a[0] === ORCA && a.slice(1).join(' ').includes(text)).map((a) => a.slice(1, -1))
const statusCalls = (fake) => fake.execs.filter((a) => label(a) === 'status --json')

async function until(pred) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition not met')
}

test('open-browser from the panel opens claude.ai as the named account in its own profile, and toasts', async () => {
  const orca = withOrca()
  const fake = await start({ route: orca.route })
  const outcome = await call(fake, 'open-browser', { host: 'devbox', account: 'a@b' })
  assert.deepEqual(outcome, { ok: true, message: 'devbox: claude.ai\nOpened claude.ai as a@b in the orca-grazr workspace — sign in once there; Grazr keeps that profile for the account' })
  assert.deepEqual(orca.profiles, [{ id: 'p1', label: 'grazr · a@b' }])
  assert.deepEqual(orcaCalls(fake, 'tab create')[0], ['tab', 'create', '--worktree', `id:${WORKTREE.id}`, '--url', CLAUDE_URL, '--profile', 'p1'])
  assert.equal(statusCalls(fake).length, 1, "a named account's e-mail is read from a fresh status")
  assert.deepEqual(toasts(fake).at(-1), { title: 'devbox: claude.ai', body: 'Opened claude.ai as a@b in the orca-grazr workspace — sign in once there; Grazr keeps that profile for the account' })
  assert.deepEqual(fake.state.storage.browserProfiles, { 'a@b': 'p1' })
})

test("open-browser for a second organization of a login opens it in the login's profile, found by the e-mail from the status", async () => {
  const accounts = [
    { name: 'a@b.io', id: 'u1', email: 'a@b.io', login: 'u1', organization_uuid: 'o1' },
    { name: 'a@b.io:acme', id: 'u1.o2', email: 'a@b.io', login: 'u1', organization_uuid: 'o2' },
  ]
  const orca = withOrca({ 'status --json': { stdout: JSON.stringify(report({ accounts })) } })
  orca.profiles.push({ id: 'p7', label: 'grazr · a@b.io' })
  const fake = await start({ route: orca.route, storage: { browserProfiles: { 'a@b.io': 'p7' } } })
  const outcome = await call(fake, 'open-browser', { host: 'devbox', account: 'a@b.io:acme' })
  assert.equal(outcome.message, 'devbox: claude.ai\nOpened claude.ai as a@b.io:acme in the orca-grazr workspace')
  assert.equal(orcaCalls(fake, 'tab profile create').length, 0, 'no profile of its own is made')
  assert.equal(argAfter(orcaCalls(fake, 'tab create')[0], '--profile'), 'p7')
  assert.deepEqual(fake.state.storage.browserProfiles, { 'a@b.io': 'p7', 'a@b.io:acme': 'p7' })
})

test('open-browser from the palette opens claude.ai as the active account of the server', async () => {
  const orca = withOrca()
  const fake = await start({ route: orca.route })
  const outcome = await call(fake, 'open-browser', undefined)
  assert.equal(outcome.ok, true)
  assert.equal(statusCalls(fake).length, 1)
  assert.deepEqual(orca.profiles, [{ id: 'p1', label: 'grazr · work' }])
  assert.match(outcome.message, /^mac: claude\.ai\nOpened claude\.ai as work /)
})

test('open-browser with nobody logged in opens nothing and says so', async () => {
  const orca = withOrca({ 'status --json': { stdout: JSON.stringify(report({ active: null })) } })
  const fake = await start({ route: orca.route })
  const outcome = await call(fake, 'open-browser', { host: 'mac' })
  assert.deepEqual(outcome, { ok: false, message: 'mac: claude.ai not opened\nmac: nobody is logged in, so there is no account to open claude.ai as' })
  assert.equal(orcaCalls(fake, 'tab').length, 0)
})

test('a swap to a named account answers at once, then opens claude.ai as that account and toasts the outcome', async () => {
  const orca = withOrca({ 'swap a@b': { stdout: 'swapped\n' } })
  const fake = await start({ route: orca.route })
  const outcome = await call(fake, 'swap', { host: 'devbox', account: 'a@b' })
  assert.deepEqual(outcome, { ok: true, message: 'devbox: swap\nswapped\nOpening claude.ai as a@b…' })
  await until(() => toasts(fake).some((t) => t.title === 'devbox: claude.ai'))
  assert.equal(argAfter(orcaCalls(fake, 'tab create')[0], '--profile'), 'p1')
  assert.deepEqual(orca.profiles, [{ id: 'p1', label: 'grazr · a@b' }])
})

test('a swap to the next account reads the status for the account it landed on, then opens claude.ai as it', async () => {
  const orca = withOrca({ swap: { stdout: 'swapped\n' } })
  const fake = await start({ route: orca.route })
  const outcome = await call(fake, 'swap', { host: 'mac' })
  assert.equal(outcome.message, 'mac: swap\nswapped\nOpening claude.ai as the active account…')
  await until(() => toasts(fake).some((t) => t.title === 'mac: claude.ai'))
  assert.deepEqual(orca.profiles, [{ id: 'p1', label: 'grazr · work' }])
})

test('a failed swap, or browserOnSwap off, opens no browser', async () => {
  const refused = withOrca({ swap: { code: 1, stdout: 'grazr: Nothing to swap to\n' } })
  const failed = await start({ route: refused.route })
  const outcome = await call(failed, 'swap', { host: 'mac' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.message.includes('Opening claude.ai'), false)
  const off = withOrca({ swap: { stdout: 'swapped\n' } })
  const quiet = await start({ stored: { browserOnSwap: false }, route: off.route })
  assert.deepEqual(await call(quiet, 'swap', { host: 'mac' }), { ok: true, message: 'mac: swap\nswapped' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(orcaCalls(failed, 'tab').length + orcaCalls(quiet, 'tab').length, 0)
})

test('a claude.ai that could not be opened after a swap is a toast of its own, and the swap still counts', async () => {
  const orca = withOrca({ 'swap a@b': { stdout: 'swapped\n' } })
  const broken = (argv, opts) => (argv[0] === ORCA && argv[1] === 'tab' && argv[2] === 'create' ? { code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'no browser' } }) } : orca.route(argv, opts))
  const fake = await start({ route: broken })
  const outcome = await call(fake, 'swap', { host: 'devbox', account: 'a@b' })
  assert.equal(outcome.ok, true)
  await until(() => toasts(fake).some((t) => t.title === 'devbox: claude.ai not opened'))
  assert.equal(toasts(fake).at(-1).body, "Orca's browser in the orca-grazr workspace could not open claude.ai: no browser")
})
