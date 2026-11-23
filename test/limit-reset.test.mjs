import { test } from 'node:test'
import assert from 'node:assert/strict'
import { start, statusRoute, settle, label, toasts, hostCalls, report } from './support/plugin-harness.mjs'
import { usagePage, button } from './support/fake-usage-page.mjs'
import { ORG, proOrg, teamOrg, cedar, fullGrant, teamCedar } from './support/claude-data-fixture.mjs'
import { NOTHING_TO_RESET, SEVERAL_ORGANIZATIONS, UNCONFIRMED } from '../lib/limit-reset-use.mjs'

const MAC = { name: 'mac', ssh: null, python: 'python3', notifier: 'osascript' }
const REMOTE = { name: 'devbox', ssh: 'devbox', python: 'python3', notifier: 'queue' }
const ORCA = '/usr/local/bin/orca'
const reply = (result) => ({ stdout: JSON.stringify({ ok: true, result }) })
const PROFILES = [{ id: 'p-work', label: 'grazr · work' }, { id: 'p-ab', label: 'grazr · a@b' }]

// The engine answers status with `work` active; the Orca CLI's eval runs in the fake page of the tab's profile.
function route(pages, { gate = Promise.resolve(), engine = {} } = {}) {
  const engineRoute = statusRoute({ 'swap a@b': { stdout: 'Rotated work -> a@b\n' }, refresh: { stdout: 'refreshed\n' }, ...engine })
  const tabs = new Map()
  return async (argv) => {
    if (argv[0] !== ORCA) return engineRoute(argv)
    const args = argv.slice(1, -1)
    const flag = (name) => args[args.indexOf(name) + 1]
    switch (args.slice(0, 2).join(' ')) {
      case 'tab profile': return reply({ profiles: PROFILES })
      case 'worktree list': return reply({ worktrees: [{ id: 'w1', path: '/work' }] })
      case 'tab create': {
        await gate
        const page = `page-${tabs.size + 1}`
        tabs.set(page, pages[flag('--profile')])
        return reply({ browserPageId: page })
      }
      case 'goto --page': {
        tabs.get(flag('--page')).reload()
        return reply({})
      }
      case 'eval --page': {
        const page = tabs.get(flag('--page'))
        return reply({ result: await page.evaluate(flag('--expression')), origin: page.url })
      }
      default: return reply({})
    }
  }
}

async function waitFor(done) {
  for (let i = 0; i < 400 && !done(); i++) await settle()
  assert.ok(done(), 'the reset never finished')
}

const fable = (onUse) => usagePage({ rows: [{ title: 'Fable reset · 2', expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1', onUse }] })
const spent = () => fable((page, row) => page.spend(row))
const titles = (fake) => toasts(fake).map((t) => t.title)
const engineRuns = (fake) => fake.execs.filter((a) => a[0] !== ORCA).map(label)
const orcaAt = (fake, verb) => fake.execs.findLastIndex((a) => a[0] === ORCA && a[1] === verb)

test('the active account: the reset is used on claude.ai, its reading stored, the usage refreshed, and nothing is swapped or typed', async () => {
  const work = spent()
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: route({ 'p-work': work }) })
  const outcome = await fake.panelHandlers.get('limit-reset-model')({ host: 'mac' })
  assert.deepEqual(outcome, { ok: true, message: 'mac: Using a model reset of work on claude.ai…\nThe result comes as a notification.' })
  await waitFor(() => titles(fake).includes('mac: Fable reset used for work'))
  assert.deepEqual(work.clicks, ['Reset for free'])
  assert.equal(toasts(fake).find((t) => t.title === 'mac: Fable reset used for work').body, 'claude.ai now counts 1 model reset (was 2)')
  assert.deepEqual(fake.state.storage.limitResets.work, { readAt: 1000, state: 'ok', full: 0, model: 1, kinds: [{ kind: 'model', label: 'Fable', count: 1, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }] })
  await waitFor(() => engineRuns(fake).includes('refresh'))
  assert.equal(engineRuns(fake).some((l) => l?.startsWith('swap')), false)
  assert.deepEqual(hostCalls(fake, 'terminal.sendText'), [])
  assert.deepEqual(hostCalls(fake, 'workspace.readContext'), [])
})

test('a parked account has its reset used where it stays: nothing is swapped, and the usage is refreshed', async () => {
  const ab = spent()
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: route({ 'p-ab': ab }) })
  const outcome = await fake.panelHandlers.get('limit-reset-model')({ host: 'mac', account: 'a@b' })
  assert.equal(outcome.message, 'mac: Using a model reset of a@b on claude.ai…\nThe result comes as a notification.')
  await waitFor(() => engineRuns(fake).includes('refresh'))
  assert.ok(fake.execs.findIndex((a) => label(a) === 'refresh') > orcaAt(fake, 'tab'))
  assert.equal(engineRuns(fake).some((l) => l?.startsWith('swap')), false)
  assert.deepEqual(titles(fake).slice(-1), ['mac: Fable reset used for a@b'])
  assert.equal(fake.state.storage.limitResets['a@b'].model, 1)
})

test('a parked account whose reset is not confirmed says check claude.ai, and nothing is swapped or refreshed', async () => {
  const ab = fable(() => {})
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: route({ 'p-ab': ab }) })
  await fake.panelHandlers.get('limit-reset-model')({ host: 'mac', account: 'a@b' })
  await waitFor(() => titles(fake).includes('mac: Fable reset of a@b not confirmed'))
  assert.equal(toasts(fake).at(-1).body, UNCONFIRMED)
  await settle()
  assert.equal(engineRuns(fake).some((l) => l?.startsWith('swap')), false)
  assert.equal(engineRuns(fake).includes('refresh'), false)
})

test('a disabled reset clicks nothing', async () => {
  const ab = usagePage({ rows: [{ title: 'Fable reset', disabled: true }] })
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: route({ 'p-ab': ab }) })
  await fake.panelHandlers.get('limit-reset-model')({ host: 'mac', account: 'a@b' })
  await waitFor(() => titles(fake).includes('mac: Fable reset not used for a@b'))
  assert.equal(toasts(fake).at(-1).body, NOTHING_TO_RESET)
  assert.deepEqual(ab.clicks, [])
  assert.equal(engineRuns(fake).includes('swap a@b'), false)
})

test('a confirm dialog on the page is answered, and the reset counts once it shows one fewer', async () => {
  const work = fable((page, row) => page.openDialog('Use your Fable reset?', [button('Cancel'), button('Use reset', {}, () => page.spend(row))]))
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: route({ 'p-work': work }) })
  await fake.panelHandlers.get('limit-reset-model')({ host: 'mac' })
  await waitFor(() => titles(fake).includes('mac: Fable reset used for work'))
  assert.deepEqual(work.clicks, ['Reset for free', 'Use reset'])
})

test('a second press for the same account while its reset runs is refused, never queued', async () => {
  let open
  const gate = new Promise((resolve) => { open = resolve })
  const work = spent()
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: route({ 'p-work': work }, { gate }) })
  await fake.panelHandlers.get('limit-reset-model')({ host: 'mac' })
  const again = await fake.panelHandlers.get('limit-reset-full')({ host: 'mac' })
  assert.deepEqual(again, { ok: false, message: 'mac: a reset of work is already under way\nIts result comes as a notification.' })
  open()
  await waitFor(() => titles(fake).includes('mac: Fable reset used for work'))
  assert.deepEqual(work.clicks, ['Reset for free'])
})

test('on a remote host the page is used in the Mac browser profile, and the refresh goes to that host', async () => {
  const ab = spent()
  const fake = await start({ stored: { hosts: [MAC, REMOTE], target: 'mac' }, route: route({ 'p-ab': ab }) })
  await fake.panelHandlers.get('limit-reset-model')({ host: 'devbox', account: 'a@b' })
  await waitFor(() => engineRuns(fake).includes('refresh'))
  const refresh = fake.execs.find((a) => label(a) === 'refresh')
  assert.equal(refresh[0], '/usr/bin/ssh')
  assert.ok(refresh.includes('devbox'))
  assert.equal(engineRuns(fake).some((l) => l?.startsWith('swap')), false)
  assert.deepEqual(ab.clicks, ['Reset for free'])
})

test('a reset for a host the settings do not name opens nothing', async () => {
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: route({}) })
  const outcome = await fake.panelHandlers.get('limit-reset-full')({ host: 'nowhere' })
  assert.equal(outcome.message, 'unknown host nowhere; refresh the panel')
  await settle()
  assert.equal(fake.execs.some((a) => a[0] === ORCA), false)
})

test('a reset of an organization of a login with several whose organization the engine does not name is refused at once', async () => {
  const accounts = [
    { name: 'work', id: 'a1', email: 'w@example.com', login: 'u1', snapshot: [] },
    { name: 'work:acme', id: 'a2', email: 'w@example.com', login: 'u1', parked: true, snapshot: [] },
  ]
  const status = { 'status --json': { stdout: JSON.stringify(report({ accounts })) } }
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, route: route({ 'p-work': spent() }, { engine: status }) })
  assert.deepEqual(await fake.panelHandlers.get('limit-reset-full')({ host: 'mac' }), { ok: false, message: `mac: limit reset not used\nwork: ${SEVERAL_ORGANIZATIONS}` })
  assert.deepEqual(await fake.panelHandlers.get('limit-reset-model')({ host: 'mac', account: 'work:acme' }), { ok: false, message: `mac: limit reset not used\nwork:acme: ${SEVERAL_ORGANIZATIONS}` })
  await settle()
  assert.equal(fake.execs.some((a) => a[0] === ORCA && a[1] === 'tab'), false)
  assert.equal(engineRuns(fake).some((l) => l?.startsWith('swap')), false)
})

test("a parked organization of a login with several has its reset used on its own organization, selected for it and put back", async () => {
  const accounts = [
    { name: 'w@example.com', id: 'a1', email: 'w@example.com', login: 'u1', organization_uuid: ORG.pro, organization: "w@example.com's Organization", snapshot: [] },
    { name: 'w@example.com:acme', id: 'a2', email: 'w@example.com', login: 'u1', organization_uuid: ORG.team, organization: 'Acme', parked: true, snapshot: [] },
  ]
  const status = { 'status --json': { stdout: JSON.stringify(report({ active: { name: 'w@example.com', id: 'a1' }, accounts })) } }
  const acme = { title: 'Fable reset · 2', expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1', onUse: (p, r) => { p.spend(r); p.spendGrant(ORG.team, 'model') } }
  const page = usagePage({ orgs: { list: [proOrg('w@example.com'), teamOrg()], selected: ORG.pro, cedar: { [ORG.pro]: cedar([fullGrant(1)]), [ORG.team]: teamCedar() }, rows: { [ORG.pro]: [{ title: 'Full reset' }], [ORG.team]: [acme] } } })
  const fake = await start({ stored: { hosts: [MAC], target: 'mac' }, storage: { browserProfiles: { 'w@example.com': 'p-work' } }, route: route({ 'p-work': page }, { engine: status }) })
  await fake.panelHandlers.get('limit-reset-model')({ host: 'mac', account: 'w@example.com:acme' })
  await waitFor(() => titles(fake).includes('mac: Fable reset used for w@example.com:acme'))
  assert.deepEqual(page.clicks, ['Reset for free'])
  assert.equal(page.orgs.selected, ORG.pro)
  const stored = fake.state.storage.limitResets['w@example.com:acme']
  assert.deepEqual([stored.source, stored.organizationUuid, stored.model], ['api', ORG.team, 1])
  assert.equal(engineRuns(fake).some((l) => l?.startsWith('swap')), false)
})
