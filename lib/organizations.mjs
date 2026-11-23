import { describe } from './errors.mjs'

// The organizations of each login, as claude.ai lists them to the login's browser profile, kept in the plugin's storage:
// { [lowercased e-mail]: { readAt, triedAt?, state: 'ok'|'signed-out'|'failed', orgs: [organization] } }.
// A read that fails or finds the profile signed out keeps the list it had.
export const ORGANIZATIONS_KEY = 'organizations'

export const FREE_REASON = 'Free plan — Claude Code needs a paid plan'
export const API_REASON = 'API console organization — not a Claude subscription'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const capitalized = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

// The plan an organization's capabilities name, when claude.ai gives no plan name of its own. Max 20x is Ultra since
// 2026-10-30, as the engine's plans read.
function planOf(raw, kind, caps) {
  if (isText(raw.plan_display_name)) return raw.plan_display_name.trim()
  if (isText(raw.plan_display_label)) return raw.plan_display_label.trim()
  if (kind === 'api') return 'API'
  if (kind === 'free') return 'Free'
  if (isText(raw.raven_type)) return capitalized(raw.raven_type.trim())
  if (caps.includes('claude_max')) return /20x|ultra/i.test(String(raw.rate_limit_tier ?? '')) ? 'Ultra' : 'Max'
  if (caps.includes('claude_pro')) return 'Pro'
  return null
}

// One organization of claude.ai's list as Grazr keeps it: { uuid, name, label, plan, claudeCode, reason, kind }, or null
// without a uuid. kind is 'subscription' (it can run Claude Code), 'free' or 'api'. A paid shape not seen yet counts as
// a subscription when it can chat and has a paid capability or a billing type. label hides the personal organization's
// default name ("<e-mail>'s Organization") as "Personal".
export function organizationOf(raw, email = null) {
  if (!isObject(raw) || !isText(raw.uuid)) return null
  const caps = Array.isArray(raw.capabilities) ? raw.capabilities.filter((c) => typeof c === 'string') : []
  const chat = caps.includes('chat')
  const paid = caps.some((c) => c === 'claude_pro' || c === 'claude_max' || c === 'raven')
  const billed = isText(raw.billing_type) && raw.billing_type !== 'none'
  const kind = !chat ? 'api' : paid || billed ? 'subscription' : 'free'
  const name = isText(raw.name) ? raw.name.trim() : null
  const personal = name === null || /'s Organization$/i.test(name) && (email === null || name.toLowerCase() === `${email.toLowerCase()}'s organization`)
  return {
    uuid: raw.uuid.trim(),
    name,
    label: personal ? 'Personal' : name,
    plan: planOf(raw, kind, caps),
    claudeCode: kind === 'subscription',
    reason: kind === 'free' ? FREE_REASON : kind === 'api' ? API_REASON : null,
    kind,
  }
}

// claude.ai's list as Grazr keeps it, without entries that have no uuid.
export const organizationsOf = (list, email = null) => (Array.isArray(list) ? list : []).map((raw) => organizationOf(raw, email)).filter(Boolean)

// What a row says of an organization: its name and plan, "Acme · Team".
export const organizationLabel = (org) => [org.label, org.plan].filter(isText).join(' · ')

// The stored organization lists; a store that cannot be read holds none.
export async function loadOrganizations(storage, log = () => {}) {
  try {
    const value = await storage.get(ORGANIZATIONS_KEY)
    return isObject(value) ? value : {}
  } catch (err) {
    log(`grazr organizations: the stored lists could not be loaded: ${describe(err)}`)
    return {}
  }
}

const storedOrgs = (entry) => (isObject(entry) && Array.isArray(entry.orgs) ? entry.orgs.filter((o) => isObject(o) && isText(o.uuid)) : [])

// A login's stored organizations, by its e-mail.
export const organizationsFor = (stored, email) => (isText(email) && isObject(stored) ? storedOrgs(stored[email.trim().toLowerCase()]) : [])

// A login's new entry over its last one: { state: 'ok', orgs } replaces the list; a signed-out or failed read keeps it.
export function nextOrganizations(previous, outcome, at) {
  if (outcome.state === 'ok') return { readAt: at, state: 'ok', orgs: outcome.orgs }
  if (outcome.state === 'signed-out') return { readAt: at, state: 'signed-out', orgs: storedOrgs(previous) }
  return { readAt: isObject(previous) && Number.isFinite(previous.readAt) ? previous.readAt : at, triedAt: at, state: 'failed', orgs: storedOrgs(previous) }
}

// The organization an enrolled account is of: the one with its organization uuid; an account without one (an engine
// before fork.16) is of the login's only subscription organization, and of none when the login has several.
export function organizationFor(organizationUuid, orgs) {
  if (isText(organizationUuid)) return orgs.find((o) => o.uuid === organizationUuid) ?? null
  const subscriptions = orgs.filter((o) => o.claudeCode === true)
  return subscriptions.length === 1 ? subscriptions[0] : null
}

// The organizations of a host's logins that are not enrolled there, as placeholders for the panel's discovered rows:
// a subscription organization can be signed in, a free or API one is unsupported with its reason. A login with an
// account the engine reports no organization uuid for (an engine before fork.16) gets none, since which of its
// organizations is enrolled cannot be told.
export function discoveredOrganizations(report, stored) {
  const accounts = (Array.isArray(report?.accounts) ? report.accounts : []).filter((a) => isObject(a) && isText(a.name) && isText(a.email))
  const logins = new Map()
  for (const account of accounts) {
    const key = account.email.trim().toLowerCase()
    if (!logins.has(key)) logins.set(key, [])
    logins.get(key).push(account)
  }
  const placeholders = []
  for (const [key, members] of logins) {
    if (members.some((a) => !isText(a.organization_uuid))) continue
    const enrolled = new Set(members.map((a) => a.organization_uuid))
    const { email, login } = members[0]
    for (const org of organizationsFor(stored, key)) {
      if (enrolled.has(org.uuid)) continue
      const supported = org.claudeCode === true
      placeholders.push({
        name: `${email} · ${org.label ?? org.name ?? org.uuid}`,
        email,
        ...(isText(login) ? { login } : {}),
        organizationUuid: org.uuid,
        orgLabel: organizationLabel(org) || null,
        claudeCode: supported,
        reason: supported ? null : (org.reason ?? null),
      })
    }
  }
  return placeholders
}
