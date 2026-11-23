import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildPanelData, listOf, rowState, severalOrganizationNames } from '../lib/panel-data.mjs'
import { renderCard, ringSvg } from '../lib/panel.mjs'
import { NOW, TZ, shared, sharedReadings, singles, singlesReadings } from './support/organizations-fixture.mjs'

// The panel of the organizations of one login: the rows, the dial, the list and the clock of a host card.
const COMMANDS = { mac: { refresh: 'r', enrol: 'e', rotationOn: 'on', rotationOff: 'off', swap: 's', swapTo: { a: 'sa', b: 'sb', c: 'sc', d: 'sd' } } }
const hostOf = (report, { limitResets = {}, discovered = [] } = {}) => buildPanelData({
  settings: { hosts: [{ name: 'mac' }], target: 'mac' },
  now: NOW,
  timeZone: TZ,
  limitResets,
  discovered: { mac: discovered },
  hosts: [{ host: { name: 'mac' }, result: { ok: true, value: report } }],
}).hosts[0]
const cardOf = (host) => renderCard({ ...host, open: true }, COMMANDS, { timeZone: TZ })
const DISCOVERED = [
  { name: 's@example.com · Beta', email: 's@example.com', login: 'us', organization: 'Beta', claudeCode: false, reason: 'no Claude Code on this plan' },
  { name: 's@example.com · Gamma', email: 's@example.com', login: 'us', organization: 'Gamma' },
]

// The sign-in of another organization: the one thing a login with one account gains, on its List card.
const ORGANIZATION_BUTTON = /<button class="act act-organization" [^>]*>Sign in another organization…<\/button>/g

test('with one account per login the card is byte for byte the card from before the grouping, but for the sign-in of another organization on each List card', async () => {
  const before = (await readFile(new URL('./support/single-member-card.html', import.meta.url), 'utf8')).replace(/\n$/, '')
  const now = cardOf(hostOf(singles(), { limitResets: singlesReadings() }))
  const list = now.indexOf('<div class="list">')
  assert.equal(now.slice(0, list), before.slice(0, list), 'the rows, the dial and the clock are unchanged')
  assert.equal(now.replace(ORGANIZATION_BUTTON, ''), before)
  const buttons = now.match(ORGANIZATION_BUTTON)
  assert.equal(buttons.length, 4, 'one per enrolled account, none for the account named only')
  assert.ok(buttons[0].includes('data-command="sign-in-organization" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;email&quot;:&quot;a@example.com&quot;}"'))
})

test('rows and list entries name their login group, its e-mail and the organization with its plan', () => {
  const host = hostOf(shared())
  const rows = host.views.session.rows
  assert.deepEqual(rows.map((r) => [r.index, r.name, r.group, r.groupLabel, r.orgLabel]), [
    [1, 't@example.com', 'login:ut', 't@example.com', 'T Org · Max'],
    [2, 's@example.com', 'login:us', 's@example.com', 'Max'],
    [3, 's@example.com:acme', 'login:us', 's@example.com', 'Acme · Team 5x'],
    [4, 'u@example.com', 'login:uu', 'u@example.com', 'Max'],
    [5, 'v@example.com', 'login:uv', 'v@example.com', 'Max'],
  ])
  assert.deepEqual(host.list.accounts.map((a) => [a.index, a.name, a.groupLabel, a.orgLabel, a.discovered, a.claudeCode, a.reason]), rows.map((r) => [r.index, r.name, r.groupLabel, r.orgLabel, false, true, null]))
  assert.deepEqual(host.list.groups.map((g) => [g.label, g.start, g.size]), [['t@example.com', 0, 1], ['s@example.com', 1, 2], ['u@example.com', 3, 1], ['v@example.com', 4, 1]])
})

test('a login with two organizations gets a header with its e-mail before its first row, and its rows name the organization', () => {
  const html = cardOf(hostOf(shared()))
  const view = html.slice(html.indexOf('<div class="view-session">'), html.indexOf('<div class="view-weekly">'))
  assert.equal(view.split('<li class="group-head">').length - 1, 1, 'only the login with two organizations has a header')
  assert.ok(view.includes('<li class="group-head"><span class="group-name">s@example.com</span><span class="spacer"></span><button class="act act-organization" data-host="mac" data-text="" data-command="sign-in-organization" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;email&quot;:&quot;s@example.com&quot;}"'))
  assert.ok(view.includes('Sign in another organization…</button></li><li class="row row-next row-member">'))
  assert.equal(view.split('act-organization').length - 1, 1, 'the rows offer it on the header alone')
  assert.ok(view.includes('<span class="row-name" title="s@example.com">Max</span>'))
  assert.ok(view.includes('<span class="row-name" title="s@example.com:acme">Acme · Team 5x</span>'))
  assert.ok(view.includes('<li class="row row-ok"><span class="row-index acct-3">4</span><span class="row-name">u@example.com</span>'), 'a login alone is drawn as before')
})

test('the list face puts the organizations of one login in a section under its e-mail, named by organization and plan', () => {
  const html = cardOf(hostOf(shared()))
  const list = html.slice(html.indexOf('<div class="list">'))
  assert.ok(list.includes('<section class="acct-group"><h3 class="acct-group-head"><span class="group-name">s@example.com</span><span class="spacer"></span><button class="act act-organization"'))
  assert.ok(list.includes('Sign in another organization…</button></h3><article class="acct acct-ok"><div class="acct-head"><span class="acct-name" title="s@example.com">Max</span>'))
  const group = list.slice(list.indexOf('<section class="acct-group">'), list.indexOf('</section>'))
  assert.equal(group.split('act-organization').length - 1, 1, 'the members leave it to the header')
  assert.ok(group.includes('<span class="acct-name" title="s@example.com:acme">Acme · Team 5x</span>'))
  assert.equal(group.includes('chip-muted">Team 5x<'), false, 'the plan is in the name, not repeated as a chip')
  assert.equal(group.includes('class="acct-org"'), false)
  assert.equal(list.split('<section class="acct-group">').length - 1, 1)
})

test('a login with two organizations has no claude.ai reading and no reset buttons, but keeps the note of Claude Code', () => {
  const host = hostOf(shared(), { limitResets: sharedReadings() })
  assert.deepEqual([...severalOrganizationNames(shared())], ['s@example.com', 's@example.com:acme'])
  const rows = Object.fromEntries(host.views.session.rows.map((r) => [r.name, r]))
  assert.deepEqual([rows['s@example.com'].reset, rows['s@example.com'].resetCounts, rows['s@example.com'].resetsSupported], [true, null, false], 'the note holds; the reading is left out')
  assert.deepEqual([rows['s@example.com:acme'].reset, rows['s@example.com:acme'].resetsSupported], [null, false])
  assert.deepEqual([rows['u@example.com'].resetCounts?.full, rows['u@example.com'].resetsSupported], [1, true])
  const html = cardOf(host)
  assert.equal(/data-command="limit-reset-[a-z]+" data-params="\{&quot;host&quot;:&quot;mac&quot;,&quot;account&quot;:&quot;s@example\.com/.test(html), false)
  assert.ok(html.includes('data-command="limit-reset-full" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;account&quot;:&quot;u@example.com&quot;}"'))
})

test('the active account of a login with two organizations gets no reset buttons either, not even the unknown fallback', () => {
  const r = shared()
  r.active = { id: 's@example.com', name: 's@example.com' }
  r.accounts.find((a) => a.name === 's@example.com').parked = false
  const html = cardOf(hostOf(r))
  assert.equal(html.includes('data-command="limit-reset-'), false)
})

test('discovered organizations close their group without a number or a dial segment, greyed with their reason', () => {
  const host = hostOf(shared(), { discovered: DISCOVERED })
  const rows = host.views.session.rows
  assert.deepEqual(rows.map((r) => [r.index, r.name, r.status, r.label]), [
    [1, 't@example.com', 'active', 'active'],
    [2, 's@example.com', 'next', 'NEXT ▸'],
    [3, 's@example.com:acme', 'spent', 'spent · resets Wed 12:00'],
    [null, 's@example.com · Beta', 'unsupported', 'no Claude Code on this plan'],
    [null, 's@example.com · Gamma', 'not-signed-in', 'not signed in'],
    [4, 'u@example.com', 'ok', ''],
    [5, 'v@example.com', 'blocked', 'blocked: authentication_failed'],
  ])
  assert.deepEqual(rows.filter((r) => r.discovered).map((r) => [r.claudeCode, r.reason]), [[false, 'no Claude Code on this plan'], [null, null]])
  assert.deepEqual(host.views.session.segments.map((s) => s.index), [1, 2, 3, 4, 5])
  assert.equal(ringSvg(host.views.session).split('class="badge"').length - 1, 5)
  assert.deepEqual(host.clock.accounts.map((a) => a.index), [1, 2, 4, 3, 5])
  const html = cardOf(host)
  assert.ok(html.includes('<li class="row row-unsupported row-member"><span class="row-index"></span><span class="row-name" title="s@example.com · Beta">Beta</span><span class="row-pct">—</span><span class="row-label">no Claude Code on this plan</span></li>'), 'no button at all')
  assert.ok(html.includes('<article class="acct acct-discovered"><div class="acct-head"><span class="acct-name" title="s@example.com · Gamma">Gamma</span><span class="chip chip-muted">not signed in</span><span class="spacer"></span></div></article>'))
  const list = listOf(shared(), { now: NOW, timeZone: TZ, discovered: DISCOVERED })
  assert.deepEqual(list.accounts.filter((a) => a.discovered).map((a) => [a.index, a.action, a.listed, a.windows.length]), [[null, null, true, 0], [null, null, true, 0]])
})

test('rowState reads a discovered organization as unsupported or not signed in, and never as a reading', () => {
  assert.deepEqual(rowState({ name: 'x', discovered: true, claudeCode: false }, {}, 'session'), { percent: null, status: 'unsupported', label: 'no Claude Code' })
  assert.deepEqual(rowState({ name: 'x', discovered: true, reason: 'not signed in on claude.ai' }, {}, 'session'), { percent: null, status: 'not-signed-in', label: 'not signed in on claude.ai' })
})

const orgReading = (organizationUuid, full, model, extra = {}) => ({
  readAt: NOW.getTime() - 3600 * 1000, state: 'ok', full, model, source: 'api', organizationUuid,
  kinds: [
    ...(full > 0 ? [{ kind: 'full', label: 'Full', count: full, expires: 'Expires Dec 10, 2026, 10:00 PM UTC', usableNow: true, unavailableReason: null }] : []),
    ...(model > 0 ? [{ kind: 'model', label: 'Fable', count: model, expires: 'All expire Mar 9, 2027, 7:59 AM UTC', usableNow: true, unavailableReason: null }] : []),
  ],
  usableNow: { full: full > 0 ? true : null, model: model > 0 ? true : null },
  ...extra,
})
const resetLabels = (html) => [...html.matchAll(/<button class="act act-reset"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
const rowOf = (html, title) => {
  const view = html.slice(html.indexOf('<div class="view-session">'), html.indexOf('<div class="view-weekly">'))
  return view.split('<li class="row ').slice(1).map((r) => r.split('</li>')[0]).find((r) => r.includes(`title="${title}"`) || r.includes(`<span class="row-name">${title}</span>`))
}

test('the organizations of a login with several get the buttons of their own organization reading, never of the other one', () => {
  const readings = { 's@example.com': orgReading('os1', 1, 0), 's@example.com:acme': orgReading('os2', 0, 2) }
  const host = hostOf(shared(), { limitResets: readings })
  const rows = Object.fromEntries(host.views.session.rows.map((r) => [r.name, r]))
  assert.deepEqual([rows['s@example.com'].resetsSupported, rows['s@example.com'].resetCounts.full, rows['s@example.com'].resetCounts.model], [true, 1, 0])
  assert.deepEqual([rows['s@example.com:acme'].resetsSupported, rows['s@example.com:acme'].resetCounts.full, rows['s@example.com:acme'].resetCounts.model], [true, 0, 2])
  const html = cardOf(host)
  assert.deepEqual(resetLabels(rowOf(html, 's@example.com')), ['Full reset'])
  assert.deepEqual(resetLabels(rowOf(html, 's@example.com:acme')), ['Fable reset'])
  assert.ok(rowOf(html, 's@example.com').includes('data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;account&quot;:&quot;s@example.com&quot;}"'))
})

test("a reading filed under an account's name but of another organization is not that account's", () => {
  const readings = { 's@example.com': orgReading('os2', 0, 2), 'u@example.com': orgReading('ou-other', 1, 0) }
  const rows = Object.fromEntries(hostOf(shared(), { limitResets: readings }).views.session.rows.map((r) => [r.name, r]))
  assert.deepEqual([rows['s@example.com'].resetCounts, rows['s@example.com'].resetsSupported], [null, false])
  assert.deepEqual([rows['s@example.com:acme'].resetCounts?.model, rows['s@example.com:acme'].resetsSupported], [2, true], 'the reading of its organization is found under the other name')
  assert.equal(rows['u@example.com'].resetCounts, null)
})

test('a kind claude.ai counts but does not let be used now shows its button disabled, with the reason, and still counts', () => {
  const reading = orgReading('os2', 1, 0, { usableNow: { full: false, model: null } })
  reading.kinds[0] = { ...reading.kinds[0], usableNow: false, unavailableReason: 'unavailable' }
  const html = cardOf(hostOf(shared(), { limitResets: { 's@example.com:acme': reading } }))
  const row = rowOf(html, 's@example.com:acme')
  assert.ok(row.includes('<button class="act act-reset" data-host="mac" disabled data-unavailable="" title="claude.ai: not usable right now">Full reset</button>'))
  assert.equal(row.includes('data-command="limit-reset-full"'), false)
  assert.ok(row.includes('1 reset available'))
})

const discoveredFor = (email, login, ...orgs) => orgs.map(([uuid, orgLabel, claudeCode, reason = null]) => ({ name: `${email} · ${orgLabel}`, email, login, organizationUuid: uuid, orgLabel, claudeCode, reason }))

test('a discovered subscription organization offers a Sign in targeted at it; free and API ones are greyed with their reason', () => {
  const found = discoveredFor('u@example.com', 'uu',
    ['oteam', 'Acme · Team', true],
    ['ofree', 'Personal · Free', false, 'Free plan — Claude Code needs a paid plan'],
    ['oapi', 'Acme API · API', false, 'API console organization — not a Claude subscription'])
  const host = hostOf(shared(), { discovered: found })
  const rows = host.views.session.rows.filter((r) => r.discovered)
  assert.deepEqual(rows.map((r) => [r.index, r.status, r.label, r.orgLabel, r.organizationUuid]), [
    [null, 'not-signed-in', 'not signed in', 'Acme · Team', 'oteam'],
    [null, 'unsupported', 'Free plan — Claude Code needs a paid plan', 'Personal · Free', 'ofree'],
    [null, 'unsupported', 'API console organization — not a Claude subscription', 'Acme API · API', 'oapi'],
  ])
  const html = cardOf(host)
  const view = html.slice(html.indexOf('<div class="view-session">'), html.indexOf('<div class="view-weekly">'))
  assert.ok(view.includes('<li class="group-head"><span class="group-name">u@example.com</span>'), 'a login with one enrolled organization becomes a group')
  assert.ok(view.includes('<span class="row-name" title="u@example.com · Acme · Team">Acme · Team</span>'))
  assert.ok(view.includes('data-command="sign-in-organization" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;email&quot;:&quot;u@example.com&quot;,&quot;organization&quot;:&quot;oteam&quot;}"'))
  assert.ok(view.includes('>Sign in…</button>'))
  const greyed = view.split('<li class="row row-unsupported row-member">').slice(1).map((r) => r.split('</li>')[0])
  assert.equal(greyed.length, 2)
  assert.equal(greyed.some((r) => r.includes('<button')), false, 'an unsupported organization has no button')
  const list = html.slice(html.indexOf('<div class="list">'))
  assert.ok(list.includes('data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;email&quot;:&quot;u@example.com&quot;,&quot;organization&quot;:&quot;oteam&quot;}"'))
})
