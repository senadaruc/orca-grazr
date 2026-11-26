import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeState, callbackCode, snapshotCode, LOGIN_TIMEOUT_MS, RELAY_POLL_MS } from '../lib/signin.mjs'
import { CALLBACK, D1, DEV, NOW, SETTINGS, URL, argAfter, assertCleaned, callsWith, harness, json, killsOf, openRemoteTab, until } from './support/signin-harness.mjs'

// One poll of the tab's address: waits for the poll to be armed, fires it, and lets its answer land.
async function tick(h) {
  await until(() => h.clock.hasTimer(RELAY_POLL_MS))
  const before = callsWith(h, 'tab show').length
  h.clock.fire(RELAY_POLL_MS)
  await until(() => callsWith(h, 'tab show').length === before + 1)
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

// A harness whose tab shows whatever page.url holds when it is read.
function tabHarness(extra = {}) {
  const page = { url: URL, gone: false }
  const h = harness({
    ...extra,
    overrides: {
      'tab show': () => (page.gone
        ? { code: 1, stdout: json({ ok: false, error: { message: 'no such tab' } }) }
        : { stdout: json({ ok: true, result: { tab: { url: page.url } } }) }),
      ...(extra.overrides ?? {}),
    },
  })
  h.closeTab = () => { page.gone = true }
  return { h, page }
}

test('the callback code is written once to the login stdin as code#state; polling stops; the login enrols', async () => {
  const { h, page } = tabHarness()
  const login = await openRemoteTab(h, null)
  await tick(h)
  assert.deepEqual(login.stdin.written, [], 'nothing is sent while the user has not approved')
  page.url = CALLBACK
  await tick(h)
  assert.deepEqual(login.stdin.written, ['abc123#s\n'])
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), false, 'polling stops once the code is sent')
  const shown = callsWith(h, 'tab show').length
  login.exit(0)
  await until(() => h.refreshes === 2)
  assert.equal(callsWith(h, 'tab show').length, shown, 'no more polls after the send')
  assert.equal(h.published[0].title, 'devbox: signed in')
  assert.equal(callsWith(h, 'enrol --from').length, 1)
  const outside = JSON.stringify([h.calls.map((c) => [c.line, c.args]), h.spawns.map((s) => s.args), h.published, h.logs])
  assert.equal(outside.includes('abc123'), false, 'the code is in no argument, log or toast')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('nothing is written for an authorize page, a callback without a state, another host or path, a line break in the code, or plain http', async () => {
  const { h, page } = tabHarness()
  const login = await openRemoteTab(h, null)
  const refused = [
    URL,
    'https://platform.claude.com/oauth/code/callback?code=abc',
    'https://evil.example.com/oauth/code/callback?code=abc&state=s',
    'https://platform.claude.com/oauth/code/callbackx?code=abc&state=s',
    'https://platform.claude.com/oauth/code/callback?code=a%0Ab&state=s',
    'http://platform.claude.com/oauth/code/callback?code=abc&state=s',
  ]
  for (const url of refused) {
    page.url = url
    await tick(h)
    assert.deepEqual(login.stdin.written, [], url)
  }
  page.url = CALLBACK
  await tick(h)
  assert.deepEqual(login.stdin.written, ['abc123#s\n'])
  login.exit(0)
  await until(() => h.refreshes === 2)
})

test('a tab address that cannot be read is polled again, and the code is still relayed', async () => {
  let reads = 0
  const h = harness({
    overrides: {
      'tab show': () => {
        reads++
        return reads === 1
          ? { code: 1, stdout: json({ ok: false, error: { message: 'busy' } }) }
          : { stdout: json({ ok: true, result: { tab: { url: CALLBACK } } }) }
      },
    },
  })
  const login = await openRemoteTab(h, null)
  // The first read, made as the tab opens, fails; the poll is armed again and sends nothing.
  await until(() => callsWith(h, 'tab show').length === 1 && h.clock.hasTimer(RELAY_POLL_MS))
  assert.deepEqual(login.stdin.written, [], 'the failed read sends nothing')
  await tick(h)
  assert.deepEqual(login.stdin.written, ['abc123#s\n'])
  login.exit(0)
  await until(() => h.refreshes === 2)
  assert.equal(h.published[0].title, 'devbox: signed in')
})

test('an address unchanged for the whole 10 minutes ends the sign-in as timed out: the login is stopped by its pid, discarded and its tab closed', async () => {
  const { h } = tabHarness({ nowMs: NOW.getTime() })
  const login = await openRemoteTab(h, null)
  await until(() => h.clock.hasTimer(RELAY_POLL_MS))
  h.clockNow.ms += LOGIN_TIMEOUT_MS
  h.clock.fire(RELAY_POLL_MS)
  await until(() => login.signals.length === 1)
  login.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 2)
  assert.equal(h.published[0].title, 'devbox: sign-in timed out')
  assert.equal(h.published[0].body, 'Nothing was enrolled.')
  assert.equal(killsOf(h).length, 1)
  assert.equal(killsOf(h)[0].line, 'kill -KILL -- -4242')
  assert.equal(callsWith(h, 'enrol').length, 0)
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('an address that keeps changing is not unchanged: the sign-in goes on past the 10 minutes', async () => {
  const { h, page } = tabHarness({ nowMs: NOW.getTime() })
  const login = await openRemoteTab(h, null)
  page.url = `${URL}&step=1`
  await tick(h)
  h.clockNow.ms += LOGIN_TIMEOUT_MS
  page.url = `${URL}&step=2`
  await tick(h)
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true, 'still waiting for the code')
  assert.equal(login.signals.length, 0)
  login.exit(1, 'Login failed\n')
  await until(() => h.refreshes === 2)
})

test('the login ending before any code stops polling, and the card says why', async () => {
  const { h } = tabHarness()
  const login = await openRemoteTab(h, null)
  await tick(h)
  login.exit(1, 'Login failed: no code\n')
  await until(() => h.refreshes === 2)
  assert.equal(h.published[0].title, 'devbox: sign-in failed')
  assert.equal(h.published[0].body, 'Login failed: no code\nNothing was enrolled.')
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), false)
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('a cancel while waiting for the code stops polling, writes nothing, and the replacing sign-in starts', async () => {
  const { h } = tabHarness()
  const first = await openRemoteTab(h, null)
  await tick(h)
  h.closeTab() // the sign-in tab is gone: a new start restarts
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  first.exit(null, '', 'SIGTERM')
  await until(() => h.spawns.length === 2)
  assert.deepEqual(first.stdin.written, [])
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), false)
  assert.equal(h.published[0].title, 'devbox: sign-in cancelled')
  assert.equal(killsOf(h).length, 1, 'the cancelled login is stopped by its pid')
})

test('the manual flow output, exactly as claude prints it without a tty, opens its address; the prompt without a newline is left alone', async () => {
  const authorize = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c1&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=x&code_challenge_method=S256&state=s&login_hint=a%40example.com'
  const h = harness()
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const { child } = h.spawns[0]
  child.emitPid()
  child.stdout.emit('data', Buffer.from(`Opening browser to sign in…\nIf the browser didn't open, visit: ${authorize}\nPaste code here if prompted > `))
  await until(() => callsWith(h, 'tab create').length === 1)
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--url'), authorize)
  assert.deepEqual(child.stdin.written, [], 'the prompt itself writes nothing')
  child.exit(1, 'Login failed\n')
  await until(() => h.refreshes === 2)
})

test('callbackCode reads only the callback page, with a code and a state of plain token characters that match the expected state', () => {
  assert.deepEqual(callbackCode(CALLBACK, 's'), { code: 'abc123', state: 's' })
  assert.deepEqual(callbackCode('https://platform.claude.com/oauth/code/callback?code=a-b_c.d~e&state=S1', 'S1'), { code: 'a-b_c.d~e', state: 'S1' })
  assert.equal(callbackCode('https://platform.claude.com/oauth/code/callback?code=abc', 's'), null)
  assert.equal(callbackCode('https://platform.claude.com/oauth/code/callback?state=s', 's'), null)
  assert.equal(callbackCode('https://platform.claude.com/oauth/code/callback?code=a%23b&state=s', 's'), null, 'a # would break code#state')
  assert.equal(callbackCode('https://platform.claude.com/other?code=a&state=s', 's'), null)
  assert.equal(callbackCode('https://claude.com/oauth/code/callback?code=a&state=s', 's'), null)
  assert.equal(callbackCode(CALLBACK, 'other'), null, 'a state other than the one the job opened is refused')
  assert.equal(callbackCode(CALLBACK, undefined), null, 'no expected state, nothing is relayed')
  assert.equal(callbackCode(undefined, 's'), null)
  assert.equal(callbackCode('not a url', 's'), null)
})

test('code and state are each capped at 512 characters, and at least one', () => {
  const long = (n) => 'a'.repeat(n)
  assert.notEqual(callbackCode(`https://platform.claude.com/oauth/code/callback?code=${long(512)}&state=s`, 's'), null, '512 is allowed')
  assert.equal(callbackCode(`https://platform.claude.com/oauth/code/callback?code=${long(513)}&state=s`, 's'), null, 'a 513-character code is refused')
  assert.equal(callbackCode(`https://platform.claude.com/oauth/code/callback?code=abc&state=${long(513)}`, long(513)), null, 'a 513-character state is refused')
  assert.equal(callbackCode('https://platform.claude.com/oauth/code/callback?code=&state=s', 's'), null, 'an empty code is refused')
})

test('a callback whose state is not the one the job opened is ignored: nothing is written, and polling goes on until the right one', async () => {
  const { h, page } = tabHarness()
  const login = await openRemoteTab(h, null)
  page.url = 'https://platform.claude.com/oauth/code/callback?code=abc123&state=other'
  await tick(h)
  await tick(h)
  assert.deepEqual(login.stdin.written, [], 'a mismatched state writes nothing')
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true, 'still polling')
  page.url = CALLBACK
  await tick(h)
  assert.deepEqual(login.stdin.written, ['abc123#s\n'])
  login.exit(0)
  await until(() => h.refreshes === 2)
})

test('a cancel during the poll window writes nothing, even when the tab already shows the callback', async () => {
  let open
  const gate = new Promise((resolve) => { open = resolve })
  let reads = 0
  let gone = false
  const h = harness({
    overrides: {
      'tab show': async () => {
        if (gone) return { code: 1, stdout: json({ ok: false, error: { message: 'no such tab' } }) }
        reads++
        // Only the first read waits: the cancel lands while it is in flight.
        if (reads === 1) await gate
        return { stdout: json({ ok: true, result: { tab: { url: CALLBACK } } }) }
      },
    },
  })
  const first = await openRemoteTab(h, null)
  await until(() => reads === 1)
  gone = true // the sign-in tab is gone: a new start restarts
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  assert.deepEqual(first.signals, ['SIGTERM'], 'the sign-in is cancelled')
  open()
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(first.stdin.written, [], 'nothing is written after the cancel')
  first.exit(null, '', 'SIGTERM')
  await until(() => h.spawns.length === 2)
  assert.equal(h.published[0].title, 'devbox: sign-in cancelled')
  assert.deepEqual(first.stdin.written, [])
})

test('after five failed reads in a row the tab is taken as closed: the login is stopped by its pid, discarded, and the card says so', async () => {
  const h = harness({ overrides: { 'tab show': () => ({ code: 1, stdout: json({ ok: false, error: { message: 'no such tab' } }) }) } })
  const login = await openRemoteTab(h, null)
  // The first failed read is the one made as the tab opens; four more polls are not yet five.
  for (let i = 0; i < 4; i++) await tick(h)
  assert.equal(callsWith(h, 'tab show').length, 5)
  assert.equal(login.signals.length, 1, 'the fifth failed read stops the login')
  login.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 2)
  assert.equal(h.published[0].title, 'devbox: sign-in failed')
  assert.equal(h.published[0].body, 'The sign-in tab was closed.\nNothing was enrolled.')
  assert.equal(killsOf(h).length, 1)
  assert.equal(killsOf(h)[0].line, 'kill -KILL -- -4242')
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), false, 'polling stops')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('reads that succeed in between reset the count: four failures, a success, then four more do not close the tab', async () => {
  const answers = ['fail', 'fail', 'fail', 'fail', 'ok', 'fail', 'fail', 'fail', 'fail']
  let reads = 0
  const h = harness({
    overrides: {
      'tab show': () => {
        const answer = answers[Math.min(reads, answers.length - 1)]
        reads++
        return answer === 'ok'
          ? { stdout: json({ ok: true, result: { tab: { url: URL } } }) }
          : { code: 1, stdout: json({ ok: false, error: { message: 'busy' } }) }
      },
    },
  })
  const login = await openRemoteTab(h, null)
  for (let i = 0; i < 8; i++) await tick(h)
  assert.equal(reads, 9)
  assert.equal(login.signals.length, 0, 'four failures in a row after the success are not five')
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true)
  login.exit(1, 'stopped by the test\n')
  await until(() => h.refreshes === 2)
})

// The short sign-in address Claude Code prints from 2.1.330 on: an opaque token, no state.
const SHORT = 'https://claude.ai/oauth/authorize?AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghi&login_hint=a%40example.com'
// The login page claude.ai expands it to in a signed-out profile: returnTo carries the authorize address and its state.
const SHORT_LOGIN = 'https://claude.ai/login?email=a%40example.com&selectAccount=true&from=cli&returnTo=%2Foauth%2Fauthorize%3Fcode%3Dtrue%26client_id%3Dc1%26response_type%3Dcode%26redirect_uri%3Dhttps%253A%252F%252Fplatform.claude.com%252Foauth%252Fcode%252Fcallback%26scope%3Duser%253Ainference%26state%3DsT4te_short-1%26login_hint%3Da%2540example.com'
// The long authorize address a signed-in profile is expected to show.
const SHORT_LONG = 'https://claude.ai/oauth/authorize?code=true&client_id=c1&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=sT4te_short-1&login_hint=a%40example.com'
const SHORT_CALLBACK = 'https://platform.claude.com/oauth/code/callback?code=abc123&state=sT4te_short-1'

// Starts a sign-in whose login prints the short address, and gets it to the point where the tab is open on it.
async function openShortTab(h, page) {
  page.url = SHORT
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const login = h.spawns[0].child
  login.emitPid()
  login.stdout.emit('data', Buffer.from(`Opening browser to sign in…\nIf the browser didn't open, visit: ${SHORT}\nPaste code here if prompted > `))
  await until(() => callsWith(h, 'tab create').length === 1)
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--url'), SHORT)
  return login
}

test('a short address: the state is learned from the login page returnTo, and the callback with it is relayed', async () => {
  const { h, page } = tabHarness()
  const login = await openShortTab(h, page)
  await tick(h)
  page.url = SHORT_LOGIN
  await tick(h)
  assert.deepEqual(login.stdin.written, [])
  page.url = SHORT_CALLBACK
  await tick(h)
  assert.deepEqual(login.stdin.written, ['abc123#sT4te_short-1\n'])
  login.exit(0)
  await until(() => h.refreshes === 2)
  assert.equal(h.published[0].title, 'devbox: signed in')
  assert.equal(JSON.stringify(h.logs).includes('sT4te_short-1'), false, 'the state is in no log')
})

test('a short address: the state is learned from the long authorize address, and the callback with it is relayed', async () => {
  const { h, page } = tabHarness()
  const login = await openShortTab(h, page)
  page.url = SHORT_LONG
  await tick(h)
  page.url = SHORT_CALLBACK
  await tick(h)
  assert.deepEqual(login.stdin.written, ['abc123#sT4te_short-1\n'])
  login.exit(0)
  await until(() => h.refreshes === 2)
})

test('a short address: a callback whose state is not the learned one is ignored, and a later state does not replace the first', async () => {
  const { h, page } = tabHarness()
  const login = await openShortTab(h, page)
  page.url = SHORT_LOGIN
  await tick(h)
  page.url = 'https://claude.ai/oauth/authorize?code=true&client_id=c1&state=later'
  await tick(h)
  page.url = 'https://platform.claude.com/oauth/code/callback?code=abc123&state=later'
  await tick(h)
  assert.deepEqual(login.stdin.written, [], 'a state other than the first learned writes nothing')
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true, 'still polling')
  page.url = SHORT_CALLBACK
  await tick(h)
  assert.deepEqual(login.stdin.written, ['abc123#sT4te_short-1\n'])
  login.exit(0)
  await until(() => h.refreshes === 2)
})

test('a short address: a callback before any state was learned is not relayed, and the log says so once, without the code or state', async () => {
  const { h, page } = tabHarness()
  const login = await openShortTab(h, page)
  page.url = SHORT_CALLBACK
  await tick(h)
  await tick(h)
  assert.deepEqual(login.stdin.written, [])
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true, 'still polling')
  assert.deepEqual(h.logs.filter((l) => l.includes('no state')), ['grazr sign-in: the sign-in reached its callback, but no state was learned from the sign-in address or the tab, so the code was not relayed'])
  const logged = JSON.stringify(h.logs)
  assert.equal(logged.includes('abc123') || logged.includes('sT4te_short-1'), false)
  login.exit(1, 'Login failed\n')
  await until(() => h.refreshes === 2)
})

test('authorizeState reads the state of an authorize address, or of a login page whose returnTo is one, on Claude\'s sites over https', () => {
  assert.equal(authorizeState(SHORT_LONG), 'sT4te_short-1')
  assert.equal(authorizeState(SHORT_LOGIN), 'sT4te_short-1')
  assert.equal(authorizeState('https://claude.com/cai/oauth/authorize?code=true&state=S2'), 'S2')
  assert.equal(authorizeState('https://claude.ai/login?returnTo=%2Fcai%2Foauth%2Fauthorize%3Fstate%3DS3'), 'S3')
  assert.equal(authorizeState(SHORT), null, 'the short address has no state')
  assert.equal(authorizeState('http://claude.ai/oauth/authorize?state=S'), null, 'plain http')
  assert.equal(authorizeState('https://evil.example.com/oauth/authorize?state=S'), null, 'another site')
  assert.equal(authorizeState('https://claude.ai/oauth/authorizex?state=S'), null, 'another path')
  assert.equal(authorizeState('https://claude.ai/new?state=S'), null, 'not an authorize page')
  assert.equal(authorizeState('https://claude.ai/settings?returnTo=%2Foauth%2Fauthorize%3Fstate%3DS'), null, 'returnTo off the login page')
  assert.equal(authorizeState('https://claude.ai/login?returnTo=https%3A%2F%2Fevil.example.com%2Foauth%2Fauthorize%3Fstate%3DS'), null, 'an absolute returnTo')
  assert.equal(authorizeState('https://claude.ai/login?returnTo=%2F%2Fevil.example.com%2Foauth%2Fauthorize%3Fstate%3DS'), null, 'a protocol-relative returnTo')
  assert.equal(authorizeState('https://claude.ai/login?returnTo=%2F%5Cevil.example.com%2Foauth%2Fauthorize%3Fstate%3DS'), null, 'a backslash returnTo')
  assert.equal(authorizeState('https://claude.ai/login?returnTo=%2Fnew%3Fstate%3DS'), null, 'a returnTo that is not an authorize address')
  assert.equal(authorizeState('https://claude.ai/oauth/authorize?state=a%23b'), null, 'a # would break code#state')
  assert.equal(authorizeState('https://claude.ai/oauth/authorize?state='), null, 'an empty state')
  assert.equal(authorizeState(`https://claude.ai/oauth/authorize?state=${'a'.repeat(512)}`), 'a'.repeat(512), '512 is allowed')
  assert.equal(authorizeState(`https://claude.ai/oauth/authorize?state=${'a'.repeat(513)}`), null, '513 is refused')
  assert.equal(authorizeState('not a url'), null)
  assert.equal(authorizeState(undefined), null)
})

// The bare callback Claude Code 2.1.330 and later leaves the tab on: no code or state in its address.
const BARE_CALLBACK = 'https://platform.claude.com/oauth/code/callback'
const PAGE_CODE = 'Xq7-Lm2_Rt9vBn4cWz8kPd3sHf6gJy1aEo5uIx0tNr-Mv_Kb'
// The callback page's snapshot, as `orca snapshot` prints it: the value to paste is code#state, as text.
const callbackSnapshot = (pasted) => [
  '- generic',
  '  - heading "Authentication code" [level=1, ref=e9]',
  '  - generic',
  '    - StaticText "Paste this into "',
  '    - StaticText "Claude Code"',
  '    - StaticText ":"',
  '  - paragraph',
  `    - StaticText "${pasted}"`,
  '  - status',
  '  - button "Copy code" [ref=e10]',
  '    - StaticText "Copy code"',
  '  - alert',
  '  - generic',
  '    - status [ref=e11] clickable [onclick]',
  '    - region "Notifications" [ref=e12]',
].join('\n')
const PAGE_SNAPSHOT = callbackSnapshot(`${PAGE_CODE}#sT4te_short-1`)

// A harness whose tab shows page.url, and whose snapshot is page.snapshot with page.snapshotUrl (the tab's own address
// unless a test sets another); page.snapshotFails makes the snapshot call fail.
function callbackHarness() {
  const { h, page } = tabHarness({
    overrides: {
      'snapshot': () => (page.snapshotFails
        ? { code: 1, stdout: json({ ok: false, error: { message: 'busy' } }) }
        : { stdout: json({ ok: true, result: { url: page.snapshotUrl ?? page.url, title: 'Authentication code | Claude Platform', snapshot: page.url === BARE_CALLBACK ? page.snapshot : '' } }) }),
    },
  })
  page.snapshot = PAGE_SNAPSHOT
  page.snapshotUrl = null
  page.snapshotFails = false
  return { h, page }
}

test('a short address whose callback keeps no code in its address: the code#state the page shows is relayed once', async () => {
  const { h, page } = callbackHarness()
  const login = await openShortTab(h, page)
  page.url = SHORT_LOGIN
  await tick(h)
  page.url = BARE_CALLBACK
  await tick(h)
  assert.deepEqual(login.stdin.written, [`${PAGE_CODE}#sT4te_short-1\n`])
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), false, 'polling stops once the code is sent')
  login.exit(0)
  await until(() => h.refreshes === 2)
  assert.equal(h.published[0].title, 'devbox: signed in')
  const outside = JSON.stringify([h.calls.map((c) => [c.line, c.args]), h.published, h.logs])
  assert.equal(outside.includes(PAGE_CODE) || h.logs.join('\n').includes('sT4te_short-1'), false, 'the code and state are in no argument, log or toast')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('a callback page whose code carries another state than the learned one is not relayed', async () => {
  const { h, page } = callbackHarness()
  const login = await openShortTab(h, page)
  page.url = SHORT_LOGIN
  await tick(h)
  page.url = BARE_CALLBACK
  page.snapshot = callbackSnapshot(`${PAGE_CODE}#otherState`)
  await tick(h)
  await tick(h)
  assert.deepEqual(login.stdin.written, [])
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true, 'still polling')
  login.exit(1, 'Login failed\n')
  await until(() => h.refreshes === 2)
})

test('a bare callback before any state was learned: the page is not read for a code, nothing is written, and the log says so once', async () => {
  const { h, page } = callbackHarness()
  const login = await openShortTab(h, page)
  await tick(h)
  const snapshots = callsWith(h, 'snapshot').length
  page.url = BARE_CALLBACK
  await tick(h)
  await tick(h)
  assert.deepEqual(login.stdin.written, [])
  assert.equal(callsWith(h, 'snapshot').length, snapshots, 'the callback page is not read without a state')
  assert.equal(h.logs.filter((l) => l.includes('no state')).length, 1)
  login.exit(1, 'Login failed\n')
  await until(() => h.refreshes === 2)
})

test('a failed read of the callback page is logged once and polled again; a later good read relays the code', async () => {
  const { h, page } = callbackHarness()
  const login = await openShortTab(h, page)
  page.url = SHORT_LOGIN
  await tick(h)
  page.url = BARE_CALLBACK
  page.snapshotFails = true
  await tick(h)
  await tick(h)
  assert.deepEqual(login.stdin.written, [])
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true, 'still polling')
  assert.deepEqual(h.logs.filter((l) => l.includes('callback page')), ['grazr sign-in: the callback page could not be read for its code: busy'])
  page.snapshotFails = false
  await tick(h)
  assert.deepEqual(login.stdin.written, [`${PAGE_CODE}#sT4te_short-1\n`])
  login.exit(0)
  await until(() => h.refreshes === 2)
  assert.equal(h.published[0].title, 'devbox: signed in')
})

test('a snapshot taken once the tab has left the callback page is not trusted', async () => {
  const { h, page } = callbackHarness()
  const login = await openShortTab(h, page)
  page.url = SHORT_LOGIN
  await tick(h)
  page.url = BARE_CALLBACK
  page.snapshotUrl = 'https://claude.ai/new'
  await tick(h)
  page.snapshotUrl = 'https://platform.claude.com/oauth/code/callbackx'
  await tick(h)
  assert.deepEqual(login.stdin.written, [])
  assert.equal(h.clock.hasTimer(RELAY_POLL_MS), true, 'still polling')
  login.exit(1, 'Login failed\n')
  await until(() => h.refreshes === 2)
})

test('snapshotCode takes the one code#state of plain token characters the page shows, with the expected state', () => {
  assert.deepEqual(snapshotCode(PAGE_SNAPSHOT, 'sT4te_short-1'), { code: PAGE_CODE, state: 'sT4te_short-1' })
  assert.deepEqual(snapshotCode(`${PAGE_SNAPSHOT}\n    - StaticText "${PAGE_CODE}#sT4te_short-1"`, 'sT4te_short-1'), { code: PAGE_CODE, state: 'sT4te_short-1' }, 'the same value twice is one candidate')
  assert.equal(snapshotCode(PAGE_SNAPSHOT, 'other'), null, 'another state')
  assert.equal(snapshotCode(PAGE_SNAPSHOT, null), null, 'no expected state')
  assert.equal(snapshotCode(PAGE_SNAPSHOT, ''), null, 'an empty expected state')
  assert.equal(snapshotCode(`${PAGE_SNAPSHOT}\n    - StaticText "zzz#sT4te_short-1"`, 'sT4te_short-1'), null, 'two candidates')
  assert.equal(snapshotCode(callbackSnapshot('ab cd#sT4te_short-1'), 'sT4te_short-1'), null, 'a space in the code')
  assert.equal(snapshotCode(callbackSnapshot('abc#sT4te/short-1'), 'sT4te/short-1'), null, 'a slash in the state')
  assert.equal(snapshotCode(callbackSnapshot('a#b#sT4te_short-1'), 'sT4te_short-1'), null, 'two #')
  assert.equal(snapshotCode(callbackSnapshot('#sT4te_short-1'), 'sT4te_short-1'), null, 'an empty code')
  assert.equal(snapshotCode(callbackSnapshot(`${'a'.repeat(513)}#sT4te_short-1`), 'sT4te_short-1'), null, 'a 513-character code')
  assert.equal(snapshotCode(callbackSnapshot(`abc#${'s'.repeat(513)}`), 's'.repeat(513)), null, 'a 513-character state')
  assert.deepEqual(snapshotCode(callbackSnapshot(`${'a'.repeat(512)}#sT4te_short-1`), 'sT4te_short-1'), { code: 'a'.repeat(512), state: 'sT4te_short-1' }, '512 is allowed')
  assert.equal(snapshotCode('- generic\n  - StaticText "Paste this into "', 's'), null, 'no candidate')
  assert.equal(snapshotCode(`  - heading "${PAGE_CODE}#sT4te_short-1"`, 'sT4te_short-1'), null, 'only StaticText counts')
  assert.equal(snapshotCode(undefined, 's'), null)
})
