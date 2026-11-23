import { orcaCall } from './orca-cli.mjs'
import { chooseWorkspace, NO_WORKSPACE } from './signin-workspace.mjs'
import { describe } from './errors.mjs'

// The page an account's browser opens on; claude.ai sends a signed-in profile on to its workspace.
export const CLAUDE_URL = 'https://claude.ai/'
// The storage key of the mapping from account name to the id of its Orca browser profile.
export const STORAGE_KEY = 'browserProfiles'
const CLAUDE_SITES = ['claude.ai', 'claude.com']

// The profile label for an account: one isolated profile per account, reused by every sign-in and open for it.
export const profileLabel = (account) => (account ? `grazr · ${account}` : 'grazr · new account')

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
// An account name that starts with '-' would read as an option of the Orca CLI.
const usableName = (account) => typeof account === 'string' && account !== '' && !account.startsWith('-')

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

// One Orca browser profile per account, remembered by id so a relabelled profile is still the account's.
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

  // Records the account's profile. Nothing is written when the mapping already says so.
  async function remember(account, id) {
    try {
      const map = await stored()
      if (map[account] === id) return
      await storage.set(STORAGE_KEY, { ...map, [account]: id })
    } catch (err) {
      log(`grazr profiles: the profile of ${account} was not stored: ${describe(err)}`)
    }
  }

  // The account's profile among those listed: the stored id when Orca still lists it, else the one labelled for the
  // account; null when neither exists.
  async function find(account, profiles) {
    const known = (await stored())[account]
    if (typeof known === 'string' && profiles.some((p) => p.id === known)) return known
    const labelled = profiles.find((p) => p.label === profileLabel(account) && typeof p.id === 'string')
    return labelled ? labelled.id : null
  }

  // The account's profile, created isolated when it has none, and remembered either way.
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

  // Opens claude.ai as the account, in its own profile: a claude.ai tab already open in that profile is brought to the
  // front, else a tab is created in the sign-in workspace. { ok, message }; nothing here throws.
  async function openClaude(ctx, settings, account, pluginRoot = null) {
    const profile = await ensure(ctx, account)
    if (!profile.ok) return { ok: false, message: `No browser profile for ${account}: ${profile.message}` }
    const listed = await orcaCall(ctx, ['tab', 'list', '--worktree', 'all'])
    const tabs = listed.ok && Array.isArray(listed.result?.tabs) ? listed.result.tabs.filter(isObject) : []
    const open = tabs.find((t) => t.profileId === profile.id && typeof t.browserPageId === 'string' && onClaude(t.url))
    // A tab that cannot be switched to is gone or hidden; a new one is opened then.
    if (open && (await focus(ctx, open.browserPageId, typeof open.worktreeId === 'string' && open.worktreeId !== '' ? `id:${open.worktreeId}` : null))) {
      return { ok: true, message: `Switched to the claude.ai tab of ${account}` }
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
    return { ok: true, message: `Opened claude.ai as ${account} in the ${workspace.label} workspace${note}` }
  }

  return { ensure, remember, find, openClaude }
}
