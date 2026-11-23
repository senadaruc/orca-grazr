import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccountProfiles, onClaude, profileLabel, CLAUDE_URL, STORAGE_KEY } from '../lib/browser-profiles.mjs'
import { mergeSettings } from '../lib/hosts.mjs'

const SETTINGS = mergeSettings({})
const ORCA = SETTINGS.orcaBin
const json = (value) => JSON.stringify(value, null, 2)
const WORKTREE = { id: 'fc5::/home/t/grazr', path: '/home/t/grazr', repo: { displayName: 'orca-grazr' } }
const argAfter = (args, flag) => args[args.indexOf(flag) + 1]

// A fake Orca: profiles and tabs it keeps, answered by the command's words; overrides answer in place of a route.
function world({ profiles = [], tabs = [], stored = {}, overrides = {}, storeThrows = false } = {}) {
  const calls = []
  const logs = []
  const store = { ...stored }
  let made = 0
  let pages = 0
  const routes = {
    'tab profile list': () => ({ ok: true, result: { profiles } }),
    'tab profile create': (args) => {
      const profile = { id: `p${++made}`, label: argAfter(args, '--label') }
      profiles.push(profile)
      return { ok: true, result: { profile } }
    },
    'tab list': () => ({ ok: true, result: { tabs } }),
    'tab switch': () => ({ ok: true, result: {} }),
    'tab create': () => ({ ok: true, result: { browserPageId: `page-${++pages}` } }),
    'worktree list': () => ({ ok: true, result: { worktrees: [WORKTREE] } }),
  }
  const exec = async (argv) => {
    assert.equal(argv[0], ORCA)
    const args = argv.slice(1, -1)
    const line = args.join(' ')
    calls.push(args)
    const key = Object.keys(routes).find((k) => line.startsWith(k))
    const reply = key === undefined ? { ok: false, error: { message: `no route for ${line}` } } : (overrides[key] ?? routes[key])(args)
    return { argv, code: reply.ok ? 0 : 1, signal: null, stdout: json(reply), stderr: '', timedOut: false, spawnError: null }
  }
  const storage = {
    get: async (key) => store[key],
    set: async (key, value) => {
      if (storeThrows) throw new Error('storage full')
      store[key] = value
    },
  }
  const ctx = { exec, settings: SETTINGS, homedir: () => '/home/t' }
  const profilesApi = createAccountProfiles({ storage, log: (m) => logs.push(m) })
  const callsWith = (text) => calls.filter((args) => args.join(' ').includes(text))
  return { ctx, profiles: profilesApi, calls, callsWith, logs, store, orca: { profiles, tabs } }
}

test('onClaude accepts claude.ai and claude.com and their subdomains over https only', () => {
  assert.equal(onClaude('https://claude.ai/new'), true)
  assert.equal(onClaude('https://www.claude.com/'), true)
  assert.equal(onClaude('http://claude.ai/'), false)
  assert.equal(onClaude('https://claude.ai.evil.io/'), false)
  assert.equal(onClaude('https://platform.claude.com/oauth/code/callback'), true)
  assert.equal(onClaude('not a url'), false)
})

test('ensure finds the stored profile by id, even relabelled, and does not write the store again', async () => {
  const w = world({ profiles: [{ id: 'p9', label: 'My work jar' }], stored: { [STORAGE_KEY]: { 'a@example.com': 'p9' } } })
  assert.deepEqual(await w.profiles.ensure(w.ctx, 'a@example.com'), { ok: true, id: 'p9', created: false })
  assert.equal(w.callsWith('tab profile create').length, 0)
  assert.deepEqual(w.store[STORAGE_KEY], { 'a@example.com': 'p9' })
})

test('ensure falls back to the labelled profile when the stored id is gone, and remembers the new id', async () => {
  const w = world({ profiles: [{ id: 'p2', label: profileLabel('a@example.com') }], stored: { [STORAGE_KEY]: { 'a@example.com': 'gone', 'c@example.com': 'p5' } } })
  assert.deepEqual(await w.profiles.ensure(w.ctx, 'a@example.com'), { ok: true, id: 'p2', created: false })
  assert.deepEqual(w.store[STORAGE_KEY], { 'a@example.com': 'p2', 'c@example.com': 'p5' }, 'the other mapping is kept')
})

test('ensure creates an isolated profile labelled for the account when there is none, from the create reply', async () => {
  const w = world()
  assert.deepEqual(await w.profiles.ensure(w.ctx, 'a@example.com'), { ok: true, id: 'p1', created: true })
  const create = w.callsWith('tab profile create')[0]
  assert.deepEqual(create, ['tab', 'profile', 'create', '--label', 'grazr · a@example.com', '--scope', 'isolated'])
  assert.equal(w.callsWith('tab profile list').length, 1, 'the reply carried the id, so the list is not read again')
  assert.deepEqual(w.store[STORAGE_KEY], { 'a@example.com': 'p1' })
})

test('ensure lists again when an older Orca answers a create with nothing', async () => {
  const w = world({ overrides: { 'tab profile create': (args) => { w.orca.profiles.push({ id: 'p7', label: argAfter(args, '--label') }); return { ok: true, result: {} } } } })
  assert.deepEqual(await w.profiles.ensure(w.ctx, 'a@example.com'), { ok: true, id: 'p7', created: true })
  assert.equal(w.callsWith('tab profile list').length, 2)
})

test('ensure refuses a name that would read as an option, and reports a list or create failure', async () => {
  const w = world({ overrides: { 'tab profile create': () => ({ ok: false, error: { message: 'profiles are read-only' } }) } })
  assert.deepEqual(await w.profiles.ensure(w.ctx, '-x'), { ok: false, message: 'That account name cannot have a browser profile' })
  assert.deepEqual(await w.profiles.ensure(w.ctx, 'a@example.com'), { ok: false, message: 'profiles are read-only' })
  const down = world({ overrides: { 'tab profile list': () => ({ ok: false, error: { message: 'no answer' } }) } })
  assert.deepEqual(await down.profiles.ensure(down.ctx, 'a@example.com'), { ok: false, message: 'no answer' })
})

test('a store that fails is logged and never fails the profile', async () => {
  const w = world({ storeThrows: true })
  assert.equal((await w.profiles.ensure(w.ctx, 'a@example.com')).ok, true)
  assert.ok(w.logs.some((m) => m === 'grazr profiles: the profile of a@example.com was not stored: storage full'))
})

test('openClaude switches to an open claude.ai tab in the account profile and brings its workspace to the front', async () => {
  const w = world({
    profiles: [{ id: 'p1', label: profileLabel('a@example.com') }],
    tabs: [
      { browserPageId: 'page-x', url: 'https://claude.ai/new', profileId: 'other', worktreeId: WORKTREE.id },
      { browserPageId: 'page-y', url: 'https://example.com/', profileId: 'p1', worktreeId: WORKTREE.id },
      { browserPageId: 'page-z', url: 'https://claude.ai/chat/1', profileId: 'p1', worktreeId: WORKTREE.id },
    ],
  })
  assert.deepEqual(await w.profiles.openClaude(w.ctx, SETTINGS, 'a@example.com'), { ok: true, message: 'Switched to the claude.ai tab of a@example.com' })
  assert.deepEqual(w.callsWith('tab switch')[0], ['tab', 'switch', '--page', 'page-z', '--worktree', `id:${WORKTREE.id}`, '--focus'])
  assert.equal(w.callsWith('tab create').length, 0)
})

test('openClaude opens claude.ai in the sign-in workspace in the account profile when no tab is open, and says so', async () => {
  const w = world({ profiles: [{ id: 'p1', label: profileLabel('a@example.com') }] })
  assert.deepEqual(await w.profiles.openClaude(w.ctx, SETTINGS, 'a@example.com'), { ok: true, message: 'Opened claude.ai as a@example.com in the orca-grazr workspace' })
  assert.deepEqual(w.callsWith('tab create')[0], ['tab', 'create', '--worktree', `id:${WORKTREE.id}`, '--url', CLAUDE_URL, '--profile', 'p1'])
  assert.deepEqual(w.callsWith('tab switch')[0], ['tab', 'switch', '--page', 'page-1', '--worktree', `id:${WORKTREE.id}`, '--focus'])
})

test('openClaude for an account with no profile yet creates one and asks for the one sign-in', async () => {
  const w = world()
  const opened = await w.profiles.openClaude(w.ctx, SETTINGS, 'a@example.com')
  assert.equal(opened.ok, true)
  assert.equal(opened.message, 'Opened claude.ai as a@example.com in the orca-grazr workspace — sign in once there; Grazr keeps that profile for the account')
  assert.deepEqual(w.store[STORAGE_KEY], { 'a@example.com': 'p1' })
})

test('openClaude opens a new tab when the open one cannot be switched to', async () => {
  const w = world({
    profiles: [{ id: 'p1', label: profileLabel('a@example.com') }],
    tabs: [{ browserPageId: 'page-z', url: 'https://claude.ai/', profileId: 'p1' }],
    overrides: { 'tab switch': (args) => (argAfter(args, '--page') === 'page-z' ? { ok: false, error: { message: 'no such tab' } } : { ok: true, result: {} }) },
  })
  const opened = await w.profiles.openClaude(w.ctx, SETTINGS, 'a@example.com')
  assert.equal(opened.ok, true)
  assert.equal(w.callsWith('tab create').length, 1)
  assert.ok(w.logs.some((m) => m.includes('could not be brought to the front: no such tab')))
})

test('openClaude reports a missing workspace, a failed tab, and a profile it could not get', async () => {
  const none = world({ profiles: [{ id: 'p1', label: profileLabel('a@example.com') }], overrides: { 'worktree list': () => ({ ok: true, result: { worktrees: [] } }) } })
  assert.equal((await none.profiles.openClaude(none.ctx, SETTINGS, 'a@example.com')).message, 'Sign-in needs a local project in Orca: add any folder on this Mac as a project (Orca › Add project), then click again')
  const failed = world({ profiles: [{ id: 'p1', label: profileLabel('a@example.com') }], overrides: { 'tab create': () => ({ ok: false, error: { message: 'no browser' } }) } })
  assert.deepEqual(await failed.profiles.openClaude(failed.ctx, SETTINGS, 'a@example.com'), { ok: false, message: "Orca's browser in the orca-grazr workspace could not open claude.ai: no browser" })
  const down = world({ overrides: { 'tab profile list': () => ({ ok: false, error: { message: 'no answer' } }) } })
  assert.deepEqual(await down.profiles.openClaude(down.ctx, SETTINGS, 'a@example.com'), { ok: false, message: 'No browser profile for a@example.com: no answer' })
})
