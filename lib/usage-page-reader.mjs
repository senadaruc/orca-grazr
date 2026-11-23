import { orcaCall } from './orca-cli.mjs'
import { chooseWorkspace, NO_WORKSPACE } from './signin-workspace.mjs'
import { listProfiles } from './browser-profiles.mjs'
import { parseUsagePage } from './usage-page-resets.mjs'
import { nextReading } from './limit-reset-readings.mjs'
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

const failed = (message) => ({ state: 'failed', message })

// One account's usage page, read in a tab of its own profile in the workspace: { state, full, model, kinds } or
// { state: 'failed', message }. The tab is created without focus (Orca's CLI never asks for it), nothing on the page is
// clicked, and the tab is closed whatever happens once it exists.
async function readPage(ctx, selector, profileId, log) {
  const tab = await orcaCall(ctx, ['tab', 'create', '--worktree', selector, '--url', USAGE_URL, '--profile', profileId])
  const page = tab.ok && typeof tab.result?.browserPageId === 'string' ? tab.result.browserPageId : null
  if (page === null) return failed(tab.ok ? 'Orca did not return a tab' : tab.message)
  try {
    // A signed-out profile never shows the text, so the page is read after failed waits too: a login screen says signed out.
    for (const wait of WAITS) {
      const found = await orcaCall(ctx, ['wait', '--page', page, '--worktree', selector, '--text', wait.text, '--timeout', String(wait.ms)], { timeoutMs: wait.ms + WAIT_SLACK_MS })
      if (found.ok) break
    }
    const read = await orcaCall(ctx, ['eval', '--page', page, '--worktree', selector, '--expression', PAGE_TEXT])
    if (!read.ok) return failed(read.message)
    const text = typeof read.result?.result === 'string' ? read.result.result : null
    if (text === null) return failed('Orca returned no page text')
    const parsed = parseUsagePage(text, { url: read.result.origin })
    if (parsed.signedIn === false) return { state: 'signed-out' }
    if (!parsed.loaded || parsed.full === null || parsed.model === null) return failed('the page did not show its limit resets in a known form')
    return { state: 'ok', full: parsed.full, model: parsed.model, kinds: parsed.kinds }
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

// Reads the usage page of each named account that already has a browser profile, one after another, and returns the
// readings merged over previous; an account without a profile is noted, never given one here. null when nothing could
// be read at all (no workspace for a tab, or Orca's browser unavailable), so nothing is stored.
export async function readLimitResets({ ctx, accounts, profiles, pluginRoot = null, previous = {}, now = Date.now, log = () => {} }) {
  const listed = await listProfiles(ctx)
  if (listed.error) {
    log(`grazr limit resets: not read, Orca browser profiles unavailable: ${listed.error}`)
    return null
  }
  const chosen = await chooseWorkspace(ctx, ctx.settings, pluginRoot)
  if (chosen.error || chosen.none) {
    log(`grazr limit resets: not read, no workspace for the tab: ${chosen.error ?? NO_WORKSPACE}`)
    return null
  }
  const selector = chosen.workspace.selector
  const readings = { ...previous }
  for (const account of accounts) {
    const id = await profiles.find(account, listed.profiles)
    const outcome = id === null ? { state: 'no-profile' } : await readPage(ctx, selector, id, log)
    if (outcome.state === 'failed') log(`grazr limit resets: the usage page of ${account} was not read: ${outcome.message}`)
    readings[account] = nextReading(previous[account], outcome, now())
  }
  return readings
}
