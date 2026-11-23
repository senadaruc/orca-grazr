import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginHostFor, clip, LINE_MAX, LOGIN_TIMEOUT_MS, URL_TIMEOUT_MS } from '../lib/signin.mjs'
import { fixtureSettings } from './support/fixture-hosts.mjs'
import { D1, D2, DEV, ENROLLED, EXPORT_LINE, MAC, OK_ENROL, ORCA, SETTINGS, SSH, STAMP, URL, WORKSPACE, argAfter, assertCleaned, callsWith, closesOf, deletesOf, discardsOf, exportOf, harness, json, openOrganizationTab, openRemoteTab, statusReply, until, LABEL } from './support/signin-harness.mjs'

test('a remote card signs in on its own host: the login runs there in a throwaway dir, opens in that environment, enrols there and is discarded', async () => {
  const h = harness()
  assert.deepEqual(await h.jobs.start({ host: DEV, settings: SETTINGS, account: null }), { ok: true, message: "Signing in a new account in Orca's browser — sign in, then approve Claude Code" })
  await until(() => h.spawns.length === 1)
  const [login] = h.spawns
  assert.equal(login.file, SSH)
  assert.deepEqual(login.args.slice(0, -1), [...SETTINGS.sshOptions, 'devbox'])
  assert.equal(login.args.at(-1), `CLAUDE_CONFIG_DIR=${D1} setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 ~/.local/bin/claude auth login'`)
  login.child.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  const create = callsWith(h, 'tab create')[0]
  assert.equal(create.bin, ORCA)
  assert.deepEqual(create.args.slice(0, 8), ['tab', 'create', '--worktree', WORKSPACE, '--url', URL, '--profile', 'p1'])
  assert.equal(create.args.at(-1), '--json')
  assert.deepEqual(callsWith(h, "tab profile create")[0].args.slice(0, 7), ['tab', 'profile', 'create', '--label', `${LABEL}`, '--scope', 'isolated'])
  login.child.exit(0)
  await until(() => h.published.length === 1 && h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: signed in')
  assert.equal(h.published[0].body, 'Enrolled a@example.com on devbox')
  const enrol = callsWith(h, 'enrol --from')
  assert.equal(enrol.length, 1)
  assert.equal(enrol[0].where, 'devbox')
  assert.match(enrol[0].line, new RegExp(`enrol --from ${D1} --name a@example\\.com --json$`))
  assert.equal(enrol[0].input, undefined, 'a remote enrol reads the login where it is, nothing is piped')
  assert.equal(h.calls.filter((c) => c.where === 'local').length, 0, 'the Mac runs nothing')
  assert.equal(callsWith(h, 'login-export')[0].where, 'devbox', 'the e-mail is read on the login host')
  assertCleaned(h, { dir: D1, page: 'page-1' })
  assert.equal(closesOf(h, 'page-1')[0].args.includes('--environment'), false)
  // The account is enrolled, so the profile it signed in with is kept as its own and remembered by id.
  assert.equal(deletesOf(h).length, 0, 'the fresh profile is kept')
  assert.deepEqual(h.profiles, [{ id: 'p1', label: LABEL }])
  assert.deepEqual(h.store.browserProfiles, { 'a@example.com': 'p1' })
})

test('a re-authentication passes the e-mail from the status as --email, uses the login profile, and enrols expecting its e-mail and organization', async () => {
  const h = harness()
  h.profiles.push({ id: 'prof-7', label: 'grazr · a@example.com' })
  const login = await openRemoteTab(h, 'a@example.com')
  assert.equal(h.spawns[0].args.at(-1), `CLAUDE_CONFIG_DIR=${D1} setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 ~/.local/bin/claude auth login --email a@example.com'`)
  assert.equal(callsWith(h, 'tab profile create').length, 0, 'the existing profile for the account is reused')
  assert.equal(deletesOf(h).length, 0, 'a re-authentication profile is never deleted')
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--profile'), 'prof-7')
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.match(callsWith(h, 'enrol --from')[0].line, new RegExp(`enrol --from ${D1} --name a@example\\.com --expect-email a@example\\.com --expect-organization oa --json$`))
  assert.equal(callsWith(h, 'login-export').length, 0, 'an account named by the card needs no export read')
  assert.equal(h.published[0].title, 'devbox: signed in')
})

test('a Mac card signs in on the first remote host with an environment, and the export reaches the Mac engine only as its stdin', async () => {
  const h = harness()
  assert.deepEqual(await h.jobs.start({ host: MAC, settings: SETTINGS, account: 'x@example.com' }), { ok: true, message: "Signing in x@example.com in Orca's browser — sign in, then approve Claude Code" })
  await until(() => h.spawns.length === 1)
  assert.equal(h.spawns[0].args.at(-2), 'devbox')
  h.spawns[0].child.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--worktree'), WORKSPACE)
  h.spawns[0].child.exit(0)
  await until(() => h.refreshes === 1)
  const stdin = callsWith(h, 'enrol --stdin')
  assert.equal(stdin.length, 1)
  assert.equal(stdin[0].where, 'local', 'the Mac engine enrols')
  assert.equal(stdin[0].input, EXPORT_LINE)
  assert.match(stdin[0].line, /enrol --stdin --name x@example\.com --expect-email x@example\.com --expect-organization ox --json$/)
  assert.equal(callsWith(h, 'enrol --from').length, 0)
  assert.equal(h.published[0].title, 'mac: signed in')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('the export and the credential reach no argv, log or toast', async () => {
  const h = harness()
  h.jobs.start({ host: MAC, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  h.spawns[0].child.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  h.spawns[0].child.exit(0)
  await until(() => h.refreshes === 1)
  const outside = [h.calls.map((c) => c.line), h.spawns.map((s) => s.args), h.published, h.logs]
  assert.equal(JSON.stringify(outside).includes('sk-secret-blob'), false)
  assert.equal(JSON.stringify(h.spawns.map((s) => s.args)).includes('sk-secret'), false)
})

test('signinHost is the login host for a Mac card when it is a remote host, else the first remote host; the card\'s own host logs in itself', async () => {
  assert.equal(loginHostFor(fixtureSettings({ signinHost: 'devbox-2' }), MAC).name, 'devbox-2')
  assert.equal(loginHostFor(fixtureSettings({ signinHost: 'mac' }), MAC).name, 'devbox', 'a local signinHost is skipped')
  assert.equal(loginHostFor(fixtureSettings({ signinHost: 'missing' }), MAC).name, 'devbox')
  assert.equal(loginHostFor(fixtureSettings({}), DEV), DEV, 'a remote card logs in on its own host')
  assert.equal(loginHostFor(fixtureSettings({ hosts: [{ name: 'mac' }] }), MAC), null)
  const settings = fixtureSettings({ signinHost: 'devbox-2' })
  const h = harness({ settings })
  await h.jobs.start({ host: settings.hosts[0], settings, account: null })
  await until(() => h.spawns.length === 1)
  assert.equal(h.spawns[0].args.at(-2), 'devbox-2')
})

test('no remote host to log in on: the sign-in is refused at once and nothing runs', async () => {
  const settings = fixtureSettings({ hosts: [{ name: 'mac' }] })
  const h = harness({ settings })
  assert.deepEqual(await h.jobs.start({ host: settings.hosts[0], settings, account: null }), { ok: false, message: 'Sign-in needs a remote host to log in on' })
  assert.equal(h.calls.length + h.spawns.length, 0)
  assert.equal(h.jobs.running.size, 0)
})

test('an account name that starts with a dash is refused before anything runs', async () => {
  const h = harness()
  assert.equal((await h.jobs.start({ host: DEV, settings: SETTINGS, account: '--help' })).ok, false)
  assert.equal(h.calls.length + h.spawns.length, 0)
})

test('the Claude binary is the host setting, and the Orca CLI is the orcaBin setting', async () => {
  const settings = fixtureSettings({ orcaBin: '/opt/orca', hosts: [{ name: 'mac' }, { name: 'devbox', ssh: 'devbox', claudeBin: '/opt/bin/claude' }] })
  const h = harness({ settings })
  h.jobs.start({ host: settings.hosts[1], settings, account: null })
  await until(() => h.spawns.length === 1)
  assert.equal(h.spawns[0].args.at(-1), `CLAUDE_CONFIG_DIR=${D1} setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 /opt/bin/claude auth login'`)
  h.spawns[0].child.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  assert.ok(h.calls.filter((c) => c.where === 'orca').length >= 2)
  for (const c of h.calls.filter((x) => x.where === 'orca')) assert.equal(c.bin, '/opt/orca')
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
})

test('the URL that never comes: after 30 s the login is stopped, discarded, no tab opens and the card says so', async () => {
  const h = harness()
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const { child } = h.spawns[0]
  h.clock.fire(URL_TIMEOUT_MS)
  assert.deepEqual(child.signals, ['SIGTERM'])
  child.exit(null, '', 'SIGTERM')
  await until(() => h.published.length === 1)
  assert.equal(h.published[0].title, 'devbox: sign-in failed')
  assert.match(h.published[0].body, /did not print its sign-in address within 30 s/)
  assert.equal(callsWith(h, 'tab create').length, 0)
  assert.equal(callsWith(h, 'enrol').length, 0)
  assertCleaned(h, { dir: D1 })
})

test('a sign-in left unfinished for 10 minutes is stopped, discarded and its tab closed; the card says it timed out', async () => {
  const h = harness()
  const login = await openRemoteTab(h, null)
  h.clock.fire(LOGIN_TIMEOUT_MS)
  assert.deepEqual(login.signals, ['SIGTERM'])
  login.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: sign-in timed out')
  assert.equal(callsWith(h, 'enrol').length, 0)
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('claude exits non-zero: its last line is the toast, clipped; nothing is enrolled; the login and tab are cleaned up', async () => {
  const h = harness()
  const login = await openRemoteTab(h, null)
  login.exit(1, `Login failed: ${'z'.repeat(600)}\n`)
  await until(() => h.refreshes === 1)
  const [first, second] = h.published[0].body.split('\n')
  assert.equal(first.length, LINE_MAX)
  assert.equal(second, 'Nothing was enrolled.')
  assert.equal(callsWith(h, 'enrol').length, 0)
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('a wrong account signed in: the engine reason is the toast, nothing is enrolled, and the login and tab are cleaned up', async () => {
  const h = harness({ overrides: { 'enrol --from': () => ({ code: 1, stdout: '{"ok":false,"error":"signed in as b@example.com, expected x@example.com"}\n' }) } })
  const login = await openRemoteTab(h, 'x@example.com')
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: sign-in failed')
  assert.match(h.published[0].body, /signed in as b@example\.com, expected x@example\.com\nNothing was enrolled\./)
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('Orca cannot open the browser (the profile list fails): the login is stopped, discarded and nothing is enrolled', async () => {
  const h = harness({ overrides: { 'tab profile list': () => ({ code: 1, stdout: json({ ok: false, error: { code: 'paired', message: 'This workspace runs on a paired server' } }) }) } })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const { child } = h.spawns[0]
  h.spawns[0].child.emitUrl()
  await until(() => child.signals.length === 1)
  child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].title, 'devbox: sign-in failed')
  assert.match(h.published[0].body, /could not open the sign-in: This workspace runs on a paired server\nNothing was enrolled\./)
  assert.equal(callsWith(h, 'tab create').length, 0)
  assertCleaned(h, { dir: D1 })
})

test('the browser tab does not open: the login is stopped and discarded and the card says Orca did not return a tab', async () => {
  const h = harness({ overrides: { 'tab create': () => ({ code: 1, stdout: json({ ok: false, error: { message: 'no browser' } }) }) } })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  const { child } = h.spawns[0]
  child.emitUrl()
  await until(() => child.signals.length === 1)
  child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.match(h.published[0].body, /could not open the sign-in: no browser/)
  assertCleaned(h, { dir: D1 })
})

test('a remote card the login host cannot be reached on after a good login says so, and the login is discarded', async () => {
  const h = harness({ overrides: { 'enrol --from': () => ({ code: 255, stderr: 'ssh: Could not resolve hostname devbox\n' }) } })
  const login = await openRemoteTab(h, 'a@example.com')
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].body, 'devbox could not be reached; nothing was enrolled.')
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('a login host that cannot be reached at all starts nothing: no login, no tab, and no discard', async () => {
  const h = harness({ overrides: { 'mktemp -d': () => ({ code: 255, stderr: 'ssh: Could not resolve hostname devbox\n' }) } })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].body, 'devbox could not be reached; nothing was enrolled.')
  assert.equal(h.spawns.length, 0)
  assertCleaned(h, {})
})

test('a directory mktemp prints that is not an absolute path is never used: nothing runs in it, and an empty one is removed', async () => {
  const h = harness({ overrides: { 'mktemp -d': () => ({ stdout: 'tmp.5\n' }) } })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.refreshes === 1)
  assert.equal(h.spawns.length, 0)
  assert.equal(h.published[0].body, 'devbox did not give a usable login directory.\nNothing was enrolled.')
  assert.equal(callsWith(h, 'rmdir -- tmp.5').length, 1, 'the rejected directory is removed only if empty')
  assertCleaned(h, {})
})

test('an absolute directory with characters the shell would split is passed quoted, never run as shell', async () => {
  const dir = '/var/x; rm -rf ~/y'
  const h = harness({ overrides: { 'mktemp -d': () => ({ stdout: `${dir}\n` }) } })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  assert.equal(h.spawns[0].args.at(-1), `CLAUDE_CONFIG_DIR='${dir}' setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 ~/.local/bin/claude auth login'`)
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
})

test('a login that cannot be started: the toast says so, and the login directory is still discarded', async () => {
  const h = harness({ spawnThrows: Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }) })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.refreshes === 1)
  assert.equal(h.published[0].body, 'Could not run ssh: spawn ssh ENOENT\nNothing was enrolled.')
  assertCleaned(h, { dir: D1 })
})

test('a second start on the same card cancels the running sign-in, discards its login, closes its tab, then starts; one login runs at a time', async () => {
  const h = harness()
  const first = await openRemoteTab(h, null)
  h.closeTab() // the sign-in tab is gone: a new start restarts
  const second = await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  assert.deepEqual(second, { ok: true, message: "Signing in a new account in Orca's browser — sign in, then approve Claude Code" })
  assert.deepEqual(first.signals, ['SIGTERM'])
  assert.equal(h.spawns.length, 1, 'the new sign-in waits for the cancelled one to release its login')
  first.exit(null, '', 'SIGTERM')
  await until(() => h.spawns.length === 2)
  assert.equal(h.published[0].title, 'devbox: sign-in cancelled')
  assert.equal(h.published[0].body, 'A newer sign-in on this card replaced it. Nothing was enrolled.')
  assert.equal(discardsOf(h, D1).length, 1)
  assert.equal(closesOf(h, 'page-1').length, 1)
  assert.equal(h.jobs.running.has('devbox'), true, 'the card stays held for the new sign-in')
  assert.equal(h.spawns[1].args.at(-1), `CLAUDE_CONFIG_DIR=${D2} setsid sh -c 'echo grazr-pid:$$; exec timeout -k 5 1830 ~/.local/bin/claude auth login'`)
  h.spawns[1].child.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 2)
  h.spawns[1].child.exit(0)
  await until(() => h.published.length === 2 && h.refreshes === 2)
  assert.equal(h.published[1].title, 'devbox: signed in')
  assert.equal(h.jobs.running.has('devbox'), false)
  assert.equal(h.calls.filter((c) => c.line.includes('login-discard')).length, 2)
  assert.equal(discardsOf(h, D2).length, 1)
  assert.equal(closesOf(h, 'page-2').length, 1)
  assert.equal(h.jobs.running.size, 0)
})

test('a sign-in that is already enrolling is not cancelled by a newer start; the newer one waits for it', async () => {
  let open
  const gate = new Promise((resolve) => { open = resolve })
  const h = harness({ overrides: { 'enrol --from': async () => { await gate; return { stdout: OK_ENROL } } } })
  const first = await openRemoteTab(h, null)
  first.exit(0)
  await until(() => callsWith(h, 'enrol --from').length === 1)
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  assert.deepEqual(first.signals, [], 'the enrolment is left to finish')
  open()
  await until(() => h.spawns.length === 2)
  assert.equal(h.published[0].title, 'devbox: signed in')
})

test('a Mac card and a remote card run at once without waiting for each other', async () => {
  const h = harness()
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  h.jobs.start({ host: MAC, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 2)
  assert.equal(h.jobs.running.size, 2)
})

test('clip cuts a line to LINE_MAX characters with an ellipsis and leaves short text alone', () => {
  assert.equal(clip('short'), 'short')
  assert.equal(clip('x'.repeat(LINE_MAX)).length, LINE_MAX)
  const cut = clip('y'.repeat(900))
  assert.equal(cut.length, LINE_MAX)
  assert.ok(cut.endsWith('…'))
  assert.equal(clip(undefined), '')
})

// --- e-mail and account name kept apart, and another organization of a login ---

// a@example.com with a second organization enrolled under a name of its own.
const TWO_ORGS = [...ENROLLED, { id: 'ua.ob', name: 'a@example.com:beta', email: 'a@example.com', login: 'ua', organization_uuid: 'ob', organization: 'Beta' }]
const enrolReply = (name, organization) => ({ stdout: `${JSON.stringify({ ok: true, name, email: 'a@example.com', organization, unblocked: true, ordered: true })}\n` })

test('a re-authentication of a further organization logs in with the e-mail of its login and enrols under its own name, expecting its organization', async () => {
  const h = harness({ overrides: { 'status --json': () => statusReply(TWO_ORGS), 'enrol --from': () => enrolReply('a@example.com:beta', 'Beta') } })
  h.profiles.push({ id: 'prof-a', label: 'grazr · a@example.com' })
  const started = await h.jobs.start({ host: DEV, settings: SETTINGS, account: 'a@example.com:beta' })
  assert.deepEqual(started, { ok: true, message: "Signing in a@example.com:beta in Orca's browser — sign in, then approve Claude Code" })
  await until(() => h.spawns.length === 1)
  assert.match(h.spawns[0].args.at(-1), /claude auth login --email a@example\.com'$/, 'the login is the e-mail, never the name')
  h.spawns[0].child.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--profile'), 'prof-a', "the login's profile")
  h.spawns[0].child.exit(0)
  await until(() => h.refreshes === 1)
  assert.match(callsWith(h, 'enrol --from')[0].line, new RegExp(`enrol --from ${D1} --name a@example\\.com:beta --expect-email a@example\\.com --expect-organization ob --json$`))
  assert.equal(h.published[0].body, 'Enrolled a@example.com:beta (Beta) on devbox\nAdded to the end of the rotation order.')
})

test('a re-authentication reads the account from a fresh status: an unknown name, or a status that fails, starts nothing', async () => {
  const unknown = harness()
  assert.deepEqual(await unknown.jobs.start({ host: DEV, settings: SETTINGS, account: 'gone@example.com' }), { ok: false, message: 'gone@example.com is not enrolled on devbox; refresh the panel' })
  assert.equal(unknown.spawns.length + callsWith(unknown, 'mktemp').length, 0)
  const down = harness({ overrides: { 'status --json': () => ({ code: 255, stderr: 'ssh: connect to host devbox port 22: Connection refused\n' }) } })
  const refused = await down.jobs.start({ host: DEV, settings: SETTINGS, account: 'a@example.com' })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /^The accounts on devbox could not be read: /)
  assert.equal(down.spawns.length, 0)
})

test('on an engine before fork.16 a re-authentication expects the e-mail alone, and another organization is refused before anything runs', async () => {
  const old = ENROLLED.map(({ login, organization_uuid, ...rest }) => rest)
  const h = harness({ overrides: { 'status --json': () => statusReply(old, '0.4.7+fork.15') } })
  const login = await openRemoteTab(h, 'a@example.com')
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.match(callsWith(h, 'enrol --from')[0].line, /--name a@example\.com --expect-email a@example\.com --json$/)
  const spawned = h.spawns.length
  assert.deepEqual(await h.jobs.start({ host: DEV, settings: SETTINGS, email: 'a@example.com', organization: true }), { ok: false, message: 'Another organization needs engine 0.4.7+fork.16 or later: update the engine on devbox first' })
  assert.equal(h.spawns.length, spawned)
})

test('another organization needs an enrolled account of that e-mail on the card host', async () => {
  const h = harness()
  assert.deepEqual(await h.jobs.start({ host: DEV, settings: SETTINGS, email: 'nobody@example.com', organization: true }), { ok: false, message: 'No account of nobody@example.com is enrolled on devbox; refresh the panel' })
  assert.equal(h.spawns.length, 0)
})

test('another organization: the export names the organization before the name is chosen, and it is enrolled as <email>:<slug> in the login profile', async () => {
  const h = harness({ overrides: { 'login-export': () => exportOf({ organization: 'oc', organizationName: 'Gamma & Co' }), 'enrol --from': () => enrolReply('a@example.com:gamma-co', 'Gamma & Co') } })
  h.profiles.push({ id: 'prof-a', label: 'grazr · a@example.com' })
  const login = await openOrganizationTab(h)
  assert.match(h.spawns[0].args.at(-1), /claude auth login --email a@example\.com'$/)
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--profile'), 'prof-a')
  login.exit(0)
  await until(() => h.refreshes === 1)
  const order = h.calls.map((c) => c.line).filter((l) => /login-export|status --json|enrol --from/.test(l)).map((l) => l.match(/login-export|status --json|enrol --from/)[0])
  assert.deepEqual(order, ['status --json', 'login-export', 'status --json', 'enrol --from'], 'export, then a fresh status, then the enrolment')
  assert.match(callsWith(h, 'enrol --from')[0].line, new RegExp(`enrol --from ${D1} --name a@example\\.com:gamma-co --expect-email a@example\\.com --expect-organization oc --json$`))
  assert.equal(h.published[0].body, 'Enrolled a@example.com:gamma-co (Gamma & Co) on devbox\nAdded to the end of the rotation order.')
  assert.deepEqual(h.store.browserProfiles, { 'a@example.com': 'prof-a', 'a@example.com:gamma-co': 'prof-a' }, "the new account shares the login's profile")
  assert.equal(deletesOf(h).length, 0)
  assertCleaned(h, { dir: D1, page: 'page-1' })
})

test('another organization that is enrolled already is not enrolled twice: the sign-in says so and is cleaned up', async () => {
  const h = harness({ overrides: { 'status --json': () => statusReply(TWO_ORGS), 'login-export': () => exportOf({ organization: 'OB', organizationName: 'Beta' }) } })
  const login = await openOrganizationTab(h)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(callsWith(h, 'enrol').length, 0, 'nothing is enrolled')
  assert.deepEqual(h.published.map((t) => [t.title, t.body]), [['devbox: sign-in failed', 'that organization is already enrolled — choose the other one on claude.ai (a@example.com:beta)\nNothing was enrolled.']])
  assertCleaned(h, { dir: D1, page: 'page-1' })
  assert.equal(deletesOf(h).length, 0, "the login's own profile is kept")
})

test('another organization whose slug is taken gets the next free suffix', async () => {
  const taken = [...ENROLLED, { id: 'ux2', name: 'a@example.com:beta', email: 'other@example.com', login: 'uo', organization_uuid: 'oo' }]
  const h = harness({ overrides: { 'status --json': () => statusReply(taken), 'login-export': () => exportOf({ organization: 'ob', organizationName: 'Beta' }) } })
  const login = await openOrganizationTab(h)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.match(callsWith(h, 'enrol --from')[0].line, /--name a@example\.com:beta-2 --expect-email a@example\.com --expect-organization ob --json$/)
})

test('another organization signed in under another e-mail is refused, and nothing is enrolled', async () => {
  const h = harness({ overrides: { 'login-export': () => exportOf({ email: 'x@example.com', login: 'ux', organization: 'oz', organizationName: 'Z' }) } })
  const login = await openOrganizationTab(h)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(callsWith(h, 'enrol').length, 0)
  assert.equal(h.published[0].body, 'signed in as x@example.com, expected a@example.com\nNothing was enrolled.')
})

test('on a Mac card another organization is read from the export on the login host and piped to the Mac engine', async () => {
  const h = harness({ overrides: { 'login-export': () => exportOf({ organization: 'oc', organizationName: 'Gamma' }) } })
  const login = await openOrganizationTab(h, 'A@EXAMPLE.com', MAC)
  login.exit(0)
  await until(() => h.refreshes === 1)
  const stdin = callsWith(h, 'enrol --stdin')
  assert.equal(stdin[0].where, 'local')
  assert.match(stdin[0].line, /enrol --stdin --name a@example\.com:gamma --expect-email a@example\.com --expect-organization oc --json$/)
  assert.equal(stdin[0].input, exportOf({ organization: 'oc', organizationName: 'Gamma' }).stdout)
  assert.equal(callsWith(h, 'status --json').every((c) => c.where === 'local'), true, "the Mac card's accounts are the Mac's")
})

test('Add account for a login whose other organization is enrolled names the new one <email>:<slug> instead of failing on the e-mail', async () => {
  const h = harness({ overrides: { 'login-export': () => exportOf({ organization: 'ob', organizationName: 'Beta' }) } })
  const login = await openRemoteTab(h, null)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.match(callsWith(h, 'enrol --from')[0].line, new RegExp(`enrol --from ${D1} --name a@example\\.com:beta --json$`))
})

test('Add account for a login and organization enrolled already renews it under its own name', async () => {
  const h = harness({ overrides: { 'status --json': () => statusReply(TWO_ORGS), 'login-export': () => exportOf({ organization: 'ob', organizationName: 'Beta' }) } })
  const login = await openRemoteTab(h, null)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.match(callsWith(h, 'enrol --from')[0].line, /--name a@example\.com:beta --json$/)
})

test('withOrganization appends orgUUID to the authorize address and keeps the rest as Claude printed it', async () => {
  const { withOrganization } = await import('../lib/signin.mjs')
  const uuid = '22222222-2222-4222-8222-222222222222'
  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=c&scope=org%3Acreate_api_key+user%3Aprofile&state=s%2Bt'
  assert.equal(withOrganization(url, uuid), `${url}&orgUUID=${uuid}`)
  assert.equal(withOrganization(`${url}#x`, uuid), `${url}&orgUUID=${uuid}#x`)
  assert.equal(withOrganization('https://claude.ai/oauth/authorize', uuid), `https://claude.ai/oauth/authorize?orgUUID=${uuid}`)
  assert.equal(withOrganization(`${url}&orgUUID=${uuid}`, '33333333-3333-4333-8333-333333333333'), `${url}&orgUUID=${uuid}`, 'one already there stays')
  assert.equal(withOrganization(url, 'not-a-uuid&state=x'), url)
  assert.equal(new globalThis.URL(withOrganization(url, uuid)).searchParams.get('state'), 's+t')
})

const TARGET = { uuid: '22222222-2222-4222-8222-222222222222', name: 'Acme' }

async function openTargetedTab(h) {
  const started = await h.jobs.start({ host: DEV, settings: SETTINGS, email: 'a@example.com', organization: true, target: TARGET })
  assert.equal(started.ok, true, started.message)
  assert.equal(started.message, "Signing in Acme of a@example.com in Orca's browser — sign in, check the organization is Acme, then approve Claude Code")
  await until(() => h.spawns.length === 1)
  const login = h.spawns[0].child
  login.emitPid()
  login.emitUrl()
  await until(() => callsWith(h, 'tab create').length === 1)
  return login
}

test('a sign-in targeted at an organization asks claude.ai for it with orgUUID and enrols expecting it', async () => {
  const h = harness({ overrides: { 'login-export': () => exportOf({ organization: TARGET.uuid, organizationName: 'Acme' }), 'enrol --from': () => enrolReply('a@example.com:acme', 'Acme') } })
  const login = await openTargetedTab(h)
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--url'), `${URL}&orgUUID=${TARGET.uuid}`)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.match(callsWith(h, 'enrol --from')[0].line, new RegExp(`--name a@example\\.com:acme --expect-email a@example\\.com --expect-organization ${TARGET.uuid} --json$`))
})

test('a sign-in targeted at an organization that came back with another one is refused, and says which to pick', async () => {
  const h = harness({ overrides: { 'login-export': () => exportOf({ organization: 'oc', organizationName: 'Gamma' }) } })
  const login = await openTargetedTab(h)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(callsWith(h, 'enrol').length, 0)
  assert.equal(h.published[0].body, 'claude.ai signed in to Gamma, not Acme — pick Acme on the authorize page\nNothing was enrolled.')
})
