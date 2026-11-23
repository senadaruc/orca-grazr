import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLimitResets } from '../lib/usage-page-reader.mjs'
import { createAccountProfiles } from '../lib/browser-profiles.mjs'

const SETTINGS = { orcaBin: '/usr/local/bin/orca' }
const AT = 1_800_000_000_000
const USAGE = 'Usage\nYour usage limits\nLimit resets\n2 available\nFable reset · 2\nAll expire Mar 9, 2027, 8:59 AM GMT+1\nReset for free\nLast updated: just now'
const LOGIN = 'Log in or sign up\nContinue with email'

const reply = (result) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }) })
const refusal = (message) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { message } }) })

// A scripted Orca CLI: every call is recorded without the binary and --json; pages maps a profile id to the page text it shows.
// overrides answers a call by its first two words; at most one call may run at a time.
function fakeOrcaCli({ pages = {}, overrides = {}, worktrees = [{ id: 'w1', path: '/work', repo: { displayName: 'work' } }] } = {}) {
  const calls = []
  const opened = new Map()
  let running = 0
  let overlapped = false
  const exec = async (argv, opts) => {
    if (running > 0) overlapped = true
    running++
    await new Promise((resolve) => setImmediate(resolve))
    running--
    const args = argv.slice(1, -1)
    calls.push({ args, timeoutMs: opts?.timeoutMs })
    const key = args.slice(0, 2).join(' ')
    if (Object.hasOwn(overrides, key)) return overrides[key](args)
    const flag = (name) => args[args.indexOf(name) + 1]
    switch (key) {
      case 'tab profile': return reply({ profiles: [{ id: 'p-a', label: 'grazr · a' }, { id: 'p-b', label: 'grazr · b' }] })
      case 'worktree list': return reply({ worktrees })
      case 'tab create': {
        const page = `page-${opened.size + 1}`
        opened.set(page, flag('--profile'))
        return reply({ browserPageId: page })
      }
      case 'wait --page': return reply({ found: true })
      case 'eval --page': return reply({ result: pages[opened.get(flag('--page'))] ?? '', origin: 'https://claude.ai/new#settings/usage' })
      case 'tab close': return reply({ closed: true })
      default: return refusal(`unexpected ${key}`)
    }
  }
  return { exec, calls, overlapped: () => overlapped }
}

function storage(initial = {}) {
  const values = { ...initial }
  return { get: async (key) => values[key], set: async (key, value) => { values[key] = value } }
}

async function read(cli, { accounts = ['a', 'b', 'c'], previous = {}, settings = SETTINGS } = {}) {
  const logs = []
  const readings = await readLimitResets({
    ctx: { exec: cli.exec, settings, homedir: () => '/home/t' },
    accounts,
    profiles: createAccountProfiles({ storage: storage() }),
    previous,
    now: () => AT,
    log: (msg) => logs.push(msg),
  })
  return { readings, logs }
}

const verbs = (cli) => cli.calls.map(({ args }) => args.slice(0, 2).join(' '))

test('each account with a profile gets its page read in a tab of its own, one after another, the tab closed every time', async () => {
  const cli = fakeOrcaCli({ pages: { 'p-a': USAGE, 'p-b': LOGIN } })
  const { readings } = await read(cli)
  assert.deepEqual(verbs(cli), [
    'tab profile', 'worktree list',
    'tab create', 'wait --page', 'eval --page', 'tab close',
    'tab create', 'wait --page', 'eval --page', 'tab close',
  ])
  assert.equal(cli.overlapped(), false)
  assert.deepEqual(cli.calls[2].args, ['tab', 'create', '--worktree', 'id:w1', '--url', 'https://claude.ai/settings/usage', '--profile', 'p-a'])
  assert.deepEqual(cli.calls[3].args, ['wait', '--page', 'page-1', '--worktree', 'id:w1', '--text', 'Limit resets', '--timeout', '15000'])
  assert.equal(cli.calls[3].timeoutMs, 20000)
  assert.deepEqual(cli.calls[4].args.slice(0, 5), ['eval', '--page', 'page-1', '--worktree', 'id:w1'])
  assert.deepEqual(cli.calls[5].args, ['tab', 'close', '--page', 'page-1', '--worktree', 'id:w1'])
  assert.deepEqual(readings, {
    a: { readAt: AT, state: 'ok', full: 0, model: 2, kinds: [{ kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }] },
    b: { readAt: AT, state: 'signed-out' },
    c: { readAt: AT, state: 'no-profile' },
  })
})

test('nothing is ever focused, clicked or navigated: the only page commands are create, wait, eval and close', async () => {
  const cli = fakeOrcaCli({ pages: { 'p-a': USAGE, 'p-b': USAGE } })
  await read(cli)
  const all = cli.calls.flatMap(({ args }) => args)
  assert.equal(all.includes('--focus'), false)
  assert.deepEqual([...new Set(verbs(cli))].sort(), ['eval --page', 'tab close', 'tab create', 'tab profile', 'wait --page', 'worktree list'])
})

test('a page that cannot be read still has its tab closed, and keeps the account last good reading', async () => {
  const cli = fakeOrcaCli({ overrides: { 'eval --page': () => refusal('the page went away') } })
  const good = { readAt: AT - 3600000, state: 'ok', full: 1, model: 0, kinds: [] }
  const { readings, logs } = await read(cli, { accounts: ['a', 'b'], previous: { a: good } })
  assert.deepEqual(verbs(cli).filter((v) => v === 'tab close').length, 2)
  assert.deepEqual(readings, {
    a: { ...good, triedAt: AT },
    b: { readAt: AT, state: 'failed' },
  })
  assert.deepEqual(logs, [
    'grazr limit resets: the usage page of a was not read: the page went away',
    'grazr limit resets: the usage page of b was not read: the page went away',
  ])
})

test('a wait that throws still closes the tab', async () => {
  const cli = fakeOrcaCli({ overrides: { 'wait --page': () => { throw new Error('boom') } } })
  const { readings } = await read(cli, { accounts: ['a'] })
  assert.deepEqual(verbs(cli).slice(-1), ['tab close'])
  assert.deepEqual(readings, { a: { readAt: AT, state: 'failed' } })
})

test('a tab Orca does not open is not closed, and the account reads as failed', async () => {
  const cli = fakeOrcaCli({ overrides: { 'tab create': () => refusal('no browser') } })
  const { readings } = await read(cli, { accounts: ['a'] })
  assert.equal(verbs(cli).includes('tab close'), false)
  assert.deepEqual(readings, { a: { readAt: AT, state: 'failed' } })
})

test('with no workspace to open a tab in, nothing is read or stored, and the log says why once', async () => {
  const cli = fakeOrcaCli({ worktrees: [] })
  const { readings, logs } = await read(cli)
  assert.equal(readings, null)
  assert.equal(verbs(cli).includes('tab create'), false)
  assert.equal(logs.length, 1)
})

test('when Orca cannot list its browser profiles nothing is read or stored', async () => {
  const cli = fakeOrcaCli({ overrides: { 'tab profile': () => refusal('Orca is not running') } })
  const { readings, logs } = await read(cli)
  assert.equal(readings, null)
  assert.equal(verbs(cli).includes('tab create'), false)
  assert.deepEqual(logs, ['grazr limit resets: not read, Orca browser profiles unavailable: Orca is not running'])
})

test('readings of accounts not read this time are kept', async () => {
  const cli = fakeOrcaCli({ pages: { 'p-a': USAGE } })
  const other = { readAt: AT - 1000, state: 'ok', full: 1, model: 0, kinds: [] }
  const { readings } = await read(cli, { accounts: ['a'], previous: { z: other } })
  assert.deepEqual(Object.keys(readings).sort(), ['a', 'z'])
  assert.deepEqual(readings.z, other)
})

test('a page without a Limit resets section is waited for by its heading, the two waits bounded to 20 s in all', async () => {
  const cli = fakeOrcaCli({
    pages: { 'p-a': 'Your usage limits\nCurrent session\nLast updated: just now' },
    overrides: { 'wait --page': (args) => (args.includes('Limit resets') ? refusal('timed out') : reply({ found: true })) },
  })
  const { readings } = await read(cli, { accounts: ['a'] })
  const waits = cli.calls.filter(({ args }) => args[0] === 'wait').map(({ args }) => args.slice(-4))
  assert.deepEqual(waits, [['--text', 'Limit resets', '--timeout', '15000'], ['--text', 'Your usage', '--timeout', '5000']])
  assert.deepEqual(readings, { a: { readAt: AT, state: 'ok', full: 0, model: 0, kinds: [] } })
})
