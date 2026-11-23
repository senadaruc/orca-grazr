import { orcaCall } from './orca-cli.mjs'
import { parseUsagePage, resetKindOf } from './usage-page-resets.mjs'
import { USAGE_URL, usageTabPlace, withUsageTab, waitForUsage, readOrganizationData, organizationReading } from './usage-page-reader.mjs'
import { selectOrganizationExpression } from './organizations-request.mjs'
import { describe } from './errors.mjs'

// The plugin command for each kind of reset, and the kind it uses on claude.ai's Settings › Usage page.
export const RESET_KINDS = { 'limit-reset-model': 'model', 'limit-reset-full': 'full' }

// After the click the page is looked at once a second, 20 s in all.
export const POLLS = 20
export const POLL_MS = 1000
// claude.ai greys Reset for free out while its window has no focus, as a background tab never has. Once the page is
// given focus, its button is looked at once a second, 10 s in all, before it counts as nothing to reset.
export const FOCUS_POLLS = 10
// A lower count must be seen this many times running before it counts: a page drawn halfway is not a spent reset.
const AGREEING = 2

export const NOTHING_TO_RESET = 'claude.ai does not offer this reset right now — nothing to reset'
// An organization of a login with several whose organization uuid is not known: the Usage page could show another one.
export const SEVERAL_ORGANIZATIONS = 'its organization is not known, and the Usage page of a login with several organizations shows only the one selected there'
// The organization could not be selected on claude.ai, or the page did not show it once selected.
export const couldNotSwitch = (org) => `could not switch claude.ai to ${org} — select it in the account menu and try again`
export const UNCONFIRMED = 'could not confirm the reset was used — check claude.ai'

// A dialog's button that confirms the reset, and the words that mean it does not.
const CONFIRM = /\b(reset|confirm|use|continue|yes|ok)\b/i
const REFUSE = /\b(cancel|close|back|no|not|keep|dismiss|later)\b|\bdon[’']?t\b/i

// Runs in the page, so it carries everything it needs. op 'describe' reports the Limit resets section's rows and the
// dialogs that opened since the click; 'focus' tells the page its window has focus, as a tab the user looks at does;
// 'click-row' clicks the one Reset for free button of a row, after checking the row still has the title the worker
// chose and that the button is enabled; 'click-confirm' clicks one dialog button, after checking its text. Dialogs open
// at the row click are marked seen then, so the Settings dialog itself is never one.
export function usagePageScript(op, arg) {
  // The browser's own answer, even once 'focus' has answered for the page.
  const realFocus = () => {
    try {
      return Object.getPrototypeOf(document).hasFocus.call(document)
    } catch {
      return null
    }
  }
  const focusState = () => ({ hasFocus: realFocus(), visibility: document.visibilityState ?? null })
  if (op === 'focus') {
    // claude.ai enables its reset buttons on the window's focus event and greys them out on blur. The tab is the
    // plugin's own and closed after, so answering hasFocus for it touches nothing of the user's.
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    window.dispatchEvent(new Event('focus'))
    return JSON.stringify({ focused: true, ...focusState() })
  }
  const textOf = (el) => String((el && (el.innerText ?? el.textContent)) || '').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim()
  const heading = [...document.querySelectorAll('h1,h2,h3,h4,[data-settings-group-title]')].find((el) => /^limit resets$/i.test(textOf(el))) ?? null
  const section = heading ? heading.closest('section') : null
  const rowsOf = () => {
    if (!section) return []
    const all = [...section.querySelectorAll('[data-settings-row],[role=group]')]
    return all.filter((row) => !all.some((other) => other !== row && row.contains(other)))
  }
  const titleOf = (row) => {
    const named = row.querySelector('[data-testid="ce2-type"]')
    if (named) return textOf(named)
    return String(row.innerText ?? row.textContent ?? '').split('\n').map((line) => textOf({ innerText: line })).find(Boolean) ?? ''
  }
  const resetButtons = (row) => [...row.querySelectorAll('button')].filter((b) => /^reset for free$/i.test(textOf(b)))
  const isDisabled = (b) => b.disabled === true || b.getAttribute('aria-disabled') === 'true'
  const dialogs = () => [...document.querySelectorAll('[role=dialog],[role=alertdialog]')]
  const fresh = () => dialogs().filter((d) => !d.hasAttribute('data-grazr-seen'))
  const own = section ? dialogs().find((d) => d.contains(section)) : null
  if (op === 'describe') {
    return JSON.stringify({
      url: location.href,
      section: section !== null,
      text: String(((own ?? dialogs()[0] ?? document.body).innerText) ?? ''),
      rows: rowsOf().map((row) => {
        const buttons = resetButtons(row)
        return { title: titleOf(row), buttons: buttons.length, disabled: buttons.length === 1 ? isDisabled(buttons[0]) : null, reason: textOf(row.querySelector('[data-cds-disabled-reason]')) }
      }),
      dialogs: fresh().filter((d) => !(section && d.contains(section))).map((d) => ({
        role: d.getAttribute('role'),
        text: textOf(d).slice(0, 400),
        buttons: [...d.querySelectorAll('button')].map((b) => ({ text: textOf(b), disabled: isDisabled(b) })),
      })),
      status: textOf(document.querySelector('[data-testid="ce2-status"]')),
      focus: focusState(),
    })
  }
  if (op === 'click-row') {
    const row = rowsOf()[arg.index]
    if (!row || titleOf(row) !== arg.title) return JSON.stringify({ clicked: false, reason: 'the reset row changed before the click' })
    const buttons = resetButtons(row)
    if (buttons.length !== 1) return JSON.stringify({ clicked: false, reason: 'the row has no single Reset for free button' })
    if (isDisabled(buttons[0])) return JSON.stringify({ clicked: false, disabled: true })
    dialogs().forEach((d) => d.setAttribute('data-grazr-seen', ''))
    buttons[0].click()
    return JSON.stringify({ clicked: true })
  }
  if (op === 'click-confirm') {
    const dialog = fresh().filter((d) => !(section && d.contains(section)))[arg.dialog]
    const button = dialog ? [...dialog.querySelectorAll('button')][arg.button] : undefined
    if (!button || textOf(button) !== arg.text || isDisabled(button)) return JSON.stringify({ clicked: false, reason: 'the dialog changed before the click' })
    button.click()
    return JSON.stringify({ clicked: true })
  }
  return JSON.stringify({ clicked: false, reason: `unknown op ${op}` })
}

export const pageExpression = (op, arg = null) => `(${usagePageScript})(${JSON.stringify(op)}, ${JSON.stringify(arg)})`

// The one row of the kind asked for: { row } or { none } or { several }. A row is matched by its title alone.
export function chooseRow(rows, kind) {
  const matches = rows.map((row, index) => ({ ...row, index, reset: resetKindOf(row.title) })).filter((row) => row.reset?.kind === kind)
  if (matches.length === 0) return { none: true }
  if (matches.length > 1) return { several: true }
  return { row: matches[0] }
}

// The confirming button among a dialog's buttons: its index when exactly one enabled button says reset, confirm or
// use and nothing like cancel, else null.
export function confirmButton(dialog) {
  const picks = (dialog?.buttons ?? []).map((b, index) => ({ ...b, index }))
    .filter((b) => !b.disabled && CONFIRM.test(b.text) && !REFUSE.test(b.text))
  return picks.length === 1 ? picks[0].index : null
}

const countOf = (parsed, kind) => (kind === 'full' ? parsed.full : parsed.model)
const okOutcome = (parsed) => ({ state: 'ok', full: parsed.full, model: parsed.model, kinds: parsed.kinds })
const known = (seen, parsed) => seen.section && parsed.loaded && parsed.full !== null && parsed.model !== null
const kindWord = (kind) => (kind === 'full' ? 'full' : 'model')

// Uses one reset of the account on its claude.ai Usage page, in a background tab of its login's profile: makes sure the
// page shows the account's organization, gives the page focus when the row's Reset for free is greyed out (the tab
// stays in the background), clicks it once enabled, confirms an unambiguous dialog, and succeeds only once claude.ai
// counts one fewer of that kind: the organization's grants, else the page.
// account is { name, email } or a name; organization is { uuid, name } when the account's organization is known; several
// marks a login with two or more enrolled organizations, refused before any tab opens when its organization is not known.
// { ok, message, label, clicked, outcome } where outcome, when known, is a reading for the stored readings.
export async function useLimitReset({ ctx, account, organization = null, several = false, kind, profiles, pluginRoot = null, sleep, log = () => {}, timeZone }) {
  const name = typeof account === 'string' ? account : account.name
  if (several && organization === null) return { ok: false, clicked: false, message: SEVERAL_ORGANIZATIONS }
  const place = await usageTabPlace(ctx, pluginRoot)
  if (place.error) return { ok: false, clicked: false, message: place.error }
  const id = await profiles.find(account, place.profiles)
  if (id === null) return { ok: false, clicked: false, outcome: { state: 'no-profile' }, message: `${name} has no browser profile yet: open claude.ai for it and sign in once` }
  const { selector } = place
  // Whether the row was clicked, for a failure the tab machinery reports: null once a click may have happened.
  const progress = { clicked: false }
  const result = await withUsageTab(ctx, selector, id, log, (page) => onOrganization({ ctx, selector, page, account: name, organization, several, kind, sleep, log, progress, timeZone }))
  if (result.state !== 'failed') return result
  return { ok: false, clicked: progress.clicked, message: progress.clicked === false ? result.message : `${UNCONFIRMED} (${result.message})` }
}

// The organization's grants read in the page: { data, reading } (reading null when its grants could not be read), or
// { signedOut } or { failed }.
async function grantsOf(ctx, selector, page, uuid, timeZone) {
  const data = await readOrganizationData(ctx, selector, page, [uuid])
  if (data.state === 'signed-out') return { signedOut: true }
  if (data.state !== 'ok') return { failed: data.message }
  return { data, reading: organizationReading(data, uuid, { timeZone }) }
}

// Runs the reset on the page once it shows the account's organization: selected already, or selected for this reset and
// checked (the cookie reads it back after a reload, and the page counts what the organization's grants count). The
// selection the user had is put back afterwards, as far as the page lets it.
async function onOrganization({ ctx, selector, page, account, organization, several, kind, sleep, log, progress, timeZone }) {
  const say = (msg) => log(`grazr limit reset: ${account}: ${msg}`)
  const signedOut = { ok: false, clicked: false, outcome: { state: 'signed-out' }, message: `${account} is signed out of claude.ai in its browser profile: open claude.ai for it and sign in once` }
  if (organization === null) return useOnPage({ ctx, selector, page, account, kind, sleep, log, progress, api: null, timeZone })
  const wanted = organization.name ?? organization.uuid
  const before = await grantsOf(ctx, selector, page, organization.uuid, timeZone)
  if (before.signedOut) return signedOut
  if (before.failed) {
    say(`claude.ai's data was not read: ${before.failed}`)
    if (several) return { ok: false, clicked: false, message: couldNotSwitch(wanted) }
    return useOnPage({ ctx, selector, page, account, kind, sleep, log, progress, api: null, timeZone })
  }
  const listed = before.data.organizations.some((o) => o.uuid === organization.uuid)
  if (!listed) return { ok: false, clicked: false, message: `claude.ai does not list ${wanted} for ${account}'s login` }
  const api = before.reading === null ? null : { uuid: organization.uuid, reading: before.reading }
  const previous = before.data.selectedOrg
  if (previous === organization.uuid) return useOnPage({ ctx, selector, page, account, kind, sleep, log, progress, api, timeZone })
  if (api === null) {
    say(`the limit resets of ${wanted} were not read from claude.ai's data, so its selection cannot be checked`)
    return { ok: false, clicked: false, message: couldNotSwitch(wanted) }
  }
  say(`selecting ${wanted} on claude.ai (${previous === null ? 'none' : 'another organization'} was selected)`)
  try {
    const selected = await select(ctx, selector, page, organization.uuid)
    if (!selected.ok) {
      say(`the organization was not selected: ${selected.message}`)
      return { ok: false, clicked: false, message: couldNotSwitch(wanted) }
    }
    const moved = await orcaCall(ctx, ['goto', '--page', page, '--worktree', selector, '--url', USAGE_URL])
    if (!moved.ok) {
      say(`the Usage page was not reloaded: ${moved.message}`)
      return { ok: false, clicked: false, message: couldNotSwitch(wanted) }
    }
    await waitForUsage(ctx, selector, page)
    const after = await grantsOf(ctx, selector, page, organization.uuid, timeZone)
    const shown = await describePage(ctx, selector, page)
    const parsed = shown.ok ? parseUsagePage(shown.value.text, { url: shown.value.url }) : null
    const agrees = after.data?.selectedOrg === organization.uuid && after.reading !== null && parsed !== null && parsed.loaded
      && parsed.full === after.reading.full && parsed.model === after.reading.model
    if (!agrees) {
      say(`after the reload claude.ai ${after.data?.selectedOrg === organization.uuid ? 'selects' : 'does not select'} ${wanted}, and its page ${parsed?.loaded ? `counts ${parsed.full ?? '?'} full and ${parsed.model ?? '?'} model resets against ${after.reading?.full ?? '?'} and ${after.reading?.model ?? '?'}` : 'did not load'}: nothing is clicked`)
      return { ok: false, clicked: false, message: couldNotSwitch(wanted) }
    }
    say(`claude.ai shows ${wanted}`)
    return await useOnPage({ ctx, selector, page, account, kind, sleep, log, progress, api: { uuid: organization.uuid, reading: after.reading }, timeZone })
  } finally {
    const back = await select(ctx, selector, page, previous)
    say(back.ok ? `the selection on claude.ai was put back` : `the selection on claude.ai was not put back: ${back.message}`)
  }
}

// Selects the organization on claude.ai (null: none), and reads the selection back. { ok } or { ok: false, message }.
async function select(ctx, selector, page, uuid) {
  let answer
  try {
    answer = await orcaCall(ctx, ['eval', '--page', page, '--worktree', selector, '--expression', selectOrganizationExpression(uuid)])
  } catch (err) {
    return { ok: false, message: describe(err) }
  }
  if (!answer.ok) return { ok: false, message: answer.message }
  try {
    const value = JSON.parse(answer.result?.result)
    if (value?.selected === uuid) return { ok: true }
    return { ok: false, message: 'the cookie did not read back as set' }
  } catch {
    return { ok: false, message: 'Orca returned no answer from the page' }
  }
}

// The page described by its script: { ok, value } or { ok: false, message }. Never throws.
async function describePage(ctx, selector, page) {
  return runOp(ctx, selector, page, 'describe')
}

async function runOp(ctx, selector, page, op, arg) {
  let answer
  try {
    answer = await orcaCall(ctx, ['eval', '--page', page, '--worktree', selector, '--expression', pageExpression(op, arg)])
  } catch (err) {
    return { ok: false, message: describe(err) }
  }
  if (!answer.ok) return { ok: false, message: answer.message }
  try {
    const value = JSON.parse(answer.result?.result)
    if (value !== null && typeof value === 'object') return { ok: true, value }
  } catch {}
  return { ok: false, message: 'Orca returned no answer from the page' }
}

// api, when the account's organization is known and its grants were read, is { uuid, reading }: the counts before the
// click and the check after it come from the grants; the page's counts stand in without it.
async function useOnPage({ ctx, selector, page, account, kind, sleep, log, progress, api, timeZone }) {
  const say = (msg) => log(`grazr limit reset: ${account}: ${msg}`)
  // Never throws: after the click a failure must still end as "not confirmed", never as "not used".
  const run = (op, arg) => runOp(ctx, selector, page, op, arg)
  // A reading of the page is filed under the organization it was checked to show.
  const pageOutcome = (parsed) => (api !== null ? { ...okOutcome(parsed), source: 'page', organizationUuid: api.uuid } : okOutcome(parsed))

  const before = await run('describe')
  if (!before.ok) return { ok: false, clicked: false, message: before.message }
  const parsedBefore = parseUsagePage(before.value.text, { url: before.value.url })
  if (parsedBefore.signedIn === false) {
    return { ok: false, clicked: false, outcome: { state: 'signed-out' }, message: `${account} is signed out of claude.ai in its browser profile: open claude.ai for it and sign in once` }
  }
  const beforeOutcome = api !== null ? api.reading : pageOutcome(parsedBefore)
  if (!parsedBefore.loaded) return { ok: false, clicked: false, message: `the usage page of ${account} did not load` }
  const noReset = { ok: false, clicked: false, message: `claude.ai shows no ${kindWord(kind)} reset for ${account} right now` }
  if (!before.value.section) return { ...noReset, outcome: beforeOutcome }
  if (!known(before.value, parsedBefore)) return { ok: false, clicked: false, message: `the usage page of ${account} did not show its limit resets in a known form` }
  const chosen = chooseRow(before.value.rows ?? [], kind)
  if (chosen.none) return { ...noReset, outcome: beforeOutcome }
  if (chosen.several) return { ok: false, clicked: false, message: `claude.ai shows several ${kindWord(kind)} resets for ${account}; use one there` }
  let { row } = chosen
  const label = `${row.reset.label} reset`
  if (row.buttons !== 1) return { ok: false, clicked: false, label, message: `the ${label} of ${account} has no single Reset for free button on claude.ai` }
  if (row.disabled) {
    const focused = await run('focus')
    say(focused.ok ? `Reset for free on "${row.title}" is greyed out: the page is given focus` : `the page could not be given focus: ${focused.message}`)
    let focus = focused.ok ? focused.value : before.value.focus
    // Only the row the worker chose, under the same title, counts once enabled.
    for (let i = 0; i < FOCUS_POLLS && row.disabled; i++) {
      await sleep(POLL_MS)
      const seen = await run('describe')
      if (!seen.ok) continue
      focus = seen.value.focus ?? focus
      const again = (seen.value.rows ?? [])[row.index]
      if (again && again.title === row.title && again.buttons === 1) row = { ...row, disabled: again.disabled, reason: again.reason }
    }
    if (row.disabled) {
      say(`Reset for free on "${row.title}" stayed greyed out for ${(FOCUS_POLLS * POLL_MS) / 1000} s after focus (hasFocus ${focus?.hasFocus ?? 'unknown'}, visibility ${focus?.visibility ?? 'unknown'})`)
      return { ok: false, clicked: false, label, outcome: beforeOutcome, message: row.reason ? `${NOTHING_TO_RESET} (${row.reason})` : NOTHING_TO_RESET }
    }
    say(`Reset for free on "${row.title}" is enabled`)
  }
  const was = api !== null ? countOf(api.reading, kind) : countOf(parsedBefore, kind)
  say(`clicking Reset for free on "${row.title}" (${was} ${kindWord(kind)} before)`)
  progress.clicked = null
  const clicked = await run('click-row', { index: row.index, title: row.title })
  // An eval that failed may still have clicked, so it is never taken as "nothing done".
  if (!clicked.ok) return { ok: false, clicked: null, label, message: `${UNCONFIRMED} (${clicked.message})` }
  if (!clicked.value.clicked) {
    if (clicked.value.disabled) return { ok: false, clicked: false, label, outcome: beforeOutcome, message: NOTHING_TO_RESET }
    return { ok: false, clicked: false, label, message: `nothing was clicked: ${clicked.value.reason}` }
  }

  let confirmed = false
  let agreeing = 0
  let status = ''
  let last = null
  let apiLast = null
  const shown = new Set()
  for (let i = 0; i < POLLS; i++) {
    await sleep(POLL_MS)
    const seen = await run('describe')
    if (!seen.ok) {
      say(`the page could not be read after the click: ${seen.message}`)
      continue
    }
    const view = seen.value
    if (view.status && view.status !== status) say(`the page says: ${view.status}`)
    status = view.status || status
    const dialogs = Array.isArray(view.dialogs) ? view.dialogs : []
    for (const d of dialogs) {
      const key = `${d.text} | ${(d.buttons ?? []).map((b) => b.text).join(' / ')}`
      if (!shown.has(key)) say(`a ${d.role ?? 'dialog'} showed: "${d.text}", buttons: ${(d.buttons ?? []).map((b) => `"${b.text}"${b.disabled ? ' (disabled)' : ''}`).join(', ') || 'none'}`)
      shown.add(key)
    }
    if (api !== null) {
      const now = await grantsOf(ctx, selector, page, api.uuid, timeZone)
      if (now.reading && countOf(now.reading, kind) < was) {
        say(`claude.ai's data now counts ${countOf(now.reading, kind)} ${kindWord(kind)} (was ${was}): the reset was used`)
        return { ok: true, clicked: true, label, outcome: now.reading, was, now: countOf(now.reading, kind) }
      }
      if (now.reading) apiLast = now.reading
    }
    const parsed = parseUsagePage(view.text, { url: view.url })
    if (known(view, parsed)) last = parsed
    if (known(view, parsed) && countOf(parsed, kind) < was) {
      agreeing += 1
      if (agreeing >= AGREEING) {
        say(`claude.ai now counts ${countOf(parsed, kind)} ${kindWord(kind)} (was ${was}): the reset was used`)
        return { ok: true, clicked: true, label, outcome: pageOutcome(parsed), was, now: countOf(parsed, kind) }
      }
      continue
    }
    agreeing = 0
    if (confirmed) continue
    const picks = dialogs.map((d, index) => ({ index, button: confirmButton(d) })).filter((p) => p.button !== null)
    if (picks.length !== 1) continue
    const [pick] = picks
    const text = dialogs[pick.index].buttons[pick.button].text
    // One confirmation at most: a second click could spend a second reset.
    confirmed = true
    const answer = await run('click-confirm', { dialog: pick.index, button: pick.button, text })
    say(answer.ok && answer.value.clicked ? `clicked "${text}" in the dialog` : `the dialog's "${text}" was not clicked: ${answer.ok ? answer.value.reason : answer.message}`)
  }
  say(`no lower count within ${(POLLS * POLL_MS) / 1000} s`)
  const said = status ? ` (claude.ai says: ${status})` : ''
  const outcome = apiLast ?? (last ? pageOutcome(last) : null)
  return { ok: false, clicked: true, label, ...(outcome ? { outcome } : {}), message: `${UNCONFIRMED}${said}` }
}
