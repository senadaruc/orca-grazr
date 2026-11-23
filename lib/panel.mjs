import * as nodeFs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { polar, arcPath, widthOf, chordAt, fitText } from './clock.mjs'
import { DEFAULT_SETTINGS } from './hosts.mjs'
import { PALETTE } from './palette.mjs'
import { unavailableText } from './limit-reset-grants.mjs'

export { arcPath, widthOf, chordAt, fitText } from './clock.mjs'

const RING = { cx: 110, cy: 110, r: 80, gap: 4 }
const BADGE_R = 100
const SKIP_CODES = new Set(['EACCES', 'EROFS', 'EPERM', 'ENOENT'])
// The centre percentage tones from centre() in lib/panel-data.mjs; anything else is drawn as none.
const TONES = new Set(['fine', 'warning', 'spent', 'blocked', 'none'])

const text = (s) => String(s ?? '')

// lib/clock.mjs is inlined into the page's module script, so its text is read once and carries no imports.
const CLOCK_SOURCE = readFileSync(new URL('./clock.mjs', import.meta.url), 'utf8')

export const escapeHtml = (s) => text(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// The model rings' geometry on the 220 box: a 5-wide track, 5 below the main ring's edge and 3 between rings.
const MODEL_WIDTH = 5
const MODEL_RINGS = 3
const modelRadius = (i) => RING.r - 7 - 5 - 2.5 - i * 8

// A tooltip line is left out when its value is missing or empty: the page reads an absent attribute as an empty line.
const tipAttrs = (pairs) => pairs.filter(([, value]) => value !== null && value !== undefined && String(value) !== '')
  .map(([key, value]) => ` data-tip-${key}="${escapeAttr(value)}"`).join('')

// The swap tick's wording: under the threshold it reads below the tick in the warning tone, else the rule. No threshold, no tick.
function tickOf(remaining, threshold) {
  if (!Number.isFinite(threshold)) return { tick: '', tone: null }
  // Compared as shown: a reading that rounds to the threshold is not below it.
  if (typeof remaining === 'number' && Math.round(remaining) < threshold) return { tick: `below the ${threshold}% swap tick`, tone: 'warning' }
  return { tick: `tick: grazr swaps below ${threshold}%`, tone: null }
}

// Equal segments with a gap centred on each boundary; the fill arc shows the active account's remaining share.
// key is the view's window: the main ring's tooltip titles it, and the 5-hour view has no model rings.
export function ringSvg(view, key = 'weekly') {
  const segments = view.segments ?? []
  const { cx, cy, r, gap } = RING
  const step = segments.length ? 360 / segments.length : 0
  const models = Array.isArray(view.models) ? view.models : []
  const rings = Math.min(models.length, MODEL_RINGS)
  // The needle reaches in to the innermost model ring; with no model rings it keeps its reach to 66, as the dial always drew it.
  const innerEdge = rings > 0 ? modelRadius(rings - 1) - 2.5 : 73
  const needleFrom = rings > 0 ? innerEdge - 3 : 66
  const parts = []
  const badges = []
  const c = view.centre ?? {}
  const tone = TONES.has(c.tone) ? c.tone : 'none'
  const title = key === 'session' ? '5-hour window' : 'All models'
  // The active slice reads as time used, clockwise: the needle stands at what has been used, and the arc from it to the slice end is what is left.
  let active = null
  segments.forEach((seg, i) => {
    const start = i * step + gap / 2
    const end = start + step - gap
    const dash = seg.state === 'next' ? ' stroke-dasharray="6 4"' : ''
    // The tooltip's lines: the account-wide window, its reading, the row tone, the account, the swap threshold and the reset.
    const tickInfo = tickOf(seg.remaining, view.threshold)
    const tip = tipAttrs([
      ['label', title],
      ['left', typeof seg.remaining === 'number' ? `${Math.round(seg.remaining)}% left` : (seg.noLimitText ?? 'no reading')],
      ['tone', seg.tone],
      ['name', seg.name],
      ['tick', tickInfo.tick],
      ['tick-tone', tickInfo.tone],
      ['resets', seg.resets ? `resets ${seg.resets}` : ''],
    ])
    parts.push(`<path class="seg seg-${escapeAttr(seg.state)}" fill="none" stroke-width="14"${dash}${tip} d="${arcPath(cx, cy, r, start, end)}"/>`)
    if (seg.state === 'active') {
      const share = typeof seg.remaining === 'number' ? Math.min(Math.max(seg.remaining, 0), 100) / 100 : null
      active = { start, end, needle: share === null ? null : start + (1 - share) * (end - start) }
      if (share !== null && share > 0) {
        parts.push(`<path class="fill fill-${escapeAttr(tone)}" fill="none" stroke-width="14" d="${arcPath(cx, cy, r, active.needle, end)}"/>`)
      }
    }
    // Each model ring: its track, the fill of the account's reading, and the swap tick. The fill sits on the track, so it carries the same tooltip.
    for (let k = 0; k < rings; k++) {
      const radius = modelRadius(k)
      const m = seg.models?.[k] ?? { scope: models[k], remaining: null, resets: null, tone: 'none' }
      const reading = typeof m.remaining === 'number' ? m.remaining : null
      const modelTick = tickOf(reading, view.threshold)
      const modelTip = tipAttrs([
        ['label', m.scope],
        ['left', reading === null ? 'no reading' : `${Math.round(reading)}% left`],
        ['tone', m.tone],
        ['name', seg.name],
        ['tick', modelTick.tick],
        ['tick-tone', modelTick.tone],
        ['resets', m.resets ? `resets ${m.resets}` : ''],
      ])
      parts.push(`<path class="mseg mseg-track" stroke-width="${MODEL_WIDTH}"${modelTip} d="${arcPath(cx, cy, radius, start, end)}"/>`)
      if (reading !== null && reading > 0) {
        const share = Math.min(Math.max(reading, 0), 100) / 100
        const from = start + (1 - share) * (end - start)
        const dim = seg.usable === false ? ' dim' : ''
        const fillTone = TONES.has(m.tone) ? m.tone : 'none'
        // The fill carries no tooltip: the track under it does, and the fill passes hover through (pointer-events none).
        parts.push(`<path class="mseg mseg-fill tone-${fillTone}${dim}" stroke-width="${MODEL_WIDTH}" d="${arcPath(cx, cy, radius, from, end)}"/>`)
      }
      if (Number.isFinite(view.threshold)) {
        const percent = Math.min(Math.max(view.threshold, 0), 100)
        const at = start + (1 - percent / 100) * (end - start)
        const [x1, y1] = polar(cx, cy, radius - 4, at)
        const [x2, y2] = polar(cx, cy, radius + 4, at)
        parts.push(`<line class="mtick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
      }
    }
    const [bx, by] = polar(cx, cy, BADGE_R, start + (end - start) / 2)
    badges.push(`<text class="badge" x="${bx}" y="${by}" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`)
  })
  // The threshold is clamped to a percentage, so an out-of-range value sits at a slice end rather than off the slice.
  if (active && Number.isFinite(view.threshold)) {
    const percent = Math.min(Math.max(view.threshold, 0), 100)
    const tick = active.start + (1 - percent / 100) * (active.end - active.start)
    const [x1, y1] = polar(cx, cy, 70, tick)
    const [x2, y2] = polar(cx, cy, 90, tick)
    parts.push(`<line class="threshold-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
  }
  if (active && active.needle !== null) {
    const [x1, y1] = polar(cx, cy, needleFrom, active.needle)
    const [x2, y2] = polar(cx, cy, 93, active.needle)
    parts.push(`<line class="needle" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
    parts.push(`<circle class="needle-dot" cx="${x1}" cy="${y1}" r="3.5"/>`)
  }
  // With model lines the centre is laid out one step taller: the name and percentage move up to make room.
  const modelLines = Array.isArray(c.models) ? c.models.slice(0, 2) : []
  const lines = modelLines.length > 0
    ? { name: 90, pct: 112, hint: 148, next: 158, nextName: 169 }
    : { name: 92, pct: 120, hint: 140, next: 150, nextName: 162 }
  // The next account is two lines; with none, both lines take the muted colour.
  const nextMuted = c.nextName ? '' : ' none'
  const nextName = c.nextName ? text(c.nextName) : 'none'
  const modelYs = [126, 136]
  const modelTexts = modelLines.map((line, k) => {
    const full = `${text(line.scope)} ${text(line.left)}% left`
    const y = modelYs[k]
    const lineTone = TONES.has(line.tone) ? line.tone : 'none'
    return `<text class="centre-model tone-${lineTone}" x="110" y="${y}" font-size="10" text-anchor="middle"><title>${escapeHtml(full)}</title>${escapeHtml(fitText(full, { y, size: 10 }))}</text>`
  })
  const centreText = [
    `<text class="centre-name" x="110" y="${lines.name}" font-size="12" text-anchor="middle"><title>${escapeHtml(c.name)}</title>${escapeHtml(fitText(c.name, { y: lines.name, size: 12 }))}</text>`,
    `<text class="centre-pct tone-${tone}" x="110" y="${lines.pct}" font-size="20" text-anchor="middle">${escapeHtml(c.percentText)}</text>`,
    ...modelTexts,
    `<text class="centre-hint" x="110" y="${lines.hint}" font-size="10" text-anchor="middle">${escapeHtml(fitText(c.hint, { y: lines.hint, size: 10 }))}</text>`,
    `<text class="centre-next${nextMuted}" x="110" y="${lines.next}" font-size="10" text-anchor="middle">next ▸</text>`,
    `<text class="centre-next-name${nextMuted}" x="110" y="${lines.nextName}" font-size="10" text-anchor="middle"><title>${escapeHtml(nextName)}</title>${escapeHtml(fitText(nextName, { y: lines.nextName, size: 10 }))}</text>`,
  ]
  return `<svg viewBox="0 0 220 220">${parts.join('')}${badges.join('')}${centreText.join('')}</svg>`
}

// A button runs its command in the worker (plugin.request on Orca 1.4.246+, else commands.execute): data-command is the id
// and data-params its JSON. data-text is the command a button names for one account (swap to one account has no palette form).
// data-palette is the Cmd-J title the page names when the host runs it neither way (official Orca before 1.4.246);
// title is the hover text saying what the button does.
// A button whose command text is missing is left out, so the page never offers a button that does nothing; '' is a
// command with no text (Open claude.ai), and it stays.
function button(kind, host, command, label, { id, params, palette, hint }) {
  if (command === undefined || command === null) return ''
  const attrs = `data-host="${escapeAttr(host)}" data-text="${escapeAttr(command)}"`
    + ` data-command="${escapeAttr(id)}" data-params="${escapeAttr(JSON.stringify(params))}"`
    + ` data-palette="${escapeAttr(palette)}" title="${escapeAttr(hint)}"`
  return `<button class="act act-${kind}" ${attrs}>${escapeHtml(label)}</button>`
}

const swapHint = (host, account) => `Make ${account} the active account on ${host} now`
const reauthHint = (account) => `Open a terminal to log in to ${account} again; its saved login no longer works`

// Opens claude.ai as the account in its own browser profile. Every enrolled account has one; a placeholder has none.
// It has no terminal form, so its command text is empty. page says the account's usage page could not be read
// ('signed-out' or 'no-profile'); the hover text asks for the one sign-in that lets Grazr see its limit resets.
function browserButton(host, account, missing, page = null) {
  if (missing) return ''
  const hint = page === null
    ? `Open claude.ai in a browser profile signed in as ${account}`
    : `Open claude.ai in the browser profile of ${account}. Sign in here once so Grazr can see this account's limit resets`
  return button('browser', host, '', 'Open claude.ai', { id: 'open-browser', params: { host, account }, palette: PALETTE['open-browser'], hint })
}

// Signs in another organization of a login, picked on claude.ai's own page, and enrols it under a name of its own. It
// has no terminal form. A login without a known e-mail has none.
function organizationButton(host, email) {
  if (typeof email !== 'string' || email === '') return ''
  const hint = `Sign in to another organization of ${email} on claude.ai (pick it there) and add it as an account on ${host}`
  return button('organization', host, '', 'Sign in another organization…', { id: 'sign-in-organization', params: { host, email }, palette: PALETTE['sign-in-organization'], hint })
}

// The kinds the usage page listed, short: "1 full reset, expires Dec 10, 11:00 PM GMT+1 · 2 Fable resets, all expire …".
export function resetSummary(counts) {
  const kinds = Array.isArray(counts?.kinds) ? counts.kinds.filter((k) => Number.isInteger(k?.count)) : []
  return kinds.map((k) => {
    const what = `${k.count} ${k.kind === 'full' ? 'full' : text(k.label)} reset${k.count === 1 ? '' : 's'}`
    const expires = typeof k.expires === 'string' && k.expires !== '' ? `, ${k.expires.charAt(0).toLowerCase()}${k.expires.slice(1)}` : ''
    return what + expires
  }).join(' · ')
}

// How many resets the page counted, as the chip and the row say it.
const resetCount = (counts) => {
  const total = counts.full + counts.model
  return `${total} reset${total === 1 ? '' : 's'} available`
}

// A button that cannot be pressed now, with claude.ai's reason as its hover text. It runs nothing, and the page keeps it
// disabled (data-unavailable) when it re-enables a card's buttons.
function unavailableButton(kind, host, label, hint) {
  return `<button class="act act-${kind}" data-host="${escapeAttr(host)}" disabled data-unavailable="" title="${escapeAttr(hint)}">${escapeHtml(label)}</button>`
}

// An account's two resets, used on claude.ai in one press (no terminal form, so no command text), in its login's browser
// profile and on its organization. A parked account's reset is used for it where it stays: Switch moves to it. A parked
// account offers them only where a reset is known; the active one also offers them when nothing is known (`unknown`),
// since Claude's note lapses after three days. counts, from the account's reading, keep each button to a kind it
// counted; a kind claude.ai counts but does not let be used now shows disabled, with its reason.
function resetButtons(host, account = null, { unknown = false, counts = null } = {}) {
  const params = account === null ? { host } : { host, account }
  const whose = account === null ? 'this account' : account
  const stays = account === null ? '' : `; ${account} stays parked (Switch moves to it)`
  const known = unknown ? ' if claude.ai offers one' : ''
  const hint = (what) => `Uses the ${what} reset of ${whose} now on claude.ai${known}, without asking again${stays}`
  const model = counts === null || counts.model > 0
  const labels = new Set((counts?.kinds ?? []).filter((k) => k.kind === 'model' && k.label).map((k) => k.label))
  const modelName = labels.size === 1 ? [...labels][0] : 'Model'
  const full = counts === null || counts.full > 0
  const off = (kind) => counts !== null && counts.usableNow?.[kind] === false
  const reason = (kind) => unavailableText((counts?.kinds ?? []).find((k) => k.kind === kind && k.usableNow === false)?.unavailableReason ?? null)
  const one = (kind, label, id, what) => (off(kind)
    ? unavailableButton('reset', host, label, reason(kind))
    : button('reset', host, '', label, { id, params, palette: PALETTE[id], hint: hint(what) }))
  return (model ? one('model', `${modelName} reset`, 'limit-reset-model', modelName === 'Model' ? 'model' : modelName) : '')
    + (full ? one('full', 'Full reset', 'limit-reset-full', 'full') : '')
}

// Signs in a discovered organization of a login that can run Claude Code, targeted at it on claude.ai's authorize page.
function discoveredSignIn(host, entry) {
  if (entry.discovered !== true || entry.claudeCode === false || typeof entry.organizationUuid !== 'string' || typeof entry.email !== 'string') return ''
  const what = entry.orgLabel ?? 'this organization'
  const hint = `Sign in to ${what} of ${entry.email} on claude.ai (pick it there if asked) and add it as an account on ${host}`
  return button('organization', host, '', 'Sign in…', { id: 'sign-in-organization', params: { host, email: entry.email, organization: entry.organizationUuid }, palette: PALETTE['sign-in-organization'], hint })
}

// The list face's reset chip: how many and until when once the usage page was read, else Claude's note alone.
function resetChip(counts) {
  if (counts === null) return '<span class="chip chip-on">Reset available</span>'
  return `<span class="chip chip-on" title="${escapeAttr(resetSummary(counts))}">${escapeHtml(resetCount(counts))}</span>`
}

// What a discovered organization that is not enrolled says in place of a reading.
const discoveredText = (entry) => entry.reason ?? (entry.claudeCode === false ? 'no Claude Code' : 'not signed in')

// The name a row or card shows: an organization of a login shown under its e-mail names its organization and plan; its
// account name stays the hover text.
function shownName(entry, member, klass) {
  if (member && entry.orgLabel) return `<span class="${klass}" title="${escapeAttr(entry.name)}">${escapeHtml(entry.orgLabel)}</span>`
  return `<span class="${klass}">${escapeHtml(entry.name)}</span>`
}

// The groups of two or more organizations of one login, by the position of their first member; a login with one
// account has none, and is drawn as it always was.
const sharedGroups = (groups) => new Map((Array.isArray(groups) ? groups : []).filter((g) => g.size > 1).map((g) => [g.start, g]))

// One account of the list face: its name and chips, its action, the organisation, a bar per window and the reading's age.
// member marks an organization shown under its login's e-mail: its organization and plan are its name.
function accountMarkup(account, host, cmd, member = false) {
  const found = account.discovered === true
  const state = account.active ? 'active' : account.blocked !== null ? 'blocked' : account.missing ? 'missing' : found ? 'discovered' : 'ok'
  const named = member && account.orgLabel
  const chips = [
    account.plan && !named ? `<span class="chip chip-muted">${escapeHtml(account.plan)}</span>` : '',
    account.active ? '<span class="chip chip-on">Active</span>' : '',
    account.blocked !== null ? `<span class="chip chip-blocked">Blocked: ${escapeHtml(account.blocked)}</span>` : '',
    account.reset === true ? resetChip(account.resetCounts ?? null) : '',
    account.listed ? '' : '<span class="chip chip-muted">Not in ACCOUNTS</span>',
    account.missing ? '<span class="chip chip-muted">not enrolled</span>' : '',
    found ? `<span class="chip chip-muted">${escapeHtml(discoveredText(account))}</span>` : '',
  ].join('')
  const swapText = Object.hasOwn(cmd.swapTo ?? {}, account.name) ? cmd.swapTo[account.name] : undefined
  let action = ''
  if (account.action === 'switch') action = button('swap-to', host, swapText, 'Switch', { id: 'swap', params: { host, account: account.name }, palette: PALETTE.swap, hint: swapHint(host, account.name) })
  else if (account.action === 'reauth') action = button('reauth', host, cmd.enrol, 'Re-authenticate…', { id: 'enrol', params: { host, account: account.name }, palette: PALETTE.reauth, hint: reauthHint(account.name) })
  const counts = account.resetCounts ?? null
  const resets = account.resetsSupported !== false
  if (resets && account.active && account.reset !== false) action += resetButtons(host, null, { unknown: account.reset === null, counts })
  else if (resets && account.action === 'switch' && account.reset === true) action += resetButtons(host, account.name, { counts })
  action += browserButton(host, account.name, account.missing || found, account.resetPage ?? null)
  action += discoveredSignIn(host, account)
  // A login with one account offers its other organizations here; a group offers them on its header.
  if (!member && !account.missing && !found) action += organizationButton(host, account.email)
  const org = account.organization !== null && !named ? `<p class="acct-org">${escapeHtml(account.organization)}</p>` : ''
  const windows = account.windows.map((w) => {
    // The bar is clamped to its track; the text still reads the value.
    const width = Math.max(0, Math.min(100, w.left))
    return `<div class="win"><span class="win-label">${escapeHtml(w.label)}</span>`
      + `<span class="win-left tone-${escapeAttr(w.tone)}">${w.left}% left</span><span class="win-reset">${escapeHtml(w.reset)}</span>`
      + `<div class="bar"><div class="bar-fill tone-${escapeAttr(w.tone)}" style="width:${width}%"></div></div></div>`
  }).join('')
  const reading = account.updated !== null ? `<p class="reading" data-updated="${escapeAttr(account.updated)}"></p>` : ''
  return `<article class="acct acct-${state}"><div class="acct-head">${shownName(account, member, 'acct-name')}`
    + `${chips}<span class="spacer"></span>${action}</div>${org}${windows}${reading}</article>`
}

// The list face: one article per account, in the order the account list gives; the organizations of one login sit
// together under its e-mail.
function listMarkup(list, host, cmd) {
  const heads = sharedGroups(list.groups)
  const parts = []
  for (let i = 0; i < list.accounts.length;) {
    const head = heads.get(i)
    if (head === undefined) {
      parts.push(accountMarkup(list.accounts[i], host, cmd))
      i++
      continue
    }
    const members = list.accounts.slice(i, i + head.size).map((account) => accountMarkup(account, host, cmd, true)).join('')
    const head3 = `<h3 class="acct-group-head"><span class="group-name">${escapeHtml(head.label)}</span><span class="spacer"></span>${organizationButton(host, head.email)}</h3>`
    parts.push(`<section class="acct-group">${head3}${members}</section>`)
    i += head.size
  }
  return `<div class="list">${parts.join('')}</div>`
}

// A login's header in the row list: its e-mail, before the first of its organizations, and the sign-in of another one.
const groupHeadMarkup = (group, host) => `<li class="group-head"><span class="group-name">${escapeHtml(group.label)}</span>`
  + `<span class="spacer"></span>${organizationButton(host, group.email)}</li>`

function rowMarkup(row, host, cmd, member = false) {
  const swapText = Object.hasOwn(cmd.swapTo ?? {}, row.name) ? cmd.swapTo[row.name] : undefined
  const found = row.discovered === true
  let action = ''
  if (row.blocked) action = button('reauth', host, cmd.enrol, 'Re-authenticate…', { id: 'enrol', params: { host, account: row.name }, palette: PALETTE.reauth, hint: reauthHint(row.name) })
  else if (!found && row.status !== 'active' && row.status !== 'not-enrolled') action = button('swap-to', host, swapText, 'Swap to', { id: 'swap', params: { host, account: row.name }, palette: PALETTE.swap, hint: swapHint(host, row.name) })
  const counts = row.resetCounts ?? null
  const resets = row.resetsSupported !== false
  if (resets && row.isActive && row.reset !== false) action += resetButtons(host, null, { unknown: row.reset === null, counts })
  else if (resets && row.reset === true && !row.blocked && row.status !== 'not-enrolled') action += resetButtons(host, row.name, { counts })
  action += browserButton(host, row.name, row.status === 'not-enrolled' || found, row.resetPage ?? null)
  action += discoveredSignIn(host, row)
  // A row's buttons share one strip under its name; a row with none has no strip.
  const acts = action === '' ? '' : `<span class="row-acts">${action}</span>`
  const pct = row.percent === null ? '—' : `${row.percent}%`
  const reset = row.reset !== true ? '' : counts === null ? 'reset available' : resetCount(counts)
  const resetTip = row.reset === true && counts !== null ? ` title="${escapeAttr(resetSummary(counts))}"` : ''
  // The clock recolours the row numbers per account, with the same five hues as its ring, by rotation slot so a swap keeps them.
  // A discovered organization is not in the rotation, so it has no number.
  const index = row.index === null ? '<span class="row-index"></span>' : `<span class="row-index acct-${(((row.slot ?? row.index) - 1) % 5) + 1}">${row.index}</span>`
  return `<li class="row row-${escapeAttr(row.status)}${member ? ' row-member' : ''}">${index}`
    + `${shownName(row, member, 'row-name')}<span class="row-pct">${pct}</span>`
    + `<span class="row-label"${resetTip}>${escapeHtml([row.label, reset].filter(Boolean).join(' · '))}</span>${acts}</li>`
}

function viewBlock(key, view, host, cmd) {
  // The organizations of one login follow its e-mail; a login with one account has no header.
  const heads = sharedGroups(view.groups)
  let groupEnd = -1
  const rows = view.rows.map((row, i) => {
    const head = heads.get(i)
    if (head !== undefined) groupEnd = i + head.size
    return (head !== undefined ? groupHeadMarkup(head, host) : '') + rowMarkup(row, host, cmd, i < groupEnd)
  }).join('')
  // The weekly dial names what its inner rings are; the note shows only on the dial face (CSS).
  const models = key === 'weekly' && Array.isArray(view.models) ? view.models : []
  const note = models.length > 0 ? `<p class="dial-note">Outer ring: all models · inner: ${escapeHtml(models.join(', '))}</p>` : ''
  return `<div class="view-${key}"><div class="dial">${ringSvg(view, key)}</div>${note}<div class="clock" data-span="${key}"></div>`
    + `<p class="clock-note">Projected at the current pace</p><ul class="rows">${rows}</ul></div>`
}

// The status time in the zone given, 24 h, as the page's header shows it. Null when there is no time.
export function clockOf(iso, timeZone) {
  if (typeof iso !== 'string') return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date)
}

// The engine's line under the thresholds, and the default message while the installed engine is behind the bundled one.
// The target's message says how to update it; another host's says to target through to it first.
function engineParts(host) {
  const engine = host.reachable ? host.engine : null
  if (!engine) return { line: '', message: '', chip: '' }
  const installed = engine.installed ?? '—'
  const line = `<p class="engine">engine ${escapeHtml(installed)}</p>`
  if (!engine.outdated) return { line, message: '', chip: '' }
  const how = host.open
    ? 'Install engine on target'
    : `Target → next host until ${host.name}, then Grazr: Install engine on target`
  return {
    line,
    message: `Engine ${installed} · ${engine.bundled} bundled — Cmd-J › Grazr: ${how}`,
    chip: '<span class="chip chip-outdated">engine update available</span>',
  }
}

// The face and window a card opens with: a value outside its choices is the settings default.
const choiceOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

// host.open marks the selected host; renderPanel sets it. Each card is the tabpanel of its host's tab: the selected one shows,
// the others carry the hidden attribute. The page moves the selection with its tabs, and the card's name is the tab's.
// slot numbers the card and its tab (their ids); timeZone is the zone the updated time is shown in, else the system zone.
export function renderCard(host, commands = {}, { timeZone, slot = 0 } = {}) {
  const cmd = commands[host.name] ?? {}
  const face = choiceOf(host.face, ['dial', 'clock', 'list'], DEFAULT_SETTINGS.panelFace)
  const view = choiceOf(host.view, ['session', 'weekly'], DEFAULT_SETTINGS.panelView)
  const attr = escapeAttr(host.name)
  const chip = `<span class="chip chip-${escapeAttr(host.chip.kind)}">${escapeHtml(host.chip.label)}</span>`
  const engine = engineParts(host)
  const asOf = host.thresholds ? clockOf(host.updatedAt, timeZone) : null
  const ultra = host.ultraNoSession === true ? ' · Ultra: week only' : ''
  const thresholds = host.thresholds
    ? `<p class="thresholds">swaps below ${host.thresholds.session}% 5h · ${host.thresholds.weekly}% week${asOf ? ` · updated ${asOf}` : ''}${ultra}</p>`
    : ''
  const head = `<header class="host-head">${chip}${engine.chip}${thresholds}${engine.line}</header>`
  let body = ''
  const name = host.name
  // Why: Refresh redraws the panel when it answers, so Reload panel stays a palette command for a stuck panel.
  let actions = button('refresh', name, cmd.refresh, 'Refresh', { id: 'refresh', params: { host: name }, palette: PALETTE.refresh, hint: `Ask Claude for fresh usage of every account on ${name}, renew any lapsed login, and redraw the panel` })
  if (host.reachable) {
    body = '<div class="views"><button class="view" data-view="session" title="Show the 5-hour usage window">5h</button>'
      + '<button class="view" data-view="weekly" title="Show the weekly usage window">Week</button><span class="spacer"></span>'
      + '<button class="face" data-face="dial" title="Show how much of the window each account takes, as a dial">Dial</button>'
      + '<button class="face" data-face="clock" title="Show on a clock when each account runs out at the current pace">Clock</button>'
      + '<button class="face" data-face="list" title="Show every account with its usage bars and reset times">List</button></div>'
      + viewBlock('session', host.views.session, host.name, cmd)
      + viewBlock('weekly', host.views.weekly, host.name, cmd)
      + (host.list && typeof host.list === 'object' ? listMarkup(host.list, host.name, cmd) : '')
    const rotation = host.enabled
      ? button('rotation', name, cmd.rotationOff, 'Turn rotation off', { id: 'rotation-toggle', params: { host: name, enabled: false }, palette: PALETTE['rotation-toggle'], hint: `Stop swapping accounts automatically on ${name}` })
      : button('rotation', name, cmd.rotationOn, 'Turn rotation on', { id: 'rotation-toggle', params: { host: name, enabled: true }, palette: PALETTE['rotation-toggle'], hint: `Swap accounts automatically on ${name} when usage drops below the thresholds` })
    actions += button('enrol', name, cmd.enrol, 'Add account…', { id: 'enrol', params: { host: name }, palette: PALETTE['add-account'], hint: `Open a terminal to log in to another Claude account on ${name}` })
      + rotation
      + button('swap', name, cmd.swap, 'Swap to next', { id: 'swap', params: { host: name }, palette: PALETTE.swap, hint: `Switch ${name} now to the account marked NEXT` })
  } else if (host.failure?.detail) {
    body = `<p class="failure">${escapeHtml(host.failure.detail)}</p>`
  }
  const hidden = host.open ? '' : ' hidden'
  return `<section role="tabpanel" class="host" data-host="${attr}" id="host-panel-${slot}" aria-labelledby="host-tab-${slot}"`
    + ` data-view="${escapeAttr(view)}" data-face="${escapeAttr(face)}"${hidden}>${head}${body}`
    + `<div class="actions">${actions}</div><p class="msg" data-host="${attr}">${escapeHtml(engine.message)}</p></section>`
}

// Data is embedded as JSON; '<' is escaped so a name cannot close the script tag.
// The clock source replaces its marker through a function replacer, so a '$' in it is taken literally.
// The clock source goes in first, so a name that contains a marker is never the one replaced.
function fill(template, cards, meta, clockSource) {
  const json = JSON.stringify(meta).replace(/</g, '\\u003c')
  return template.replace('/*__CLOCK__*/', () => clockSource).replace('/*__DATA__*/', () => json)
    .replace('<!--__CARDS__-->', () => cards)
}

// Each reachable host's clock data, keyed by name; an unreachable host (clock null) has none.
const clocksOf = (hosts) => Object.fromEntries(hosts.filter((h) => h.clock !== null && h.clock !== undefined).map((h) => [h.name, { clock: h.clock }]))

// The status dot on a host's tab: on when rotation runs, down when the host cannot be reached or has no engine, else off.
function dotOf(host) {
  const kind = host.chip?.kind
  if (kind === 'unreachable' || kind === 'not-installed') return 'down'
  return kind === 'on' ? 'on' : 'off'
}

// One tab per host, in the hosts' order. The selected tab is the one tabindex 0 (roving tabindex); the page moves it with the arrow keys.
function tabMarkup(host, slot) {
  return `<button role="tab" class="host-tab" data-host="${escapeAttr(host.name)}" id="host-tab-${slot}" aria-controls="host-panel-${slot}"`
    + ` title="Accounts on ${escapeAttr(host.name)}" aria-selected="${host.open ? 'true' : 'false'}" tabindex="${host.open ? 0 : -1}">${escapeHtml(host.name)}`
    + `<span class="host-dot dot-${dotOf(host)}" aria-hidden="true"></span></button>`
}

// The page's parts: main, the tab strip and the cards, and data, what the page script embeds. The target host is
// selected; when the target names no host, the first host is, so one card always shows.
export function renderPanelParts(data, { commands = {}, timeZone } = {}) {
  const selected = data.hosts.some((host) => host.name === data.target) ? data.target : data.hosts[0]?.name
  const hosts = data.hosts.map((host) => ({ ...host, open: host.name === selected, face: data.face, view: host.view ?? data.view }))
  const tabs = hosts.length > 0 ? `<nav class="host-tabs" role="tablist" aria-label="Hosts">${hosts.map(tabMarkup).join('')}</nav>` : ''
  const cards = hosts.map((host, slot) => renderCard(host, commands, { timeZone, slot })).join('\n')
  return { main: tabs + cards, data: { generatedAt: data.generatedAt, target: data.target, hosts: clocksOf(data.hosts) } }
}

export function fillPanel(template, parts, clockSource = CLOCK_SOURCE) {
  return fill(template, parts.main, parts.data, clockSource)
}

export function renderPanel(data, { template, commands = {}, timeZone, clockSource = CLOCK_SOURCE } = {}) {
  return fillPanel(template, renderPanelParts(data, { commands, timeZone }), clockSource)
}

export function placeholderPanel(template, clockSource = CLOCK_SOURCE) {
  const cards = '<section class="placeholder"><p>Waiting for the first status run — open Cmd-J › Grazr: Reload panel</p>'
    + '<p>Installed copies never write this page: Orca verifies their files by hash.</p>'
    + '<p>The panel only updates in a development install, a git checkout added by path.</p></section>'
  return fill(template, cards, { generatedAt: null, target: null, hosts: {} }, clockSource)
}

// Orca installs a plugin into a directory named by the hash of its content, and verifies that content.
const HASH_DIR = /^[0-9a-f]{64}$/

// A development install is a git checkout: a .git entry sits directly in the root and the directory is not Orca's hash-named one.
export async function isDevInstall(root, fs = nodeFs) {
  if (HASH_DIR.test(basename(resolve(root)))) return false
  try {
    await fs.stat(`${root}/.git`)
    return true
  } catch {
    return false
  }
}

// Writes only when the bytes differ. The page goes to a temp file and is renamed over the target,
// so a reader never sees half a file. Only a development install is written: any other root is skipped
// untouched, since writing into an installed copy would break its hash check. A read-only location is skipped too.
export async function writePanel({ root, html, fs = nodeFs }) {
  if (!(await isDevInstall(root, fs))) return 'skipped'
  const file = `${root}/panel/accounts.html`
  const tmp = `${file}.tmp-${process.pid}`
  try {
    let current = null
    try {
      current = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (current === html) return 'unchanged'
    await fs.mkdir(`${root}/panel`, { recursive: true })
    try {
      await fs.writeFile(tmp, html)
      await fs.rename(tmp, file)
    } catch (error) {
      await fs.unlink(tmp).catch(() => {})
      throw error
    }
    return 'written'
  } catch (error) {
    if (SKIP_CODES.has(error.code)) return 'skipped'
    throw error
  }
}
