import { orcaCall } from './orca-cli.mjs'
import { chooseWorkspace, NO_WORKSPACE } from './signin-workspace.mjs'
import { listProfiles } from './browser-profiles.mjs'
import { parseUsagePage } from './usage-page-resets.mjs'
import { nextReading } from './limit-reset-readings.mjs'
import { organizationsExpression, parseOrganizationsAnswer } from './organizations-request.mjs'
import { organizationFor, organizationsFor, organizationsOf, nextOrganizations } from './organizations.mjs'
import { readingFromGrants } from './limit-reset-grants.mjs'
import { describe } from './errors.mjs'

// claude.ai sends this on to /new#settings/usage, which opens the Settings dialog on its Usage tab.
export const USAGE_URL = 'https://claude.ai/settings/usage'
// The section every plan shows when it has resets, then the heading every plan shows (a page without the section):
// 20 s in all. "Your usage" also matches Team's "Your usage limits".
const WAITS = [{ text: 'Limit resets', ms: 15000 }, { text: 'Your usage', ms: 5000 }]
// Room for the CLI to answer after its own timeout.
const WAIT_SLACK_MS = 5000
// The dialog's text, else the whole page's (a login screen has no dialog).
const PAGE_TEXT = '(document.querySelector("[role=dialog]")||document.body).innerText'

export const failed = (message) => ({ state: 'failed', message })

// Waits for the Usage page in the tab to show its limit resets, else its heading. A signed-out profile never shows the
// text, so the page is used after failed waits too: a login screen says signed out.
export async function waitForUsage(ctx, selector, page) {
  for (const wait of WAITS) {
    const found = await orcaCall(ctx, ['wait', '--page', page, '--worktree', selector, '--text', wait.text, '--timeout', String(wait.ms)], { timeoutMs: wait.ms + WAIT_SLACK_MS })
    if (found.ok) return true
  }
  return false
}

// Opens the usage page in a tab of the account's profile in the workspace, waits for it, and hands its page id to use;
// use's result is returned, or { state: 'failed', message }. The tab is created without focus (Orca's CLI never asks for
// it) and is closed whatever happens once it exists.
export async function withUsageTab(ctx, selector, profileId, log, use) {
  const tab = await orcaCall(ctx, ['tab', 'create', '--worktree', selector, '--url', USAGE_URL, '--profile', profileId])
  const page = tab.ok && typeof tab.result?.browserPageId === 'string' ? tab.result.browserPageId : null
  if (page === null) return failed(tab.ok ? 'Orca did not return a tab' : tab.message)
  try {
    await waitForUsage(ctx, selector, page)
    return await use(page)
  } catch (err) {
    return failed(describe(err))
  } finally {
    try {
      const closed = await orcaCall(ctx, ['tab', 'close', '--page', page, '--worktree', selector])
      if (!closed.ok) log(`grazr limit resets: the usage tab ${page} was not closed: ${closed.message}`)
    } catch (err) {
      log(`grazr limit resets: the usage tab ${page} was not closed: ${describe(err)}`)
    }
  }
}

// The workspace and the profiles a usage tab needs: { selector, profiles } or { error }.
export async function usageTabPlace(ctx, pluginRoot) {
  const listed = await listProfiles(ctx)
  if (listed.error) return { error: `Orca browser profiles unavailable: ${listed.error}` }
  const chosen = await chooseWorkspace(ctx, ctx.settings, pluginRoot)
  if (chosen.error || chosen.none) return { error: `no workspace for the tab: ${chosen.error ?? NO_WORKSPACE}` }
  return { selector: chosen.workspace.selector, profiles: listed.profiles }
}

// The text of the page in the tab: { text, url } or { state: 'failed', message }.
async function pageText(ctx, selector, page) {
  const read = await orcaCall(ctx, ['eval', '--page', page, '--worktree', selector, '--expression', PAGE_TEXT])
  if (!read.ok) return failed(read.message)
  const text = typeof read.result?.result === 'string' ? read.result.result : null
  if (text === null) return failed('Orca returned no page text')
  return { text, url: read.result.origin }
}

// The Usage page's text read as limit resets: { state, full, model, kinds } or { state: 'failed', message }.
export async function readPageText(ctx, selector, page) {
  const read = await pageText(ctx, selector, page)
  if (read.state === 'failed') return read
  const parsed = parseUsagePage(read.text, { url: read.url })
  if (parsed.signedIn === false) return { state: 'signed-out' }
  if (!parsed.loaded || parsed.full === null || parsed.model === null) return failed('the page did not show its limit resets in a known form')
  return { state: 'ok', full: parsed.full, model: parsed.model, kinds: parsed.kinds }
}

// The login's organizations and the grants of those it asks for, read from claude.ai's data in the page:
// { state: 'ok', selectedOrg, organizations, usage } or { state: 'signed-out' } or { state: 'failed', message }.
export async function readOrganizationData(ctx, selector, page, only = null) {
  const read = await orcaCall(ctx, ['eval', '--page', page, '--worktree', selector, '--expression', organizationsExpression(only)])
  if (!read.ok) return failed(read.message)
  if (typeof read.result?.result !== 'string') return failed('Orca returned no answer from the page')
  return parseOrganizationsAnswer(read.result.result)
}

// The reading of one organization from the data read: the reading, or null when its grants could not be read.
export function organizationReading(data, uuid, { timeZone } = {}) {
  const usage = data.usage?.[uuid]
  if (!usage || usage.status !== 200) return null
  const reading = readingFromGrants(usage.cedar_ember, { timeZone })
  return reading === null ? null : { state: 'ok', ...reading, source: 'api', organizationUuid: uuid }
}

// One login's organizations and its accounts' limit resets, read in one tab of its profile. The accounts are each
// matched to their organization (lib/organizations.mjs), and a reading is only ever the grants of the account's own
// organization. When claude.ai's data cannot be read for an account, the Usage page's text stands in, but only for a
// login with one enrolled account and no more than one subscription organization known: the page shows the
// organization selected there, which for a login with several could be another one.
// { login: { state, orgs? }, outcomes: { [name]: outcome } }.
function readLogin(ctx, selector, profileId, log, { email, accounts, known, timeZone }) {
  const byName = (outcome) => Object.fromEntries(accounts.map((a) => [a.name, outcome]))
  return withUsageTab(ctx, selector, profileId, log, async (page) => {
    const data = await readOrganizationData(ctx, selector, page)
    if (data.state === 'signed-out') return { login: { state: 'signed-out' }, outcomes: byName({ state: 'signed-out' }) }
    const orgs = data.state === 'ok' ? organizationsOf(data.organizations, email) : known
    if (data.state === 'failed') log(`grazr limit resets: the organizations of ${email ?? accounts[0].name} were not read from claude.ai's data: ${data.message}`)
    const outcomes = {}
    const fallback = []
    for (const account of accounts) {
      const org = organizationFor(account.organizationUuid, orgs)
      const reading = data.state === 'ok' && org !== null ? organizationReading(data, org.uuid, { timeZone }) : null
      if (reading !== null) {
        outcomes[account.name] = reading
        continue
      }
      if (data.state === 'ok' && org === null) log(`grazr limit resets: ${account.name}: its organization is not among the organizations claude.ai lists for its login`)
      else if (data.state === 'ok') log(`grazr limit resets: ${account.name}: the limit resets of its organization were not read from claude.ai's data`)
      fallback.push({ account, org })
    }
    const single = accounts.length === 1 && accounts[0].several !== true && orgs.filter((o) => o.claudeCode === true).length <= 1
    for (const { account, org } of fallback) {
      if (!single) {
        outcomes[account.name] = failed('its organization could not be read, and the Usage page cannot tell the organizations of its login apart')
        continue
      }
      log(`grazr limit resets: ${account.name}: read from the Usage page's text instead`)
      const read = await readPageText(ctx, selector, page)
      outcomes[account.name] = read.state === 'ok' ? { ...read, source: 'page', organizationUuid: org?.uuid ?? account.organizationUuid ?? null } : read
    }
    return { login: data.state === 'ok' ? { state: 'ok', orgs } : { state: 'failed' }, outcomes }
  })
}

const loginKey = (account) => (typeof account.email === 'string' && account.email !== '' ? `email:${account.email.toLowerCase()}` : `name:${account.name}`)

// Reads the limit resets of each named account that already has a browser profile, one login after another, one tab
// per login; an account without a profile is noted, never given one here. Returns { readings, organizations }: the
// readings merged over previous, and the organization lists merged over organizations (keyed by lowercased e-mail).
// null when nothing could be read at all (no workspace for a tab, or Orca's browser unavailable), so nothing is stored.
// An account is { name, email, organizationUuid, several } (several: its login has two or more enrolled organizations),
// or a bare name.
export async function readLimitResets({ ctx, accounts, profiles, pluginRoot = null, previous = {}, organizations = {}, now = Date.now, log = () => {}, timeZone }) {
  const place = await usageTabPlace(ctx, pluginRoot)
  if (place.error) {
    log(`grazr limit resets: not read, ${place.error}`)
    return null
  }
  const { selector } = place
  const readings = { ...previous }
  const lists = { ...organizations }
  const logins = new Map()
  for (const entry of accounts) {
    const account = typeof entry === 'string' ? { name: entry, email: null } : { ...entry, email: typeof entry.email === 'string' && entry.email !== '' ? entry.email : null }
    if (!logins.has(loginKey(account))) logins.set(loginKey(account), [])
    logins.get(loginKey(account)).push(account)
  }
  for (const members of logins.values()) {
    const { email } = members[0]
    const key = email === null ? null : email.toLowerCase()
    const id = await profiles.find({ name: members[0].name, email }, place.profiles)
    let result
    if (id === null) result = { login: null, outcomes: Object.fromEntries(members.map((a) => [a.name, { state: 'no-profile' }])) }
    else {
      result = await readLogin(ctx, selector, id, log, { email, accounts: members, known: key === null ? [] : organizationsFor(lists, key), timeZone })
      if (result.state === 'failed') result = { login: { state: 'failed' }, outcomes: Object.fromEntries(members.map((a) => [a.name, result])) }
    }
    if (key !== null && result.login !== null) lists[key] = nextOrganizations(lists[key], result.login, now())
    for (const account of members) {
      const outcome = result.outcomes[account.name]
      if (outcome.state === 'failed') log(`grazr limit resets: the limit resets of ${account.name} were not read: ${outcome.message}`)
      readings[account.name] = nextReading(previous[account.name], outcome, now())
    }
  }
  return { readings, organizations: lists }
}
