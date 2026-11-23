import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readingFromGrants, unavailableText } from '../lib/limit-reset-grants.mjs'
import { cedar, teamCedar, fullGrant, fableGrant } from './support/claude-data-fixture.mjs'

const read = (c) => readingFromGrants(c, { timeZone: 'UTC' })

test('the Team grants as seen live: the spent full reset counts nothing, the two Fable resets count as one model kind', () => {
  assert.deepEqual(read(teamCedar()), {
    full: 0,
    model: 2,
    kinds: [{ kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 7:59 AM UTC', expiresAt: '2027-03-09T07:59:00.000Z', usableNow: true, unavailableReason: null }],
    usableNow: { full: null, model: true },
  })
})

test('a grant that clears the week is a full reset whatever its type says, one that does not is a model reset', () => {
  const r = read(cedar([fullGrant(1), fableGrant('launch-2610-fable', 1, { type: 'full' }), { ...fableGrant('launch-2701-x', 1), label: 'A reset', ends_at: '2027-01-01T00:00:00+00:00' }]))
  assert.deepEqual([r.full, r.model], [1, 2])
  assert.deepEqual(r.kinds.map((k) => [k.kind, k.label, k.count, k.expires]), [
    ['full', 'Full', 1, 'Expires Dec 10, 2026, 10:00 PM UTC'],
    ['model', 'Fable', 1, 'Expires Mar 9, 2027, 7:59 AM UTC'],
    ['model', 'Model', 1, 'Expires Jan 1, 2027, 12:00 AM UTC'],
  ])
})

test('the earliest end of a kind is its expiry; ends that differ say the first one', () => {
  const r = read(cedar([fableGrant('launch-2610-fable', 1), fableGrant('launch-2610-fable-6mo', 2, { ends_at: '2027-01-15T12:00:00+00:00' })]))
  assert.deepEqual(r.kinds.map((k) => [k.count, k.expires, k.expiresAt]), [[3, 'First expires Jan 15, 2027, 12:00 PM UTC', '2027-01-15T12:00:00.000Z']])
})

test('a kind with resets left that cannot be used now says so, and why', () => {
  const r = read(cedar([fullGrant(1, { usable_now: false, unavailable_reason: 'unavailable' })]))
  assert.deepEqual([r.full, r.usableNow.full, r.kinds[0].usableNow, r.kinds[0].unavailableReason], [1, false, false, 'unavailable'])
  assert.equal(unavailableText('unavailable'), 'claude.ai: not usable right now')
  assert.equal(unavailableText('requires_limit'), 'claude.ai: usable once a limit is reached')
  assert.equal(read(cedar([fullGrant(1, { usable_now: false, unavailable_reason: null })], { eligible: false, ineligible_reason: 'tier' })).kinds[0].unavailableReason, 'tier')
})

test('a free organization holds none; a reply without grants in a known form is not a reading', () => {
  assert.deepEqual(read(cedar([], { eligible: false, ineligible_reason: 'tier' })), { full: 0, model: 0, kinds: [], usableNow: { full: null, model: null } })
  assert.equal(read(null), null)
  assert.equal(read({ eligible: true }), null)
  assert.equal(read(cedar([{ ...fableGrant(), clears: undefined }])), null)
  assert.equal(read(cedar([{ ...fableGrant(), resets_left: '1' }])), null)
})
