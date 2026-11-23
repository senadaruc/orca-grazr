import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelData } from '../lib/panel-data.mjs'
import { renderCard } from '../lib/panel.mjs'

// The reset buttons follow a current reading of each account's claude.ai usage page, and Claude's note without one.
const NOW = new Date('2026-11-23T10:00:00Z')
const TZ = 'Europe/Zurich'
const HOUR = 3600000
const window = (group, remaining) => ({ kind: group, scope: null, group, remaining, resets_at: null })
const fixture = () => ({
  active: { id: 'a', name: 'a' },
  order: ['a', 'b'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    { id: 'a', name: 'a', parked: false, blocked: null, in_order: true, snapshot: [window('session', 60), window('weekly', 70)] },
    { id: 'b', name: 'b', parked: true, blocked: null, in_order: true, snapshot: [window('session', 100), window('weekly', 100)] },
  ],
})
const CMD = { enrol: 'enrol', swapTo: { a: 'swap a', b: 'swap b' }, resetModel: 'reset model', resetFull: 'reset full' }
const FABLE = { kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }
const FULL = { kind: 'full', label: 'Full', count: 1, expires: 'Expires Dec 10, 11:00 PM GMT+1' }
const ok = (kinds, age = HOUR) => ({
  readAt: NOW.getTime() - age,
  state: 'ok',
  full: kinds.filter((k) => k.kind === 'full').reduce((n, k) => n + k.count, 0),
  model: kinds.filter((k) => k.kind === 'model').reduce((n, k) => n + k.count, 0),
  kinds,
})

const cardOf = (report, limitResets, face = 'list') => {
  const host = { name: 'mac' }
  const data = buildPanelData({ settings: { hosts: [host], target: 'mac', panelFace: face }, now: NOW, timeZone: TZ, limitResets, hosts: [{ host, result: { ok: true, value: report } }] })
  return renderCard({ ...data.hosts[0], open: true, face, view: 'session' }, { mac: CMD }, { timeZone: TZ })
}
const acct = (html, name) => html.split('<article ').slice(1).map((a) => a.split('</article>')[0]).find((a) => a.includes(`<span class="acct-name">${name}</span>`))
const row = (html, name) => html.split('<li class="row ').slice(1).map((r) => r.split('</li>')[0]).find((r) => r.includes(`<span class="row-name">${name}</span>`))
const labels = (html) => [...html.matchAll(/<button class="act act-reset"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])

test('a reading with model resets only offers only Fable reset on the active account, with the count and expiry on the chip', () => {
  const a = acct(cardOf(fixture(), { a: ok([FABLE]) }), 'a')
  assert.deepEqual(labels(a), ['Fable reset'])
  assert.ok(a.includes('title="Type /limit-reset fable into the terminal; Claude names the reset and asks before using it">Fable reset</button>'))
  assert.ok(a.includes('<span class="chip chip-on" title="2 Fable resets, all expire Mar 9, 2027, 8:59 AM GMT+1">2 resets available</span>'))
})

test('a reading of no resets offers none, even on the active account and over a note from Claude that says there is one', () => {
  const report = fixture()
  report.accounts[0].unused_reset = { holds: true }
  const html = cardOf(report, { a: ok([]) })
  assert.deepEqual(labels(acct(html, 'a')), [])
  assert.equal(html.includes('reset available'), false)
  assert.equal(html.includes('resets available'), false)
  assert.equal(html.includes('Reset available'), false)
})

test('a parked account whose page counts a full reset offers only Swap + Full reset', () => {
  const b = acct(cardOf(fixture(), { b: ok([FULL]) }), 'b')
  assert.deepEqual(labels(b), ['Swap + Full reset'])
  assert.ok(b.includes('data-command="limit-reset-full" data-params="{&quot;host&quot;:&quot;mac&quot;,&quot;account&quot;:&quot;b&quot;}"'))
  assert.ok(b.includes('<span class="chip chip-on" title="1 full reset, expires Dec 10, 11:00 PM GMT+1">1 reset available</span>'))
})

test('both kinds read: both buttons, and the hover names each kind with its expiry', () => {
  const a = acct(cardOf(fixture(), { a: ok([FULL, FABLE]) }), 'a')
  assert.deepEqual(labels(a), ['Fable reset', 'Full reset'])
  assert.ok(a.includes('title="1 full reset, expires Dec 10, 11:00 PM GMT+1 · 2 Fable resets, all expire Mar 9, 2027, 8:59 AM GMT+1">3 resets available</span>'))
})

test('without a reading the 0.9.7 rule holds: the active account offers both, not known, and a parked one none', () => {
  const html = cardOf(fixture(), {})
  assert.deepEqual(labels(acct(html, 'a')), ['Model reset', 'Full reset'])
  assert.ok(acct(html, 'a').includes('not known whether a reset is available'))
  assert.deepEqual(labels(acct(html, 'b')), [])
  assert.equal(html.includes('Reset available'), false)
})

test('a reading older than 12 hours counts as none at all: the 0.9.7 rule holds', () => {
  const html = cardOf(fixture(), { a: ok([FABLE], 13 * HOUR), b: ok([FULL], 13 * HOUR) })
  assert.deepEqual(labels(acct(html, 'a')), ['Model reset', 'Full reset'])
  assert.ok(acct(html, 'a').includes('not known whether a reset is available'))
  assert.deepEqual(labels(acct(html, 'b')), [])
})

test('a signed-out or profile-less account says so in its Open claude.ai hover, and keeps the 0.9.7 rule', () => {
  const at = NOW.getTime() - HOUR
  const html = cardOf(fixture(), { a: { readAt: at, state: 'signed-out' }, b: { readAt: at, state: 'no-profile' } })
  for (const name of ['a', 'b']) {
    assert.ok(acct(html, name).includes(`title="Open claude.ai in the browser profile of ${name}. Sign in here once so Grazr can see this account&#39;s limit resets">Open claude.ai</button>`), name)
  }
  assert.deepEqual(labels(acct(html, 'a')), ['Model reset', 'Full reset'])
})

test('the dial and clock rows follow the reading: the count in the label, its kinds on hover, only the counted kind', () => {
  const html = cardOf(fixture(), { a: ok([FABLE]), b: ok([FULL]) }, 'clock')
  const a = row(html, 'a')
  assert.ok(a.includes('<span class="row-label" title="2 Fable resets, all expire Mar 9, 2027, 8:59 AM GMT+1">active · 2 resets available</span>'))
  assert.deepEqual(labels(a), ['Fable reset'])
  assert.deepEqual(labels(row(html, 'b')), ['Swap + Full reset'])
})

test('a reading of an account applies to that account on every host', () => {
  const settings = { hosts: [{ name: 'mac' }, { name: 'devbox', ssh: 'devbox' }], target: 'mac' }
  const data = buildPanelData({
    settings,
    now: NOW,
    timeZone: TZ,
    limitResets: { a: ok([FABLE]) },
    hosts: settings.hosts.map((host) => ({ host, result: { ok: true, value: fixture() } })),
  })
  for (const host of data.hosts) {
    const entry = host.list.accounts.find((x) => x.name === 'a')
    assert.deepEqual([entry.reset, entry.resetCounts], [true, { full: 0, model: 2, kinds: [FABLE] }], host.name)
  }
})

test('the model reset buttons name the model, keep the same action, and fall back to Model reset', () => {
  const OPUS = { kind: 'model', label: 'Opus', count: 1, expires: 'Expires Dec 1' }
  const NAMELESS = { kind: 'model', label: '', count: 1, expires: '' }
  const named = cardOf(fixture(), { a: ok([FABLE]), b: ok([FABLE]) })
  assert.deepEqual(labels(acct(named, 'a')), ['Fable reset'])
  assert.deepEqual(labels(acct(named, 'b')), ['Swap + Fable reset'])
  const unnamed = cardOf(fixture(), {})
  const attrs = (html) => html.match(/<button class="act act-reset"[^>]*data-command="limit-reset-model"[^>]*>/)[0]
  assert.ok(attrs(acct(named, 'a')).includes('data-text="reset model" data-command="limit-reset-model" data-params="{&quot;host&quot;:&quot;mac&quot;}"'))
  assert.ok(attrs(acct(named, 'b')).includes('data-text="reset model" data-command="limit-reset-model"'))
  assert.ok(attrs(acct(named, 'b')).includes('Swap mac to b, then type /limit-reset fable into the terminal'))
  assert.deepEqual(labels(acct(unnamed, 'a')), ['Model reset', 'Full reset'])
  assert.deepEqual(labels(acct(cardOf(fixture(), { a: ok([FABLE, OPUS]) }), 'a')), ['Model reset'])
  assert.deepEqual(labels(acct(cardOf(fixture(), { a: ok([NAMELESS]) }), 'a')), ['Model reset'])
})
