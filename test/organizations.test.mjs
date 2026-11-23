import { test } from 'node:test'
import assert from 'node:assert/strict'
import { organizationOf, discoveredOrganizations, organizationFor, nextOrganizations, FREE_REASON, API_REASON } from '../lib/organizations.mjs'
import { organizationsExpression, parseOrganizationsAnswer, selectOrganizationExpression } from '../lib/organizations-request.mjs'
import { ORG, freeOrg, teamOrg, apiOrg, proOrg, maxOrg, teamCedar } from './support/claude-data-fixture.mjs'

const PAT = 'pat@example.com'

test('the three shapes claude.ai lists, and the assumed Pro and Max ones, read as their kind, plan and label', () => {
  const read = (raw) => {
    const o = organizationOf(raw, PAT)
    return [o.label, o.plan, o.kind, o.claudeCode, o.reason]
  }
  assert.deepEqual(read(freeOrg(PAT)), ['Personal', 'Free', 'free', false, FREE_REASON])
  assert.deepEqual(read(teamOrg()), ['Acme', 'Team', 'subscription', true, null])
  assert.deepEqual(read(apiOrg()), ['Acme API', 'API', 'api', false, API_REASON])
  assert.deepEqual(read(proOrg(PAT)), ['Personal', 'Pro', 'subscription', true, null])
  assert.deepEqual(read(maxOrg(PAT)), ['Personal', 'Max 20x', 'subscription', true, null], "claude.ai's own plan name wins")
  assert.deepEqual(read({ ...maxOrg(PAT), plan_display_name: undefined }), ['Personal', 'Ultra', 'subscription', true, null])
  assert.deepEqual(read({ uuid: ORG.pro, name: 'Other', capabilities: ['chat'], billing_type: 'invoice' }), ['Other', null, 'subscription', true, null], 'an unknown paid shape that can chat is a subscription')
  assert.equal(organizationOf({ name: 'no uuid' }), null)
})

test("another login's default organization name is not this login's personal one", () => {
  assert.equal(organizationOf({ ...teamOrg(), name: "sam@example.com's Organization" }, PAT).label, "sam@example.com's Organization")
})

test("an account is of the organization with its uuid; without one, of its login's only subscription organization", () => {
  const orgs = [freeOrg(PAT), teamOrg(), apiOrg()].map((raw) => organizationOf(raw, PAT))
  assert.equal(organizationFor(ORG.team, orgs).uuid, ORG.team)
  assert.equal(organizationFor(ORG.pro, orgs), null)
  assert.equal(organizationFor(null, orgs).uuid, ORG.team)
  assert.equal(organizationFor(null, [...orgs, organizationOf(proOrg(PAT), PAT)]), null, 'two subscriptions cannot be told apart')
})

test('a failed or signed-out read keeps the list it had', () => {
  const kept = { readAt: 1, state: 'ok', orgs: [{ uuid: ORG.team }] }
  assert.deepEqual(nextOrganizations(kept, { state: 'ok', orgs: [] }, 9), { readAt: 9, state: 'ok', orgs: [] })
  assert.deepEqual(nextOrganizations(kept, { state: 'failed' }, 9), { readAt: 1, triedAt: 9, state: 'failed', orgs: kept.orgs })
  assert.deepEqual(nextOrganizations(kept, { state: 'signed-out' }, 9), { readAt: 9, state: 'signed-out', orgs: kept.orgs })
  assert.deepEqual(nextOrganizations(undefined, { state: 'failed' }, 9), { readAt: 9, triedAt: 9, state: 'failed', orgs: [] })
})

const stored = () => ({ [PAT]: { readAt: 1, state: 'ok', orgs: [freeOrg(PAT), teamOrg(), apiOrg(), proOrg(PAT)].map((raw) => organizationOf(raw, PAT)) } })

test("each organization of a host's login not enrolled there becomes a placeholder of its kind, in the login's group", () => {
  const report = { accounts: [{ name: PAT, email: 'Pat@example.com', login: 'u-pat', organization_uuid: ORG.pro }] }
  assert.deepEqual(discoveredOrganizations(report, stored()), [
    { name: 'Pat@example.com · Personal', email: 'Pat@example.com', login: 'u-pat', organizationUuid: ORG.free, orgLabel: 'Personal · Free', claudeCode: false, reason: FREE_REASON },
    { name: 'Pat@example.com · Acme', email: 'Pat@example.com', login: 'u-pat', organizationUuid: ORG.team, orgLabel: 'Acme · Team', claudeCode: true, reason: null },
    { name: 'Pat@example.com · Acme API', email: 'Pat@example.com', login: 'u-pat', organizationUuid: ORG.api, orgLabel: 'Acme API · API', claudeCode: false, reason: API_REASON },
  ])
})

test('a login with nothing more found, a login not stored and an engine without organization uuids get no placeholders', () => {
  const only = { [PAT]: { readAt: 1, state: 'ok', orgs: [organizationOf(proOrg(PAT), PAT)] } }
  assert.deepEqual(discoveredOrganizations({ accounts: [{ name: PAT, email: PAT, organization_uuid: ORG.pro }] }, only), [])
  assert.deepEqual(discoveredOrganizations({ accounts: [{ name: 'sam', email: 'sam@example.com', organization_uuid: ORG.pro }] }, stored()), [])
  assert.deepEqual(discoveredOrganizations({ accounts: [{ name: PAT, email: PAT }] }, stored()), [])
})

// claude.ai's origin as the page script sees it: XMLHttpRequest answers from a table, the cookie names the selection.
function inPage({ routes, cookie = '', href = 'https://claude.ai/new' }, expression) {
  const requested = []
  class XMLHttpRequest {
    open(method, path, async) {
      this.method = method
      this.path = path
      this.async = async
    }
    setRequestHeader() {}
    send() {
      requested.push({ method: this.method, path: this.path, async: this.async })
      const route = routes[this.path] ?? { status: 404, body: {} }
      this.status = route.status
      this.responseText = JSON.stringify(route.body)
      this.responseURL = route.url ?? `https://claude.ai${this.path}`
    }
  }
  const saved = { XMLHttpRequest: globalThis.XMLHttpRequest, document: globalThis.document, location: globalThis.location }
  Object.assign(globalThis, { XMLHttpRequest, document: { cookie }, location: { href } })
  try {
    return { value: (0, eval)(expression), requested }
  } finally {
    Object.assign(globalThis, saved)
  }
}

test('the page asks claude.ai with GETs only, for the usage of the organizations that can chat, and keeps only the listed fields', () => {
  const list = [{ ...freeOrg(PAT), settings: { secret: 'x' } }, teamOrg(), apiOrg()]
  const usage = (uuid) => `/api/organizations/${uuid}/usage?cedar_ember=1`
  const { value, requested } = inPage({
    routes: {
      '/api/organizations': { status: 200, body: list },
      [usage(ORG.free)]: { status: 200, body: { cedar_ember: null, five_hour: { utilization: 1 } } },
      [usage(ORG.team)]: { status: 200, body: { cedar_ember: teamCedar(), limits: [] } },
    },
    cookie: `other=1; lastActiveOrg=${ORG.team}`,
  }, organizationsExpression())
  assert.deepEqual(requested.map((r) => [r.method, r.path, r.async]), [
    ['GET', '/api/organizations', false], ['GET', usage(ORG.free), false], ['GET', usage(ORG.team), false],
  ])
  const parsed = parseOrganizationsAnswer(value)
  assert.equal(parsed.state, 'ok')
  assert.equal(parsed.selectedOrg, ORG.team)
  assert.deepEqual(Object.keys(parsed.organizations[0]).sort(), ['billing_type', 'capabilities', 'name', 'rate_limit_tier', 'raven_type', 'uuid'])
  assert.deepEqual(parsed.usage[ORG.free], { status: 200, cedar_ember: null })
  assert.equal(parsed.usage[ORG.team].cedar_ember.grants.length, 3)
})

test('the page asks only for the organizations named when told to', () => {
  const { requested } = inPage({ routes: { '/api/organizations': { status: 200, body: [freeOrg(PAT), teamOrg()] } } }, organizationsExpression([ORG.team]))
  assert.deepEqual(requested.map((r) => r.path), ['/api/organizations', `/api/organizations/${ORG.team}/usage?cedar_ember=1`])
})

test('a 401 or 403, a login page or a login redirect is signed out; anything else unreadable is a failure', () => {
  const answerTo = (route, href) => parseOrganizationsAnswer(inPage({ routes: { '/api/organizations': route }, href }, organizationsExpression()).value)
  assert.deepEqual(answerTo({ status: 401, body: {} }), { state: 'signed-out' })
  assert.deepEqual(answerTo({ status: 403, body: { type: 'error' } }), { state: 'signed-out' })
  assert.deepEqual(answerTo({ status: 200, body: '<html>', url: 'https://claude.ai/login?returnTo=%2F' }), { state: 'signed-out' })
  assert.deepEqual(answerTo({ status: 200, body: [] }, 'https://claude.ai/login'), { state: 'signed-out' })
  assert.equal(answerTo({ status: 500, body: {} }).state, 'failed')
  assert.equal(answerTo({ status: 200, body: { not: 'a list' } }).state, 'failed')
  assert.equal(parseOrganizationsAnswer('not json').state, 'failed')
  assert.equal(parseOrganizationsAnswer(JSON.stringify({ signedIn: true })).state, 'failed')
})

test("selecting an organization sets lastActiveOrg in the scope claude.ai's own cookie has, and null removes it", async () => {
  const jar = new Map([['lastActiveOrg', { name: 'lastActiveOrg', value: ORG.free, domain: 'claude.ai', path: '/', sameSite: 'lax', expires: 1_900_000_000_000 }]])
  const sets = []
  const cookieStore = {
    get: async (name) => jar.get(name) ?? null,
    set: async (options) => { sets.push(options); jar.set(options.name, options) },
    delete: async (options) => { sets.push({ deleted: options }); jar.delete(options.name) },
  }
  const document = { get cookie() { return [...jar.values()].map((c) => `${c.name}=${c.value}`).join('; ') } }
  const saved = { cookieStore: globalThis.cookieStore, document: globalThis.document }
  Object.assign(globalThis, { cookieStore, document })
  try {
    assert.deepEqual(JSON.parse(await (0, eval)(selectOrganizationExpression(ORG.team))), { selected: ORG.team })
    assert.deepEqual(sets[0], { name: 'lastActiveOrg', path: '/', domain: 'claude.ai', value: ORG.team, sameSite: 'lax', expires: 1_900_000_000_000 })
    assert.deepEqual(JSON.parse(await (0, eval)(selectOrganizationExpression(null))), { selected: null })
    assert.deepEqual(sets[1], { deleted: { name: 'lastActiveOrg', path: '/', domain: 'claude.ai' } })
  } finally {
    Object.assign(globalThis, saved)
  }
})
