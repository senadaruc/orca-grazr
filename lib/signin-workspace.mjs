import { orcaCall } from './orca-cli.mjs'

export const NO_WORKSPACE = 'Sign-in needs a local project in Orca: add any folder on this Mac as a project (Orca › Add project), then click again'

// The local Orca worktrees, read on this Mac's own runtime: { entries } or { error }. Each entry carries the selector a
// `--worktree` flag takes, its path, and the label the sign-in names (its repo's display name, else its folder).
const basename = (path) => path.split('/').filter(Boolean).at(-1) ?? path
function describeWorkspace(entry) {
  const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : null
  const path = typeof entry.path === 'string' && entry.path !== '' ? entry.path : null
  const selector = id ? `id:${id}` : path ? `path:${path}` : null
  if (selector === null) return null
  const repo = entry.repo?.displayName ?? entry.repoDisplayName ?? null
  const label = typeof repo === 'string' && repo !== '' ? repo : path ? basename(path) : selector
  return { selector, path, label }
}
async function localWorkspaces(ctx) {
  const listed = await orcaCall(ctx, ['worktree', 'list'])
  if (!listed.ok) return { error: listed.message }
  const raw = listed.result
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.worktrees) ? raw.worktrees : []
  return { entries: list.filter((e) => e !== null && typeof e === 'object').map(describeWorkspace).filter(Boolean) }
}

// The workspace a sign-in tab opens in: signinWorkspace when set, else the first local worktree (the plugin's own folder
// first, when it is one). { workspace }, { error } when the list cannot be read, or { none } when there is no local worktree.
export async function chooseWorkspace(ctx, settings, pluginRoot) {
  const listed = await localWorkspaces(ctx)
  if (listed.error) return { error: listed.error }
  const wanted = typeof settings.signinWorkspace === 'string' && settings.signinWorkspace.trim() !== '' ? settings.signinWorkspace.trim() : null
  if (wanted !== null) {
    const match = listed.entries.find((e) => e.selector === wanted)
    return { workspace: { selector: wanted, label: match?.label ?? wanted } }
  }
  if (listed.entries.length === 0) return { none: true }
  const pick = (pluginRoot && listed.entries.find((e) => e.path === pluginRoot)) || listed.entries[0]
  return { workspace: { selector: pick.selector, label: pick.label } }
}
