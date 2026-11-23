// A small DOM, enough for lib/limit-reset-use.mjs's page script, and a claude.ai Usage page built in it as the live page
// is: the Settings dialog holds a "Limit resets" section with one role=group row per reset, each with its title
// (data-testid ce2-type) and one "Reset for free" button. Clicks are recorded; what a click does is up to the test.

class El {
  constructor(tag, attrs = {}, children = [], { text = '', onClick = null } = {}) {
    this.tagName = tag.toUpperCase()
    this.attributes = new Map(Object.entries(attrs))
    this.children = []
    this.parentElement = null
    this.text = text
    this.onClick = onClick
    this.page = null
    for (const child of children) this.append(child)
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  remove() {
    if (!this.parentElement) return
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this)
    this.parentElement = null
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null
    this.children = []
    for (const child of children) this.append(child)
  }

  get innerText() {
    if (this.children.length === 0) return this.text
    return this.children.map((c) => c.innerText).filter(Boolean).join('\n')
  }

  get textContent() {
    return this.innerText
  }

  get disabled() {
    return this.attributes.has('disabled')
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  contains(other) {
    for (let n = other; n; n = n.parentElement) if (n === this) return true
    return false
  }

  closest(selector) {
    for (let n = this; n; n = n.parentElement) if (matches(n, selector)) return n
    return null
  }

  querySelectorAll(selector) {
    const found = []
    const walk = (el) => {
      for (const child of el.children) {
        if (matches(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  click() {
    if (this.tagName === 'BUTTON' && this.disabled) return
    const page = rootOf(this).page
    page?.clicks.push(this.innerText)
    this.onClick?.(page)
  }
}

const rootOf = (el) => {
  let n = el
  while (n.parentElement) n = n.parentElement
  return n
}

// Tag names and [attr], [attr=value], [attr="value"], joined by commas.
function matches(el, selector) {
  return selector.split(',').some((part) => {
    const s = part.trim()
    const attr = s.match(/^\[([\w-]+)(?:=("?)([^"\]]*)\2)?\]$/)
    if (attr) return el.attributes.has(attr[1]) && (attr[3] === undefined || el.attributes.get(attr[1]) === attr[3])
    return el.tagName === s.toUpperCase()
  })
}

export const el = (tag, attrs, children, options) => new El(tag, attrs, children, options)
export const button = (text, attrs = {}, onClick = null) => el('button', { type: 'button', ...attrs }, [el('span', {}, [], { text })], { onClick })

// A background tab's document: visible, never focused. hasFocus is on the prototype, as in a browser.
class Doc {
  constructor(body, page) {
    this.body = body
    this.page = page
    this.visibilityState = 'visible'
  }

  get cookie() {
    const selected = this.page?.orgs?.selected ?? null
    return selected === null ? 'other=1' : `other=1; lastActiveOrg=${selected}`
  }

  hasFocus() {
    return false
  }

  querySelectorAll(s) {
    return this.body.querySelectorAll(s)
  }

  querySelector(s) {
    return this.body.querySelector(s)
  }
}

// claude.ai's data behind the page, for a page given organizations: GET /api/organizations lists them, and each
// organization's usage reply carries its grants. lastActiveOrg is the cookie naming the selected one; cookieStore sets it
// as claude.ai's own cookie is scoped. Nothing but GET is answered.
function dataOf(page) {
  const orgs = page.orgs
  const usagePath = /^\/api\/organizations\/([^/]+)\/usage\?cedar_ember=1$/
  class XMLHttpRequest {
    open(method, path) {
      this.method = method
      this.path = path
    }
    setRequestHeader() {}
    send() {
      page.requests.push(`${this.method} ${this.path}`)
      const reply = (status, body) => {
        this.status = status
        this.responseText = JSON.stringify(body)
        this.responseURL = `https://claude.ai${this.path}`
      }
      if (this.method !== 'GET') return reply(405, {})
      if (orgs.signedOut) return reply(401, {})
      if (this.path === '/api/organizations') return reply(200, orgs.list)
      const usage = this.path.match(usagePath)
      if (usage && Object.hasOwn(orgs.cedar, usage[1])) return reply(200, { cedar_ember: orgs.cedar[usage[1]] })
      return reply(403, { type: 'error' })
    }
  }
  const cookieStore = {
    get: async (name) => (name === 'lastActiveOrg' && orgs.selected !== null ? { name, value: orgs.selected, domain: 'claude.ai', path: '/', sameSite: 'lax', expires: 1_900_000_000_000 } : null),
    set: async (options) => {
      page.cookieWrites.push(options)
      if (orgs.cookieStuck) return
      orgs.selected = options.value
    },
    delete: async (options) => {
      page.cookieWrites.push({ deleted: options })
      orgs.selected = null
    },
  }
  return { XMLHttpRequest, cookieStore }
}

// Gives the page its document, its window and evaluate, which runs an expression as `orca eval` does, in this page:
// an expression that answers a promise keeps the page's globals until it settles.
// The window records the events dispatched at it and hands each to page.onWindowEvent.
function served(page) {
  page.document = new Doc(page.body, page)
  page.windowEvents = []
  page.requests = []
  page.cookieWrites = []
  page.window = { dispatchEvent: (event) => { page.windowEvents.push(event.type); page.onWindowEvent?.(event); return true } }
  page.evaluate = (expression) => {
    const names = ['document', 'location', 'window', 'XMLHttpRequest', 'cookieStore']
    const saved = Object.fromEntries(names.map((name) => [name, globalThis[name]]))
    const data = page.orgs ? dataOf(page) : {}
    Object.assign(globalThis, { document: page.document, location: { href: page.url }, window: page.window, XMLHttpRequest: data.XMLHttpRequest, cookieStore: data.cookieStore })
    const restore = () => Object.assign(globalThis, saved)
    let out
    try {
      out = (0, eval)(expression)
    } catch (err) {
      restore()
      throw err
    }
    if (out && typeof out.then === 'function') return out.finally(restore)
    restore()
    return out
  }
}

// A Usage page. rows: [{ title, expires, disabled, onUse(page, row) }]; the title carries the count ("Fable reset · 2").
// orgs, for a login with organizations: { list, selected, cedar: { [uuid]: cedar_ember }, rows: { [uuid]: rows },
// cookieStuck, signedOut }; the page shows the rows of the selected organization, and page.reload() shows them again
// (as `orca goto` to the Usage page does). page.spendGrant(uuid, kind) uses one grant of the kind in the data.
// disabled: 'until-focus' greys the button out until the window gets a focus event, as claude.ai does in a background tab.
// page.setRows(rows) redraws the section; page.openDialog(text, buttons) adds a dialog outside the Settings one.
export function usagePage({ rows = [], status = '', url = 'https://claude.ai/new#settings/usage', orgs = null } = {}) {
  const body = el('body')
  const section = el('section', { 'data-settings-section-titled': '' })
  const statusLine = el('div', { role: 'status', 'data-testid': 'ce2-status' }, [], { text: status })
  const settings = el('div', { role: 'dialog' }, [
    el('h2', {}, [], { text: 'Usage' }),
    el('h3', {}, [], { text: 'Your usage limits' }),
    section,
    el('p', {}, [], { text: 'Last updated: just now' }),
  ])
  body.append(settings)
  const page = { url, clicks: [], body, document: null, rows: [], status: statusLine, windowFocused: false, orgs, reloads: 0 }
  body.page = page
  page.onWindowEvent = (event) => {
    if (event.type !== 'focus' && event.type !== 'blur') return
    page.windowFocused = event.type === 'focus'
    page.setRows(page.rows)
  }
  const greyed = (row) => row.disabled === true || (row.disabled === 'until-focus' && !page.windowFocused)

  const rowOf = (row) => el('div', { role: 'group', 'data-settings-row': '' }, [
    el('div', { 'data-settings-text': '' }, [
      el('span', { 'data-testid': 'ce2-type' }, [], { text: row.title }),
      el('div', { 'data-settings-desc': '' }, [el('span', { 'data-testid': 'ce2-expires' }, [], { text: row.expires ?? 'Expires Mar 9, 2027, 8:59 AM GMT+1' })]),
    ]),
    el('div', { 'data-settings-control': '' }, [
      el('span', { 'data-cds-disabled-reason-wrapper': '' }, [
        button('Reset for free', { 'data-testid': 'ce2-use', ...(greyed(row) ? { disabled: '' } : {}) }, () => row.onUse?.(page, row)),
        el('span', { hidden: '', 'data-cds-disabled-reason': '' }, [], { text: row.reason ?? '' }),
      ]),
    ]),
  ])

  page.setRows = (rows) => {
    page.rows = rows
    const count = rows.reduce((n, r) => n + Number(r.title.match(/·\s*(\d+)$/)?.[1] ?? 1), 0)
    const header = el('div', { 'data-settings-group-header': '' }, [
      el('h3', { 'data-settings-group-title': '' }, [], { text: 'Limit resets' }),
      ...(rows.length > 0 ? [el('span', {}, [], { text: `${count} available` })] : []),
    ])
    const list = rows.length > 0 ? rows.map(rowOf) : [el('p', {}, [], { text: 'No resets right now' })]
    section.replaceChildren(header, el('div', {}, [...list, statusLine]))
  }
  // One reset of the row used: its count drops by one, and the row goes with its last reset.
  page.spend = (row) => {
    const count = Number(row.title.match(/·\s*(\d+)$/)?.[1] ?? 1)
    const name = row.title.replace(/\s*·\s*\d+$/, '')
    const next = count - 1 === 0 ? null : { ...row, title: count - 1 === 1 ? name : `${name} · ${count - 1}` }
    page.setRows(page.rows.flatMap((r) => (r === row ? (next ? [next] : []) : [r])))
  }
  page.openDialog = (text, buttons) => {
    const dialog = el('div', { role: 'alertdialog' }, [el('p', {}, [], { text }), ...buttons])
    body.append(dialog)
    return dialog
  }
  page.reload = () => {
    page.reloads++
    page.windowFocused = false
    page.setRows(page.orgs.rows[page.orgs.selected] ?? [])
  }
  page.spendGrant = (uuid, kind) => {
    const grant = page.orgs.cedar[uuid].grants.find((g) => g.resets_left > 0 && g.clears.includes('seven_day') === (kind === 'full'))
    grant.resets_left -= 1
  }
  served(page)
  page.setRows(orgs ? (orgs.rows[orgs.selected] ?? []) : rows)
  return page
}

// A login screen: no dialog, no section.
export function loginPage() {
  const body = el('body', {}, [el('h1', {}, [], { text: 'Log in or sign up' }), button('Continue with email')])
  const page = { url: 'https://claude.ai/login', clicks: [], body }
  body.page = page
  served(page)
  return page
}
