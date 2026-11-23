import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsagePage } from '../lib/usage-page-resets.mjs'

// The Settings › Usage dialog as innerText gave it: icon glyphs on lines of their own, non-breaking spaces in times and dates.
const MODEL_ONLY = [
  'Usage', '', 'Your usage limits', 'Team', 'Current session', 'Resets at 2:00 PM', '13% used',
  'Weekly limits', 'Learn more about usage limits', '', 'All models', 'Resets Sun 7:00 PM', '3% used',
  'Fable', 'Resets Sun 7:00 PM', '4% used', '', 'Limit resets', '2 available', '',
  'Fable reset · 2', 'All expire Mar 9, 2027, 8:59 AM GMT+1',
  'Refills your 5-hour limit and your Fable allowance, and gives back what Fable used on your weekly limit. It doesn’t reset your whole week.',
  'Reset for free', 'Last updated: just now',
].join('\n')

const FULL_AND_MODEL = [
  'Usage', 'Your usage limits', 'Current session', 'Resets at 2:00 PM', '13% used', 'Limit resets', '3 available',
  '', 'Full reset', 'Expires Dec 10, 11:00 PM GMT+1', 'Reset for free',
  '', 'Fable reset · 2', 'All expire Mar 9, 2027, 8:59 AM GMT+1',
  'Refills your 5-hour limit and your Fable allowance.', 'Reset for free', 'Last updated: just now',
].join('\n')

test('a page with two Fable resets reads as two model resets and no full reset, with the page expiry text', () => {
  assert.deepEqual(parseUsagePage(MODEL_ONLY), {
    signedIn: true,
    loaded: true,
    full: 0,
    model: 2,
    kinds: [{ kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' }],
  })
})

test('a page with a full reset and two Fable resets reads both kinds, a kind without a count counting one', () => {
  assert.deepEqual(parseUsagePage(FULL_AND_MODEL), {
    signedIn: true,
    loaded: true,
    full: 1,
    model: 2,
    kinds: [
      { kind: 'full', label: 'Full', count: 1, expires: 'Expires Dec 10, 11:00 PM GMT+1' },
      { kind: 'model', label: 'Fable', count: 2, expires: 'All expire Mar 9, 2027, 8:59 AM GMT+1' },
    ],
  })
})

test('a loaded page without a Limit resets section holds none', () => {
  const text = 'Usage\nYour usage limits\nCurrent session\nResets at 2:00 PM\n13% used\nLast updated: just now'
  assert.deepEqual(parseUsagePage(text), { signedIn: true, loaded: true, full: 0, model: 0, kinds: [] })
})

test('a Limit resets section that says 0 available holds none', () => {
  const text = 'Your usage limits\nLimit resets\n0 available\nLast updated: just now'
  assert.deepEqual(parseUsagePage(text), { signedIn: true, loaded: true, full: 0, model: 0, kinds: [] })
})

test('a login screen is signed out', () => {
  const text = 'Claude\nLog in or sign up\nContinue with Google\nOR\nEnter your email\nContinue with email'
  assert.deepEqual(parseUsagePage(text), { signedIn: false, loaded: false, full: null, model: null, kinds: [] })
})

test('a page on the login address is signed out whatever it shows', () => {
  assert.equal(parseUsagePage('Loading…', { url: 'https://claude.ai/login?returnTo=%2Fsettings%2Fusage' }).signedIn, false)
})

test('a page that is neither the usage page nor a login screen is unknown, never none', () => {
  assert.deepEqual(parseUsagePage('Something went wrong\nTry again'), { signedIn: null, loaded: false, full: null, model: null, kinds: [] })
  assert.deepEqual(parseUsagePage(''), { signedIn: null, loaded: false, full: null, model: null, kinds: [] })
  assert.deepEqual(parseUsagePage(undefined), { signedIn: null, loaded: false, full: null, model: null, kinds: [] })
})

test('a Limit resets section whose kinds cannot be read is unknown', () => {
  const text = 'Your usage limits\nLimit resets\n2 available\nSomething new\nLast updated: just now'
  assert.deepEqual(parseUsagePage(text), { signedIn: true, loaded: true, full: null, model: null, kinds: [] })
})

test('kinds that do not add up to the count available are unknown', () => {
  const text = 'Your usage limits\nLimit resets\n3 available\nFable reset · 2\nLast updated: just now'
  assert.deepEqual(parseUsagePage(text), { signedIn: true, loaded: true, full: null, model: null, kinds: [] })
})

// An Ultra plan's page: "Your usage" as its heading, "No resets right now" for none, "Weekly reset" as its full reset.
const ULTRA_NONE = [
  'Settings', 'Usage', 'Your usage', 'Ultra', 'Limit hit. You can send new messages when your week resets Saturday, 6:00\u00A0AM GMT+1.',
  'Buy usage credits', 'This week', 'Resets Saturday 6:00\u00A0AM', '100% used', 'Fable', 'Up to 50% of your weekly limit',
  'Resets Saturday 6:00\u00A0AM', '66% used', 'Limit resets', '', 'No resets right now', '',
  'When you get one, it shows up here with its expiry date.', '', 'Usage credits', 'Available for any task.', '€0', '...',
].join('\n')

const ULTRA_TWO = [
  'Settings', 'Usage', 'Your usage', 'Ultra', 'Limit hit. You can send new messages when your week resets Monday, 7:00\u00A0PM GMT+1.',
  'Buy usage credits', 'This week', 'Resets at 7:00\u00A0PM', '100% used', 'Limit resets', '2 available',
  'Fable reset', 'Expires Mar\u00A09, 2027, 8:59\u00A0AM GMT+1',
  'Refills your Fable allowance and gives back what Fable used on your weekly limit. It doesn’t reset your whole week.',
  'Reset for free', 'Weekly reset', 'Expires Dec\u00A010, 11:00\u00A0PM GMT+1', 'Reset for free',
  'Usage credits', 'Available for any task.', '$0', '...',
].join('\n')

test('an Ultra page saying No resets right now is loaded and holds none', () => {
  assert.deepEqual(parseUsagePage(ULTRA_NONE), { signedIn: true, loaded: true, full: 0, model: 0, kinds: [] })
})

test('an Ultra page with a Fable and a Weekly reset reads one model and one full reset, the section ending at Usage credits', () => {
  assert.deepEqual(parseUsagePage(ULTRA_TWO), {
    signedIn: true,
    loaded: true,
    full: 1,
    model: 1,
    kinds: [
      { kind: 'model', label: 'Fable', count: 1, expires: 'Expires Mar 9, 2027, 8:59 AM GMT+1' },
      { kind: 'full', label: 'Weekly', count: 1, expires: 'Expires Dec 10, 11:00 PM GMT+1' },
    ],
  })
})

test('nothing after the section is read as a reset kind', () => {
  const text = 'Your usage\nLimit resets\n1 available\nFable reset\nUsage credits\nCredit reset\nLast updated: just now'
  assert.deepEqual(parseUsagePage(text).kinds.map((k) => k.label), ['Fable'])
  assert.equal(parseUsagePage(text).model, 1)
})

// A page with neither heading: the Settings sidebar, then the Usage tab. Its Limit resets section alone says it loaded.
const NO_HEADING = [
  'Settings', 'Account', 'Billing', 'Usage', 'Appearance', 'Your Claude', 'Capabilities', 'Notifications', 'Privacy', 'Wellbeing',
  'Plugins', 'Code', 'Settings', 'Usage', 'Limit hit. You can send new messages when your week resets Friday, 2:00\u00A0PM GMT+1.',
  'Buy usage credits', '·', 'Up to 30% off', 'Weekly limit · All models', 'Resets Fri 2:00\u00A0PM', '100% used', 'Fable',
  'Up to 50% of your weekly limit', 'Resets Fri 2:00\u00A0PM', '58% used', 'Limit resets', '2 available', 'Fable reset',
  'Expires Mar\u00A09, 2027, 8:59\u00A0AM GMT+1',
  'Refills your Fable allowance and gives back what Fable used on your weekly limit. It doesn’t reset your whole week.',
  'Reset for free', 'Weekly reset', 'Expires Dec\u00A010, 11:00\u00A0PM GMT+1', 'Reset for free', 'Usage credits', '...',
].join('\n')

test('a page without a Your usage heading is loaded by its Limit resets section, Buy usage credits above it not ending it', () => {
  assert.deepEqual(parseUsagePage(NO_HEADING), {
    signedIn: true,
    loaded: true,
    full: 1,
    model: 1,
    kinds: [
      { kind: 'model', label: 'Fable', count: 1, expires: 'Expires Mar 9, 2027, 8:59 AM GMT+1' },
      { kind: 'full', label: 'Weekly', count: 1, expires: 'Expires Dec 10, 11:00 PM GMT+1' },
    ],
  })
})
