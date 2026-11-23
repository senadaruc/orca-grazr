import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileLabel } from '../lib/signin.mjs'
import { DEV, ENROLLED, SETTINGS, STAMP, argAfter, callsWith, deletesOf, exportOf, harness, json, openOrganizationTab, openRemoteTab, statusReply, until, LABEL } from './support/signin-harness.mjs'

test('each add-account sign-in gets a fresh profile, a label taken in the same minute gets a suffix, and a profile whose account was enrolled is kept for it', async () => {
  const h = harness()
  h.profiles.push({ id: 'seed', label: LABEL })
  const one = await openRemoteTab(h, null)
  one.exit(0)
  await until(() => h.refreshes === 1)
  const two = await openRemoteTab(h, null)
  two.exit(0)
  await until(() => h.refreshes === 2)
  const labels = callsWith(h, 'tab profile create').map((c) => argAfter(c, '--label'))
  assert.deepEqual(labels, [LABEL, LABEL], 'the seeded profile is never the one listed after the create, so the new one is used')
  assert.equal(deletesOf(h).length, 0, 'an enrolled account keeps its profile')
  assert.deepEqual(h.profiles, [{ id: 'seed', label: LABEL }, { id: 'p1', label: LABEL }, { id: 'p2', label: LABEL }])
  // Both sign-ins enrolled the same e-mail, so its profile is the later one.
  assert.deepEqual(h.store.browserProfiles, { 'a@example.com': 'p2' })
  assert.ok(h.logs.some((m) => m === 'grazr sign-in: the browser profile is kept for a@example.com'))
  assert.equal(h.published.every((t) => t.title === 'devbox: signed in'), true)
})

test('two add-account sign-ins in the same minute, with nothing taken, each get a fresh profile with the plain label', async () => {
  const h = harness()
  const one = await openRemoteTab(h, null)
  one.exit(0)
  await until(() => h.refreshes === 1)
  const two = await openRemoteTab(h, null)
  two.exit(0)
  await until(() => h.refreshes === 2)
  assert.deepEqual(callsWith(h, 'tab profile create').map((c) => argAfter(c, '--label')), [LABEL, LABEL])
  assert.deepEqual(h.profiles.map((p) => p.id), ['p1', 'p2'])
})

test('a fresh profile is deleted when the enrolment is refused, and nothing is remembered', async () => {
  const h = harness({ overrides: { 'enrol --from': () => ({ code: 1, stdout: '{"ok":false,"error":"the e-mail is not the one expected"}\n' }) } })
  const login = await openRemoteTab(h, null)
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.deepEqual(deletesOf(h).map((c) => argAfter(c, '--profile')), ['p1'])
  assert.deepEqual(h.profiles, [])
  assert.equal(h.store.browserProfiles, undefined)
  assert.equal(h.published[0].title, 'devbox: sign-in failed')
})

test('a fresh profile is deleted when the sign-in fails after it was made', async () => {
  const h = harness({ overrides: { 'tab create': () => ({ code: 1, stdout: json({ ok: false, error: { message: 'no browser' } }) }) } })
  h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  await until(() => h.spawns.length === 1)
  h.spawns[0].child.emitUrl()
  await until(() => h.spawns[0].child.signals.length === 1)
  h.spawns[0].child.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.equal(deletesOf(h).length, 1)
  assert.equal(argAfter(deletesOf(h)[0], '--profile'), 'p1')
  assert.deepEqual(h.profiles, [])
})

test('a fresh profile is deleted when the sign-in is cancelled, and a failed delete is logged, not thrown', async () => {
  const h = harness({ overrides: { 'tab profile delete': () => ({ code: 1, stdout: json({ ok: false, error: { message: 'profile busy' } }) }) } })
  const first = await openRemoteTab(h, null)
  h.closeTab() // the sign-in tab is gone: a new start restarts
  await h.jobs.start({ host: DEV, settings: SETTINGS, account: null })
  first.exit(null, '', 'SIGTERM')
  await until(() => h.published.length === 1 && h.refreshes === 1)
  assert.equal(deletesOf(h).length, 1)
  assert.ok(h.logs.some((m) => m.includes('fresh browser profile was not deleted: profile busy')))
  assert.equal(h.published[0].title, 'devbox: sign-in cancelled')
})

test('profile reuse: an account with a profile uses it; a missing one is created isolated, then listed again and used', async () => {
  const reuse = harness()
  reuse.profiles.push({ id: 'prof-7', label: profileLabel('a@example.com') })
  const first = await openRemoteTab(reuse, 'a@example.com')
  assert.equal(callsWith(reuse, 'tab profile create').length, 0)
  first.exit(null, '', 'SIGTERM')
  await until(() => reuse.refreshes === 1)

  const create = harness()
  const second = await openRemoteTab(create, null)
  const made = callsWith(create, 'tab profile create')
  assert.equal(made.length, 1)
  assert.equal(argAfter(made[0], '--scope'), 'isolated')
  assert.equal(argAfter(callsWith(create, 'tab create')[0], '--profile'), 'p1', 'the profile is the one listed after creation')
  second.exit(null, '', 'SIGTERM')
  await until(() => create.refreshes === 1)
  assert.equal(profileLabel(null), 'grazr · new account')
  assert.equal(profileLabel('a@example.com'), 'grazr · a@example.com')
})

test('a re-authentication with no profile yet creates one labelled by the account, reuses it, and never deletes it', async () => {
  const h = harness()
  const login = await openRemoteTab(h, 'a@example.com')
  assert.equal(argAfter(callsWith(h, 'tab profile create')[0], '--label'), 'grazr · a@example.com')
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.equal(deletesOf(h).length, 0)
  assert.deepEqual(h.profiles, [{ id: 'p1', label: 'grazr · a@example.com' }], 'the account profile stays')
  const again = await openRemoteTab(h, 'a@example.com')
  assert.equal(callsWith(h, 'tab profile create').length, 1, 'the second sign-in reuses it')
  assert.equal(argAfter(callsWith(h, 'tab create').at(-1), '--profile'), 'p1')
  again.exit(0)
  await until(() => h.refreshes === 2)
})

test("another organization signs in in its login's profile, found by the e-mail, and the new name is remembered for that profile", async () => {
  const h = harness({ overrides: { 'login-export': () => exportOf({ organization: 'ob', organizationName: 'Beta' }) } })
  h.profiles.push({ id: 'prof-a', label: 'something else' })
  h.store.browserProfiles = { 'a@example.com': 'prof-a' }
  const login = await openOrganizationTab(h)
  assert.equal(callsWith(h, 'tab profile create').length, 0, 'no profile of its own')
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--profile'), 'prof-a')
  login.exit(0)
  await until(() => h.refreshes === 1)
  assert.deepEqual(h.store.browserProfiles, { 'a@example.com': 'prof-a', 'a@example.com:beta': 'prof-a' })
  assert.equal(deletesOf(h).length, 0)
})

test('a re-authentication of a further organization reuses the profile labelled by its login, not one by its name', async () => {
  const beta = { id: 'ua.ob', name: 'a@example.com:beta', email: 'a@example.com', login: 'ua', organization_uuid: 'ob' }
  const h = harness({ overrides: { 'status --json': () => statusReply([...ENROLLED, beta]) } })
  h.profiles.push({ id: 'prof-a', label: 'grazr · a@example.com' })
  const login = await openRemoteTab(h, 'a@example.com:beta')
  assert.equal(callsWith(h, 'tab profile create').length, 0)
  assert.equal(argAfter(callsWith(h, 'tab create')[0], '--profile'), 'prof-a')
  login.exit(null, '', 'SIGTERM')
  await until(() => h.refreshes === 1)
  assert.deepEqual(h.store.browserProfiles, { 'a@example.com': 'prof-a', 'a@example.com:beta': 'prof-a' })
})
