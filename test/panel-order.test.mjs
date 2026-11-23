import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelData, displayAccounts, nextAccount } from '../lib/panel-data.mjs'
import { renderCard } from '../lib/panel.mjs'
import { clockSvg } from '../lib/clock.mjs'

const NOW = new Date('2026-10-21T10:00:00Z')

const session = (remaining, resets_at = null) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
const weekly = (remaining, resets_at = null) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at })
const parked = (name, snapshot, extra = {}) => ({ id: name, name, parked: true, blocked: null, in_order: true, snapshot, ...extra })

// s is active in the middle of the rotation. t and w are full; o and r are spent until 12:00 (r's week is above its
// threshold, so its later reset does not count); p is spent until its week resets on the 25th; v is spent with no
// reset time; q is blocked, u has no parked login and ghost is named with no record.
const report = () => ({
  active: { id: 's', name: 's' },
  order: ['o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'ghost'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    parked('o', [session(8, '2026-10-21T12:00:00Z'), weekly(60)]),
    parked('p', [session(5, '2026-10-21T15:00:00Z'), weekly(10, '2026-10-25T00:00:00Z')]),
    parked('q', [session(90), weekly(90)], { blocked: 'authentication_failed' }),
    parked('r', [session(3, '2026-10-21T12:00:00Z'), weekly(80, '2026-10-27T00:00:00Z')]),
    parked('s', [session(50, '2026-10-21T14:00:00Z'), weekly(70)], { parked: false }),
    parked('t', [session(100), weekly(100)]),
    parked('u', [session(100), weekly(100)], { parked: false }),
    parked('v', [session(1), weekly(90)]),
    parked('w', [session(100), weekly(100)]),
  ],
})

const names = (accounts) => accounts.map((a) => a.name)

test('the active account comes first, then the usable ones in rotation order, then the spent, then the rest', () => {
  assert.deepEqual(names(displayAccounts(report(), NOW)), ['s', 't', 'w', 'o', 'r', 'p', 'v', 'q', 'u', 'ghost'])
})

test('the first usable account is the engine NEXT, which still follows the rotation', () => {
  assert.equal(nextAccount(report(), NOW).name, 't')
  assert.equal(displayAccounts(report(), NOW)[1].name, 't')
})

test('with no active account the usable, spent and unrotatable tiers still apply', () => {
  const r = report()
  r.active = null
  assert.deepEqual(names(displayAccounts(r, NOW)), ['t', 'w', 'o', 'r', 'p', 'v', 'q', 's', 'u', 'ghost'])
})

test('a spent window whose reset has passed no longer counts', () => {
  const r = report()
  // An hour on, o's and r's 5-hour windows have reset: both are usable again and join t and w in rotation order.
  assert.deepEqual(names(displayAccounts(r, new Date('2026-10-21T13:00:00Z'))), ['s', 'o', 'r', 't', 'w', 'p', 'v', 'q', 'u', 'ghost'])
})

test('an Ultra account with no 5-hour limit is ordered by its week alone', () => {
  const r = {
    active: { id: 'a', name: 'a' },
    order: ['a', 'm', 'n'],
    settings: { enabled: true, ultra_no_session: true, thresholds: { session: 15, weekly: 20 } },
    accounts: [
      parked('a', [session(50), weekly(50)], { parked: false }),
      parked('m', [session(1, '2026-10-21T11:00:00Z'), weekly(5, '2026-10-24T00:00:00Z')], { ultra: true }),
      parked('n', [session(2, '2026-10-21T13:00:00Z'), weekly(90)]),
    ],
  }
  assert.deepEqual(names(displayAccounts(r, NOW)), ['a', 'n', 'm'])
})

test('rows, dial, list and clock number each account by its display position; colour keeps the rotation slot', () => {
  const host = buildPanelData({
    settings: { hosts: [{ name: 'mac' }], target: 'mac' },
    now: NOW,
    timeZone: 'UTC',
    hosts: [{ host: { name: 'mac' }, result: { ok: true, value: report() } }],
  }).hosts[0]
  const shown = ['s', 't', 'w', 'o', 'r', 'p', 'v', 'q', 'u', 'ghost']
  for (const key of ['session', 'weekly']) {
    assert.deepEqual(host.views[key].rows.map((row) => [row.name, row.index]), shown.map((name, i) => [name, i + 1]))
    assert.deepEqual(names(host.views[key].segments), shown)
  }
  assert.equal(host.views.session.rows[1].status, 'next')
  assert.deepEqual(host.list.accounts.map((a) => [a.name, a.index]), shown.map((name, i) => [name, i + 1]))
  // The clock keeps the rotation order for its projection; its badges carry the row numbers and its colours the slots.
  assert.deepEqual(host.clock.accounts.map((a) => [a.name, a.index, a.slot]), [
    ['o', 4, 1], ['p', 6, 2], ['q', 8, 3], ['r', 5, 4], ['s', 1, 5], ['t', 2, 6], ['u', 9, 7], ['v', 7, 8], ['w', 3, 9],
  ])
  const html = renderCard({ ...host, open: true }, {})
  assert.ok(html.includes('<span class="row-index acct-5">1</span>'))
  assert.ok(html.includes('<span class="row-index acct-1">2</span>'))
  assert.ok(clockSvg(host.clock, { now: NOW.getTime() / 1000, span: 'session', timeZone: 'UTC' }).includes('class="clock-name acct-5"'))
})
