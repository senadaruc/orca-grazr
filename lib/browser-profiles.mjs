import { orcaCall } from './orca-cli.mjs'
import { chooseWorkspace, NO_WORKSPACE } from './signin-workspace.mjs'
import { describe } from './errors.mjs'

// The page an account's browser opens on; claude.ai sends a signed-in profile on to its workspace.
export const CLAUDE_URL = 'https://claude.ai/'
// The storage key of the mapping from a login's e-mail, and from each account name, to the id of its Orca browser profile.
export const STORAGE_KEY = 'browserProfiles'
const CLAUDE_SITES = ['claude.ai', 'claude.com']

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v) => typeof v === 'string' && v.trim() !== ''

// An account as { name, email }: a bare string is a name (callers that know only the name), and email is null when unknown.
function accountOf(account) {
  if (isObject(account)) return { name: isText(account.name) ? account.name : null, email: isText(account.email) ? account.email.trim() : null }
  return { name: isText(account) ? account : null, email: null }
}

// The key a login's profile is stored under: its e-mail, lowercased, so every organization of one login shares it; the
// name when the e-mail is not known.
export const profileKey = (account) => {
  const { name, email } = accountOf(account)
  return email !== null ? email.toLowerCase() : name
}

// The profile label for a login: one isolated profile per login, reused by every sign-in and open of its organizations.
export const profileLabel = (account) => {
  const { name, email } = accountOf(account)
  const who = email ?? name
  return who ? `grazr · ${who}` : 'grazr · new account'
}

// An account name that starts with '-' would read as an option of the Orca CLI.
const usableName = (account) => {
  const { name } = accountOf(account)
  return name !== null && !name.startsWith('-')
}

// Whether an address is on claude.ai or claude.com, or a subdomain of one, over https.
export function onClaude(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && CLAUDE_SITES.some((site) => parsed.hostname === site || parsed.hostname.endsWith(`.${site}`))
}

// The profiles Orca lists on this Mac, as { profiles } or { error }.
export async function listProfiles(ctx) {
  const listed = await orcaCall(ctx, ['tab', 'profile', 'list'])
  return listed.ok ? { profiles: (listed.result?.profiles ?? []).filter(isObject) } : { error: listed.message }
}

// One Orca browser profile per login, remembered by id so a relabelled profile is still the login's. The mapping is
// keyed by the login's e-mail and by each account name, so a lookup by name alone still finds it.
// storage is the plugin's (get/set by key); every store failure is logged, never thrown.
export function createAccountProfiles({ storage, log = () => {} }) {
  async function stored() {
    try {
      const value = await storage.get(STORAGE_KEY)
      return isObject(value) ? value : {}
    } catch (err) {
      log(`grazr profiles: the profile mapping could not be read: ${describe(err)}`)
      return {}
    }
  }

  // Records the profile under the login's e-mail and under the account's name. Nothing is written when the mapping
  // already says so.
  async function remember(account, id) {
    const { name } = accountOf(account)
    const keys = [...new Set([profileKey(account), name].filter((k) => k !== null))]
    try {
      const map = await stored()
      if (keys.every((k) => map[k] === id)) return
      await storage.set(STORAGE_KEY, { ...map, ...Object.fromEntries(keys.map((k) => [k, id])) })
    } catch (err) {
      log(`grazr profiles: the profile of ${name ?? profileKey(account)} was not stored: ${describe(err)}`)
    }
  }

  // The login's profile among those listed: the id stored for its e-mail, then for its name, when Orca still lists it;
  // else the one labelled for its e-mail, then for its name. null when none exists.
  async function find(account, profiles) {
    const { name, email } = accountOf(account)
    const map = await stored()
    const listed = (id) => typeof id === 'string' && profiles.some((p) => p.id === id)
    for (const key of [email === null ? null : email.toLowerCase(), name]) {
      if (key !== null && listed(map[key])) return map[key]
    }
    for (const label of [email === null ? null : profileLabel({ email }), name === null ? null : profileLabel(name)]) {
      const labelled = label === null ? undefined : profiles.find((p) => p.label === label && typeof p.id === 'string')
      if (labelled) return labelled.id
    }
    return null
  }

  // The login's profile, created isolated when it has none, and remembered either way.
  // { ok, id, created } or { ok: false, message }.
  async function ensure(ctx, account) {
    if (!usableName(account)) return { ok: false, message: 'That account name cannot have a browser profile' }
    const listed = await listProfiles(ctx)
    if (listed.error) return { ok: false, message: listed.error }
    const found = await find(account, listed.profiles)
    if (found !== null) {
      await remember(account, found)
      return { ok: true, id: found, created: false }
    }
    const label = profileLabel(account)
    const made = await orcaCall(ctx, ['tab', 'profile', 'create', '--label', label, '--scope', 'isolated'])
    if (!made.ok) return { ok: false, message: made.message }
    // Orca answers with the profile; an older Orca answers with nothing, and the list says what it made.
    let id = typeof made.result?.profile?.id === 'string' ? made.result.profile.id : null
    if (id === null) {
      const again = await listProfiles(ctx)
      if (again.error) return { ok: false, message: again.error }
      id = again.profiles.find((p) => p.label === label && typeof p.id === 'string')?.id ?? null
    }
    if (id === null) return { ok: false, message: `Orca did not list the profile ${label}` }
    await remember(account, id)
    return { ok: true, id, created: true }
  }

  // Brings the tab to the front in its workspace; a failure is logged and never fatal.
  async function focus(ctx, page, worktree) {
    const focused = await orcaCall(ctx, ['tab', 'switch', '--page', page, ...(worktree ? ['--worktree', worktree] : []), '--focus'])
    if (!focused.ok) log(`grazr profiles: the claude.ai tab could not be brought to the front: ${focused.message}`)
    return focused.ok
  }

  // Opens claude.ai as the account, in its login's profile: a claude.ai tab already open in that profile is brought to the
  // front, else a tab is created in the sign-in workspace. { ok, message }; nothing here throws.
  async function openClaude(ctx, settings, account, pluginRoot = null) {
    const who = accountOf(account).name ?? accountOf(account).email
    const profile = await ensure(ctx, account)
    if (!profile.ok) return { ok: false, message: `No browser profile for ${who}: ${profile.message}` }
    const listed = await orcaCall(ctx, ['tab', 'list', '--worktree', 'all'])
    const tabs = listed.ok && Array.isArray(listed.result?.tabs) ? listed.result.tabs.filter(isObject) : []
    const open = tabs.find((t) => t.profileId === profile.id && typeof t.browserPageId === 'string' && onClaude(t.url))
    // A tab that cannot be switched to is gone or hidden; a new one is opened then.
    if (open && (await focus(ctx, open.browserPageId, typeof open.worktreeId === 'string' && open.worktreeId !== '' ? `id:${open.worktreeId}` : null))) {
      return { ok: true, message: `Switched to the claude.ai tab of ${who}` }
    }
    const chosen = await chooseWorkspace(ctx, settings, pluginRoot)
    if (chosen.error) return { ok: false, message: chosen.error }
    if (chosen.none) return { ok: false, message: NO_WORKSPACE }
    const { workspace } = chosen
    const tab = await orcaCall(ctx, ['tab', 'create', '--worktree', workspace.selector, '--url', CLAUDE_URL, '--profile', profile.id])
    const page = tab.ok && typeof tab.result?.browserPageId === 'string' ? tab.result.browserPageId : null
    if (page === null) {
      return { ok: false, message: `Orca's browser in the ${workspace.label} workspace could not open claude.ai: ${tab.ok ? 'Orca did not return a tab' : tab.message}` }
    }
    await focus(ctx, page, workspace.selector)
    const note = profile.created ? ' — sign in once there; Grazr keeps that profile for the account' : ''
    return { ok: true, message: `Opened claude.ai as ${who} in the ${workspace.label} workspace${note}` }
  }

  return { ensure, remember, find, openClaude }
}
