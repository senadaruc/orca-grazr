// What a claude.ai page of a login's browser profile is asked for, with GET requests on its own origin: the
// organizations of the login, the one selected there (the lastActiveOrg cookie), and the limit-reset grants
// (cedar_ember) of each organization that can chat. Nothing is posted or clicked; only a reset that needs another
// organization shown selects it (selectOrganizationPageScript), and puts the selection back after.

// The fields kept of each organization; the rest of claude.ai's reply never leaves the page.
const ORGANIZATION_FIELDS = ['uuid', 'name', 'capabilities', 'rate_limit_tier', 'billing_type', 'raven_type', 'plan_display_name', 'plan_display_label']

// Runs in the page, so it carries everything it needs. only, when given, is the organization uuids whose usage is asked
// for; otherwise every organization that can chat. Returns JSON: { signedIn: false } for a signed-out profile,
// { signedIn: null, status, error } when the list could not be read, else { signedIn: true, selectedOrg, organizations,
// usage: { [uuid]: { status, cedar_ember } } }.
export function organizationsPageScript(fields, only) {
  const get = (path) => {
    const request = new XMLHttpRequest()
    try {
      request.open('GET', path, false)
      request.setRequestHeader('Accept', 'application/json')
      request.send()
    } catch (err) {
      return { status: 0, body: null, url: null, error: String(err && err.message ? err.message : err) }
    }
    let body = null
    try {
      body = JSON.parse(request.responseText)
    } catch {}
    return { status: request.status, body, url: request.responseURL || null }
  }
  const onLogin = (url) => {
    try {
      return new URL(url, location.href).pathname.startsWith('/login')
    } catch {
      return false
    }
  }
  const cookie = (name) => {
    const found = String(document.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
    return found ? decodeURIComponent(found.slice(name.length + 1)) : null
  }
  if (onLogin(location.href)) return JSON.stringify({ signedIn: false })
  const list = get('/api/organizations')
  if (list.status === 401 || list.status === 403 || onLogin(list.url)) return JSON.stringify({ signedIn: false, status: list.status })
  if (list.status !== 200 || !Array.isArray(list.body)) {
    return JSON.stringify({ signedIn: null, status: list.status, error: list.error ?? (list.status === 200 ? 'not a list' : `HTTP ${list.status}`) })
  }
  const organizations = list.body.filter((org) => org && typeof org === 'object' && typeof org.uuid === 'string')
    .map((org) => Object.fromEntries(fields.filter((key) => key in org).map((key) => [key, org[key]])))
  const usage = {}
  for (const org of organizations) {
    const asked = Array.isArray(only) ? only.includes(org.uuid) : Array.isArray(org.capabilities) && org.capabilities.includes('chat')
    if (!asked) continue
    const reply = get(`/api/organizations/${encodeURIComponent(org.uuid)}/usage?cedar_ember=1`)
    const body = reply.body && typeof reply.body === 'object' ? reply.body : null
    usage[org.uuid] = { status: reply.status, cedar_ember: body && 'cedar_ember' in body ? body.cedar_ember : undefined }
  }
  return JSON.stringify({ signedIn: true, selectedOrg: cookie('lastActiveOrg'), organizations, usage })
}

// The expression for `orca eval`; only limits the usage asked for to those organizations.
export const organizationsExpression = (only = null) => `(${organizationsPageScript})(${JSON.stringify(ORGANIZATION_FIELDS)}, ${JSON.stringify(only)})`

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The page's answer, checked: { state: 'signed-out' } or { state: 'ok', selectedOrg, organizations, usage } or
// { state: 'failed', message }.
export function parseOrganizationsAnswer(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { state: 'failed', message: 'the page gave no readable answer' }
  }
  if (!isObject(value)) return { state: 'failed', message: 'the page gave no readable answer' }
  if (value.signedIn === false) return { state: 'signed-out' }
  if (value.signedIn !== true) return { state: 'failed', message: `claude.ai did not list the organizations (${typeof value.error === 'string' ? value.error : 'no reason'})` }
  if (!Array.isArray(value.organizations) || !isObject(value.usage)) return { state: 'failed', message: 'the organizations came back without their fields' }
  return {
    state: 'ok',
    selectedOrg: typeof value.selectedOrg === 'string' && value.selectedOrg !== '' ? value.selectedOrg : null,
    organizations: value.organizations.filter(isObject),
    usage: value.usage,
  }
}

// Runs in the page: makes uuid the organization selected on claude.ai, as its account menu does, by setting the
// lastActiveOrg cookie with the scope the cookie already has (claude.ai's own: its domain, path, SameSite and expiry);
// null removes it. Where the page has no cookieStore, document.cookie sets it for claude.ai, path /, for a year. The
// page must be reloaded to show the organization. Returns JSON { selected }, the cookie's value read back.
export async function selectOrganizationPageScript(uuid) {
  const YEAR_MS = 365 * 24 * 3600 * 1000
  const read = () => {
    const found = String(document.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('lastActiveOrg='))
    return found ? decodeURIComponent(found.slice('lastActiveOrg='.length)) : null
  }
  if (typeof cookieStore !== 'undefined' && cookieStore && typeof cookieStore.set === 'function') {
    const current = await cookieStore.get('lastActiveOrg')
    const scope = { name: 'lastActiveOrg', path: current?.path ?? '/', ...(current?.domain ? { domain: current.domain } : {}) }
    if (uuid === null) await cookieStore.delete(scope)
    else await cookieStore.set({ ...scope, value: uuid, sameSite: current?.sameSite ?? 'lax', expires: current?.expires ?? Date.now() + YEAR_MS })
  } else if (uuid === null) {
    document.cookie = 'lastActiveOrg=; domain=claude.ai; path=/; max-age=0; secure; samesite=lax'
  } else {
    document.cookie = `lastActiveOrg=${encodeURIComponent(uuid)}; domain=claude.ai; path=/; max-age=${YEAR_MS / 1000}; secure; samesite=lax`
  }
  return JSON.stringify({ selected: read() })
}

export const selectOrganizationExpression = (uuid) => `(${selectOrganizationPageScript})(${JSON.stringify(uuid)})`
