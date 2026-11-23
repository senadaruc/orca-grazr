import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useLimitReset, chooseRow, confirmButton, couldNotSwitch, POLLS, FOCUS_POLLS, NOTHING_TO_RESET, SEVERAL_ORGANIZATIONS, UNCONFIRMED } from '../lib/limit-reset-use.mjs'
import { createAccountProfiles } from '../lib/browser-profiles.mjs'
import { usagePage, loginPage, button } from './support/fake-usage-page.mjs'
import { ORG, proOrg, teamOrg, cedar, fullGrant, teamCedar } from './support/claude-data-fixture.mjs'

const SETTINGS = { orcaBin: '/usr/local/bin/orca' }
const reply = (result) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }) })
const refusal = (message) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { message } }) })

// A scripted Orca CLI whose eval runs the expression in the fake page of the tab's profile (p-a for the account a).
function fakeOrcaCli(page, { overrides = {} } = {}) {
  const calls = []
  let opened = 0
  const exec = async (argv) => {
    const args = argv.slice(1, -1)
    calls.push(args)
    const key = args.slice(0, 2).join(' ')
    if (Object.hasOwn(overrides, key)) return overrides[key](args)
    const flag = (name) => args[args.indexOf(name) + 1]
    switch (key) {
      case 'tab profile': return reply({ profiles: [{ id: 'p-a', label: 'grazr · a' }] })
      case 'worktree list': return reply({ worktrees: [{ id: 'w1', path: '/work' }] })
      case 'tab create': return reply({ browserPageId: `page-${++opened}` })
      case 'wait --page': return reply({ found: true })
      case 'eval --page': return reply({ result: await page.evaluate(flag('--expression')), origin: page.url })
      case 'tab close': return reply({ closed: true })
      case 'goto --page':
        page.reload()
        return reply({})
      default: return refusal(`unexpected ${key}`)
    }
  }
  return { exec, calls }
}

function storage() {
  const values = {}
  return { get: async (key) => values[key], set: async (key, value) => { values[key] = value } }
}

async function use(page, { account = 'a', kind = 'model', overrides, organization = null, several = false } = {}) {
  const cli = fakeOrcaCli(page, { overrides })
  const logs = []
  let sleeps = 0
  const result = await useLimitReset({
    ctx: { exec: cli.exec, settings: SETTINGS, homedir: () => '/home/t' },
    account,
    kind,
    profiles: createAccountProfiles({ storage: storage() }),
    sleep: async () => { sleeps++ },
    log: (msg) => logs.push(msg),
    organization,
    several,
    timeZone: 'UTC',
  })
  const verbs = cli.calls.map((args) => args.slice(0, 2).join(' '))
  return { result, logs, verbs, sleeps, calls: cli.calls }
}

const FABLE_TEAM = { title: 'Fable reset · 2', expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }
const FABLE = { title: 'Fable reset' }
const WEEKLY = { title: 'Weekly reset', expires: 'Expires Dec 10, 11:00 PM GMT+1' }
const FULL = { title: 'Full reset' }
const spends = (row) => ({ ...row, onUse: (page, r) => page.spend(r) })

test('rows are matched by their title alone: Team "Fable reset · 2", Ultra "Weekly reset", Team "Full reset"', () => {
  const rows = [{ title: 'Fable reset · 2' }, { title: 'Weekly reset' }, { title: 'Full reset' }]
  assert.equal(chooseRow(rows.slice(0, 1), 'model').row.index, 0)
  assert.equal(chooseRow(rows.slice(0, 1), 'model').row.reset.label, 'Fable')
  assert.deepEqual(chooseRow(rows.slice(0, 1), 'full'), { none: true })
  assert.equal(chooseRow(rows.slice(0, 2), 'full').row.index, 1)
  assert.equal(chooseRow([rows[2]], 'full').row.reset.label, 'Full')
  assert.deepEqual(chooseRow([{ title: 'Fable reset' }, { title: 'Opus reset' }], 'model'), { several: true })
  assert.deepEqual(chooseRow([{ title: 'Something else' }], 'model'), { none: true })
})

test('a confirming button is one enabled button that says reset, confirm or use, never a cancel', () => {
  const d = (...texts) => ({ buttons: texts.map((text) => (typeof text === 'string' ? { text, disabled: false } : text)) })
  assert.equal(confirmButton(d('Cancel', 'Use reset')), 1)
  assert.equal(confirmButton(d('Reset for free', 'Not now')), 0)
  assert.equal(confirmButton(d('Cancel', 'Close')), null)
  assert.equal(confirmButton(d('Use reset', 'Reset for free')), null)
  assert.equal(confirmButton(d('Cancel', { text: 'Confirm', disabled: true })), null)
  assert.equal(confirmButton(d('Don’t reset', 'Keep it')), null)
})

test('the Team Fable reset: a confirm dialog is answered once, and success comes only with one fewer on the page', async () => {
  const page = usagePage({
    rows: [{
      ...FABLE_TEAM,
      onUse: (p, row) => p.openDialog('Use your Fable reset? This refills your 5-hour limit.', [
        button('Cancel', {}, () => { throw new Error('cancel clicked') }),
        button('Use reset', {}, () => p.spend(row)),
      ]),
    }],
  })
  const { result, logs, verbs } = await use(page)
  assert.deepEqual(page.clicks, ['Reset for free', 'Use reset'])
  assert.equal(result.ok, true)
  assert.equal(result.label, 'Fable reset')
  assert.deepEqual([result.was, result.now], [2, 1])
  assert.deepEqual(result.outcome, { state: 'ok', full: 0, model: 1, kinds: [{ kind: 'model', label: 'Fable', count: 1, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }] })
  assert.ok(logs.some((l) => l.includes('a alertdialog showed: "Use your Fable reset? This refills your 5-hour limit. Cancel Use reset", buttons: "Cancel", "Use reset"')))
  assert.ok(logs.some((l) => l.includes('clicked "Use reset" in the dialog')))
  assert.equal(verbs.at(-1), 'tab close')
  assert.equal(verbs.includes('click'), false)
})

test('the Ultra weekly reset spent at the click: only its own button is clicked, and nothing else', async () => {
  const page = usagePage({ rows: [{ ...FABLE, onUse: () => { throw new Error('the Fable row was clicked') } }, spends(WEEKLY)] })
  const { result, verbs } = await use(page, { kind: 'full' })
  assert.deepEqual(page.clicks, ['Reset for free'])
  assert.equal(result.ok, true)
  assert.equal(result.label, 'Weekly reset')
  assert.deepEqual([result.was, result.now, result.outcome.full, result.outcome.model], [1, 0, 0, 1])
  assert.equal(verbs.at(-1), 'tab close')
})

test('the Team full reset, the last reset of the account: its row goes and the page shows none', async () => {
  const page = usagePage({ rows: [spends(FULL)] })
  const { result } = await use(page, { kind: 'full' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.outcome, { state: 'ok', full: 0, model: 0, kinds: [] })
})

const evalOps = (calls) => calls.filter((args) => args[0] === 'eval').map((args) => args.at(-1).match(/\)\("([\w-]+)"/)[1])

test('a button greyed out in the background tab is given focus, then clicked once claude.ai enables it', async () => {
  const page = usagePage({ rows: [{ ...spends(FABLE_TEAM), disabled: 'until-focus' }] })
  const { result, logs, calls } = await use(page)
  assert.deepEqual(page.windowEvents, ['focus'])
  assert.deepEqual(page.clicks, ['Reset for free'])
  assert.deepEqual([result.ok, result.was, result.now], [true, 2, 1])
  const ops = evalOps(calls)
  assert.ok(ops.indexOf('focus') < ops.indexOf('click-row'))
  assert.ok(logs.some((l) => l.includes('Reset for free on "Fable reset · 2" is greyed out: the page is given focus')))
  assert.equal(calls.flat().includes('--focus'), false)
})

test('a button still greyed out 10 s after focus is never clicked, says there is nothing to reset, and logs the focus', async () => {
  const page = usagePage({ rows: [{ ...FABLE_TEAM, disabled: true, onUse: () => { throw new Error('clicked') } }] })
  const { result, verbs, sleeps, logs } = await use(page)
  assert.deepEqual(page.windowEvents, ['focus'])
  assert.deepEqual(page.clicks, [])
  assert.deepEqual([result.ok, result.clicked, result.message], [false, false, NOTHING_TO_RESET])
  assert.equal(result.outcome.model, 2)
  assert.equal(sleeps, FOCUS_POLLS)
  assert.ok(logs.some((l) => l.includes('stayed greyed out for 10 s after focus (hasFocus false, visibility visible)')))
  assert.equal(verbs.at(-1), 'tab close')
})

test('an enabled button is clicked without giving the page focus', async () => {
  const page = usagePage({ rows: [spends(FABLE_TEAM)] })
  const { result, calls } = await use(page)
  assert.equal(result.ok, true)
  assert.deepEqual(page.windowEvents, [])
  assert.equal(evalOps(calls).includes('focus'), false)
})

test('a kind the page does not show clicks nothing, not even another row', async () => {
  const page = usagePage({ rows: [{ ...FABLE_TEAM, onUse: () => { throw new Error('clicked') } }] })
  const { result } = await use(page, { kind: 'full' })
  assert.deepEqual(page.clicks, [])
  assert.deepEqual([result.ok, result.clicked, result.message], [false, false, 'claude.ai shows no full reset for a right now'])
})

test('a click that changes nothing is not a success: after 20 s it says so, and the tab is closed', async () => {
  const page = usagePage({ rows: [{ ...FABLE_TEAM, onUse: () => {} }], status: '' })
  const { result, sleeps, verbs } = await use(page)
  assert.deepEqual(page.clicks, ['Reset for free'])
  assert.deepEqual([result.ok, result.clicked, result.message], [false, true, UNCONFIRMED])
  assert.equal(sleeps, POLLS)
  assert.equal(verbs.at(-1), 'tab close')
})

test('a dialog with two confirming buttons is left alone and the reset is not claimed', async () => {
  const page = usagePage({
    rows: [{ ...FABLE_TEAM, onUse: (p, row) => p.openDialog('Which?', [button('Use reset', {}, () => p.spend(row)), button('Reset for free', {}, () => p.spend(row))]) }],
  })
  const { result } = await use(page)
  assert.deepEqual(page.clicks, ['Reset for free'])
  assert.equal(result.ok, false)
  assert.equal(result.message, UNCONFIRMED)
})

test('a lower count seen once only is not a success', async () => {
  let reads = 0
  const page = usagePage({ rows: [{ ...FABLE_TEAM, onUse: () => {} }] })
  const evaluate = page.evaluate
  page.evaluate = (expr) => {
    if (expr.includes('"describe"') && ++reads === 2) {
      const shown = page.rows
      page.setRows([{ title: 'Fable reset' }])
      const out = evaluate(expr)
      page.setRows(shown)
      return out
    }
    return evaluate(expr)
  }
  const { result } = await use(page)
  assert.equal(result.ok, false)
})

test('a signed-out profile clicks nothing and reads as signed out', async () => {
  const page = loginPage()
  const { result, verbs, calls } = await use(page)
  assert.deepEqual(page.clicks, [])
  assert.deepEqual(result.outcome, { state: 'signed-out' })
  assert.equal(result.message, 'a is signed out of claude.ai in its browser profile: open claude.ai for it and sign in once')
  assert.deepEqual(evalOps(calls), ['describe'])
  assert.equal(verbs.at(-1), 'tab close')
})

test('an account without a profile opens no tab', async () => {
  const page = usagePage({ rows: [FABLE] })
  const { result, verbs } = await use(page, { account: 'nobody' })
  assert.equal(verbs.includes('tab create'), false)
  assert.deepEqual(result.outcome, { state: 'no-profile' })
})

test('a page that fails after the click still closes its tab, and the reset is not claimed', async () => {
  const page = usagePage({ rows: [{ ...FABLE_TEAM, onUse: () => {} }] })
  let evals = 0
  const { result, verbs } = await use(page, {
    overrides: { 'eval --page': (args) => (++evals > 2 ? (() => { throw new Error('webview gone') })() : reply({ result: page.evaluate(args[args.indexOf('--expression') + 1]), origin: page.url })) },
  })
  assert.deepEqual([result.ok, result.clicked, result.message], [false, true, UNCONFIRMED])
  assert.equal(verbs.at(-1), 'tab close')
})

test('an organization of a login with several whose organization is not known is refused before any tab opens', async () => {
  const page = usagePage({ rows: [spends(FABLE_TEAM)] })
  const { result, calls } = await use(page, { several: true })
  assert.deepEqual(result, { ok: false, clicked: false, message: SEVERAL_ORGANIZATIONS })
  assert.deepEqual(calls, [])
  assert.deepEqual(page.clicks, [])
})

// A login with two organizations: Acme (Team, two Fable resets) and its personal Max organization (one full reset).
const ACME = { uuid: ORG.team, name: 'Acme' }
function orgsPage(selected, { cookieStuck = false } = {}) {
  let page
  const spendAcme = { ...FABLE_TEAM, onUse: (p, r) => { p.spend(r); p.spendGrant(ORG.team, 'model') } }
  page = usagePage({
    orgs: {
      list: [proOrg('a@example.com'), teamOrg()],
      selected,
      cookieStuck,
      cedar: { [ORG.pro]: cedar([fullGrant(1)]), [ORG.team]: teamCedar() },
      rows: { [ORG.pro]: [{ title: 'Full reset' }], [ORG.team]: [spendAcme] },
    },
  })
  return page
}

test('with its organization selected already, the reset is clicked and its use is seen in the organization grants', async () => {
  const page = orgsPage(ORG.team)
  const { result, verbs, logs } = await use(page, { organization: ACME, several: true })
  assert.deepEqual(page.clicks, ['Reset for free'])
  assert.equal(verbs.includes('goto --page'), false)
  assert.deepEqual(page.cookieWrites, [])
  assert.deepEqual([result.ok, result.was, result.now, result.outcome.source, result.outcome.organizationUuid, result.outcome.model], [true, 2, 1, 'api', ORG.team, 1])
  assert.ok(logs.includes("grazr limit reset: a: claude.ai's data now counts 1 model (was 2): the reset was used"))
  assert.equal(page.requests.every((r) => r.startsWith('GET ')), true)
})

test('with another organization selected, it is selected, the reload checked against its grants, the reset clicked, and the selection put back', async () => {
  const page = orgsPage(ORG.pro)
  const { result, verbs } = await use(page, { organization: ACME, several: true })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(page.clicks, ['Reset for free'])
  assert.equal(page.reloads, 1)
  assert.ok(verbs.indexOf('goto --page') < verbs.lastIndexOf('eval --page'))
  assert.deepEqual(page.cookieWrites.map((w) => [w.value, w.domain, w.path, w.sameSite]), [[ORG.team, 'claude.ai', '/', 'lax'], [ORG.pro, 'claude.ai', '/', 'lax']])
  assert.equal(page.orgs.selected, ORG.pro, 'the selection the user had is back')
  assert.equal(verbs.at(-1), 'tab close')
})

test('when claude.ai keeps the other organization selected, nothing is clicked and the message says to select it by hand', async () => {
  const page = orgsPage(ORG.pro, { cookieStuck: true })
  const { result } = await use(page, { organization: ACME, several: true })
  assert.deepEqual(result, { ok: false, clicked: false, message: couldNotSwitch('Acme') })
  assert.equal(result.message, 'could not switch claude.ai to Acme — select it in the account menu and try again')
  assert.deepEqual(page.clicks, [])
})

test('when the reloaded page counts other resets than the organization grants, nothing is clicked', async () => {
  const page = orgsPage(ORG.pro)
  page.reload = () => { page.reloads++ }
  const { result } = await use(page, { organization: ACME, several: true })
  assert.deepEqual([result.ok, result.clicked, result.message], [false, false, couldNotSwitch('Acme')])
  assert.deepEqual(page.clicks, [])
  assert.equal(page.orgs.selected, ORG.pro, 'the selection is put back after a failed check too')
})

test('without claude.ai data, a login with several organizations clicks nothing', async () => {
  const page = orgsPage(ORG.team)
  page.orgs.signedOut = false
  page.orgs.list = 'broken'
  const { result } = await use(page, { organization: ACME, several: true })
  assert.deepEqual([result.ok, result.clicked, result.message], [false, false, couldNotSwitch('Acme')])
  assert.deepEqual(page.clicks, [])
})
