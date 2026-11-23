import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLimitResets } from '../lib/usage-page-reader.mjs'
import { createAccountProfiles } from '../lib/browser-profiles.mjs'
import { ORG, answer, usageOk, teamCedar, freeOrg, teamOrg, apiOrg, proOrg, cedar, fullGrant } from './support/claude-data-fixture.mjs'

const SETTINGS = { orcaBin: '/usr/local/bin/orca' }
const AT = 1_800_000_000_000
const USAGE = 'Usage\nYour usage limits\nLimit resets\n2 available\nFable reset · 2\nAll expire Mar 9, 2027, 8:59 AM GMT+1\nReset for free\nLast updated: just now'
const LOGIN = 'Log in or sign up\nContinue with email'

const reply = (result) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }) })
const refusal = (message) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { message } }) })

// A scripted Orca CLI: every call is recorded without the binary and --json; pages maps a profile id to the page text it
// shows, data to the answer its organizations request gets (none: the request fails, as an eval Orca refuses).
// overrides answers a call by its first two words; at most one call may run at a time.
function fakeOrcaCli({ pages = {}, data = {}, overrides = {}, worktrees = [{ id: 'w1', path: '/work', repo: { displayName: 'work' } }] } = {}) {
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
      case 'eval --page': {
        const profile = opened.get(flag('--page'))
        if (flag('--expression').includes('XMLHttpRequest')) {
          return Object.hasOwn(data, profile) ? reply({ result: JSON.stringify(data[profile]), origin: 'https://claude.ai/new' }) : refusal('the data could not be read')
        }
        return reply({ result: pages[profile] ?? '', origin: 'https://claude.ai/new#settings/usage' })
      }
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

async function read(cli, { accounts = ['a', 'b', 'c'], previous = {}, organizations = {}, settings = SETTINGS, profiles = {} } = {}) {
  const logs = []
  const result = await readLimitResets({
    ctx: { exec: cli.exec, settings, homedir: () => '/home/t' },
    accounts,
    profiles: createAccountProfiles({ storage: storage(profiles) }),
    previous,
    organizations,
    now: () => AT,
    log: (msg) => logs.push(msg),
    timeZone: 'UTC',
  })
  return { readings: result?.readings ?? null, organizations: result?.organizations ?? null, result, logs }
}

const verbs = (cli) => cli.calls.map(({ args }) => args.slice(0, 2).join(' '))

test('without claude.ai data each single-organization login falls back to its page text, in a tab of its own, one after another, the tab closed every time', async () => {
  const cli = fakeOrcaCli({ pages: { 'p-a': USAGE, 'p-b': LOGIN } })
  const { readings } = await read(cli)
  assert.deepEqual(verbs(cli), [
    'tab profile', 'worktree list',
    'tab create', 'wait --page', 'eval --page', 'eval --page', 'tab close',
    'tab create', 'wait --page', 'eval --page', 'eval --page', 'tab close',
  ])
  assert.equal(cli.overlapped(), false)
  assert.deepEqual(cli.calls[2].args, ['tab', 'create', '--worktree', 'id:w1', '--url', 'https://claude.ai/settings/usage', '--profile', 'p-a'])
  assert.deepEqual(cli.calls[3].args, ['wait', '--page', 'page-1', '--worktree', 'id:w1', '--text', 'Limit resets', '--timeout', '15000'])
  assert.equal(cli.calls[3].timeoutMs, 20000)
  assert.deepEqual(cli.calls[4].args.slice(0, 5), ['eval', '--page', 'page-1', '--worktree', 'id:w1'])
  assert.deepEqual(cli.calls[6].args, ['tab', 'close', '--page', 'page-1', '--worktree', 'id:w1'])
  assert.deepEqual(readings, {
    a: { readAt: AT, state: 'ok', full: 0, model: 2, kinds: [{ kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }], source: 'page', organizationUuid: null },
    b: { readAt: AT, state: 'signed-out' },
    c: { readAt: AT, state: 'no-profile' },
  })
})

test('nothing is ever focused, clicked or navigated: the only page commands are create, wait, eval and close', async () => {
  const cli = fakeOrcaCli({ pages: { 'p-a': USAGE, 'p-b': USAGE } })
  await read(cli)
  const all = cli.calls.flatMap(({ args }) => args)
  assert.equal(all.includes('--focus'), false)
  assert.equal(cli.calls.some(({ args }) => args[0] === 'eval' && /focus/i.test(args.at(-1))), false)
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
  assert.deepEqual(logs.filter((l) => l.includes('were not read:')), [
    'grazr limit resets: the limit resets of a were not read: the page went away',
    'grazr limit resets: the limit resets of b were not read: the page went away',
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
  assert.deepEqual(readings, { a: { readAt: AT, state: 'ok', full: 0, model: 0, kinds: [], source: 'page', organizationUuid: null } })
})

test("an account given with its login's e-mail is read in the login's profile and stored under its own name", async () => {
  const cli = fakeOrcaCli({ pages: { 'p-a': USAGE } })
  const { readings } = await read(cli, { accounts: [{ name: 'a:acme', email: 'a' }] })
  assert.deepEqual(Object.keys(readings), ['a:acme'])
  assert.equal(readings['a:acme'].state, 'ok')
})

// The login pat@example.com, whose profile is p-a: a free personal organization, the Team organization Acme and an API
// console organization.
const PAT = 'pat@example.com'
const patProfile = { [PAT]: 'p-a' }
const patData = (extra = {}) => answer({
  organizations: [freeOrg(PAT), teamOrg(), apiOrg()],
  usage: { [ORG.free]: usageOk(cedar([], { eligible: false, ineligible_reason: 'tier' })), [ORG.team]: usageOk(teamCedar()) },
  selectedOrg: ORG.free,
  ...extra,
})

test("an account's reading is its own organization's grants, read in one tab per login, and the login's organizations are kept", async () => {
  const cli = fakeOrcaCli({ data: { 'p-a': patData() }, pages: { 'p-a': USAGE } })
  const { readings, organizations } = await read(cli, { accounts: [{ name: 'pat:acme', email: 'Pat@Example.com', organizationUuid: ORG.team }], profiles: { browserProfiles: patProfile } })
  assert.deepEqual(verbs(cli), ['tab profile', 'worktree list', 'tab create', 'wait --page', 'eval --page', 'tab close'], 'the page text is not read')
  assert.deepEqual(readings['pat:acme'], {
    readAt: AT, state: 'ok', full: 0, model: 2,
    kinds: [{ kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 7:59 AM UTC', expiresAt: '2027-03-09T07:59:00.000Z', usableNow: true, unavailableReason: null }],
    usableNow: { full: null, model: true },
    source: 'api', organizationUuid: ORG.team,
  })
  assert.deepEqual(Object.keys(organizations), [PAT])
  assert.equal(organizations[PAT].state, 'ok')
  assert.deepEqual(organizations[PAT].orgs.map((o) => [o.uuid, o.label, o.plan, o.kind, o.claudeCode]), [
    [ORG.free, 'Personal', 'Free', 'free', false],
    [ORG.team, 'Acme', 'Team', 'subscription', true],
    [ORG.api, 'Acme API', 'API', 'api', false],
  ])
})

test('two organizations of one login get each their own reading from one tab, never the other one', async () => {
  const data = answer({
    organizations: [proOrg(PAT), teamOrg()],
    usage: { [ORG.pro]: usageOk(cedar([fullGrant(1)])), [ORG.team]: usageOk(teamCedar()) },
    selectedOrg: ORG.team,
  })
  const cli = fakeOrcaCli({ data: { 'p-a': data } })
  const accounts = [
    { name: PAT, email: PAT, organizationUuid: ORG.pro, several: true },
    { name: `${PAT}:acme`, email: PAT, organizationUuid: ORG.team, several: true },
  ]
  const { readings } = await read(cli, { accounts, profiles: { browserProfiles: patProfile } })
  assert.equal(verbs(cli).filter((v) => v === 'tab create').length, 1)
  assert.deepEqual([readings[PAT].organizationUuid, readings[PAT].full, readings[PAT].model], [ORG.pro, 1, 0])
  assert.deepEqual([readings[`${PAT}:acme`].organizationUuid, readings[`${PAT}:acme`].full, readings[`${PAT}:acme`].model], [ORG.team, 0, 2])
})

test('when the data cannot be read, a login with several organizations gets no reading from the page, and its list is kept', async () => {
  const cli = fakeOrcaCli({ pages: { 'p-a': USAGE } })
  const accounts = [
    { name: PAT, email: PAT, organizationUuid: ORG.pro, several: true },
    { name: `${PAT}:acme`, email: PAT, organizationUuid: ORG.team, several: true },
  ]
  const kept = { [PAT]: { readAt: AT - 1000, state: 'ok', orgs: [{ uuid: ORG.team, label: 'Acme', claudeCode: true }] } }
  const { readings, organizations, logs } = await read(cli, { accounts, organizations: kept, profiles: { browserProfiles: patProfile } })
  assert.equal(verbs(cli).filter((v) => v === 'eval --page').length, 1, 'the page text is never read')
  assert.deepEqual(readings, { [PAT]: { readAt: AT, state: 'failed' }, [`${PAT}:acme`]: { readAt: AT, state: 'failed' } })
  assert.deepEqual(organizations[PAT], { readAt: AT - 1000, triedAt: AT, state: 'failed', orgs: kept[PAT].orgs })
  assert.ok(logs.some((l) => l.includes('the Usage page cannot tell the organizations of its login apart')))
})

test('a single-organization login whose data lacks its grants falls back to the page text, filed under its organization', async () => {
  const data = patData({ usage: { [ORG.team]: { status: 500 } } })
  const cli = fakeOrcaCli({ data: { 'p-a': data }, pages: { 'p-a': USAGE } })
  const { readings, logs } = await read(cli, { accounts: [{ name: 'pat:acme', email: PAT, organizationUuid: ORG.team }], profiles: { browserProfiles: patProfile } })
  assert.deepEqual([readings['pat:acme'].source, readings['pat:acme'].organizationUuid, readings['pat:acme'].model], ['page', ORG.team, 2])
  assert.ok(logs.includes("grazr limit resets: pat:acme: read from the Usage page's text instead"))
})

test('an account an older engine gives no organization uuid is read from its login only subscription organization', async () => {
  const cli = fakeOrcaCli({ data: { 'p-a': patData() } })
  const { readings } = await read(cli, { accounts: [{ name: PAT, email: PAT, organizationUuid: null }], profiles: { browserProfiles: patProfile } })
  assert.deepEqual([readings[PAT].source, readings[PAT].organizationUuid], ['api', ORG.team])
})

test('a profile claude.ai refuses the organizations to is signed out, and keeps its organizations', async () => {
  const cli = fakeOrcaCli({ data: { 'p-a': { signedIn: false, status: 401 } } })
  const kept = { [PAT]: { readAt: AT - 1000, state: 'ok', orgs: [{ uuid: ORG.team, label: 'Acme', claudeCode: true }] } }
  const { readings, organizations } = await read(cli, { accounts: [{ name: PAT, email: PAT, organizationUuid: ORG.team }], organizations: kept, profiles: { browserProfiles: patProfile } })
  assert.deepEqual(readings[PAT], { readAt: AT, state: 'signed-out' })
  assert.deepEqual(organizations[PAT], { readAt: AT, state: 'signed-out', orgs: kept[PAT].orgs })
})
