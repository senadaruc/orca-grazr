// The limit resets claude.ai's Settings › Usage page shows the signed-in user, read from the page's text.
// Anything this cannot read is unknown (null counts), never none: only a loaded page without resets is none.

// "Your usage limits" on Team, "Your usage" on Ultra.
const LOADED = /^your usage( limits)?$/i
const LOGIN = /\b(log in|sign in|sign up|continue with (google|email))\b/i
const SECTION = /^limit resets$/i
const AVAILABLE = /^(\d+)\s+available$/i
const NONE = /^no resets right now$/i
// "Full reset", "Fable reset · 2": a kind with one reset has no count; a model reset is named after its model.
const KIND = /^(.*\S)\s+reset(?:\s*[·•×x]\s*(\d+))?$/i
const EXPIRY = /^(all\s+)?expires?\b/i
// The headings that follow the section; nothing from them on is a reset.
const SECTION_END = /^(last updated|usage credits|buy usage credits|extra usage)\b/i
// Team calls its full reset "Full reset", Ultra "Weekly reset"; any other name is a model's.
const FULL_LABEL = /^(full|weekly)$/i

// Non-breaking and narrow spaces come from the page's date formatting; lines of icon glyphs alone carry no text.
const linesOf = (text) => String(text ?? '').replace(/[   ]/g, ' ').split('\n')
  .map((line) => line.replace(/\s+/g, ' ').trim())
  .filter((line) => /[\p{L}\p{N}]/u.test(line))

const onLogin = (url) => {
  try {
    return new URL(url).pathname.startsWith('/login')
  } catch {
    return false
  }
}

// The section's kinds, each with the first expiry line before the next kind.
function kindsOf(lines) {
  const kinds = []
  for (const line of lines) {
    const kind = line.match(KIND)
    // A kind's name is a word or two; a sentence that happens to end in "reset" is not one.
    if (kind && !/^reset\b/i.test(line) && kind[1].split(' ').length <= 3) {
      const label = kind[1]
      kinds.push({ kind: FULL_LABEL.test(label) ? 'full' : 'model', label, count: kind[2] === undefined ? 1 : Number(kind[2]), expires: null })
    } else if (kinds.length > 0 && kinds.at(-1).expires === null && EXPIRY.test(line)) {
      kinds.at(-1).expires = line
    }
  }
  return kinds
}

// { signedIn: true|false|null, loaded, full, model, kinds: [{ kind: 'full'|'model', label, count, expires }] }.
// url, when given, is the address the page ended on: claude.ai sends a signed-out profile to /login.
export function parseUsagePage(text, { url } = {}) {
  const lines = linesOf(text)
  const unknown = { full: null, model: null, kinds: [] }
  const start = lines.findIndex((line) => SECTION.test(line))
  // The section alone says the page loaded (some pages have no heading); without it, only the heading can say so.
  if (start === -1 && !lines.some((line) => LOADED.test(line))) {
    const signedOut = onLogin(url) || lines.some((line) => LOGIN.test(line))
    return { signedIn: signedOut ? false : null, loaded: false, ...unknown }
  }
  const loaded = { signedIn: true, loaded: true }
  if (start === -1) return { ...loaded, full: 0, model: 0, kinds: [] }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => SECTION_END.test(line))
  const section = end === -1 ? rest : rest.slice(0, end)
  const available = section.map((line) => line.match(AVAILABLE)).find(Boolean)
  const total = available ? Number(available[1]) : section.some((line) => NONE.test(line)) ? 0 : null
  const kinds = kindsOf(section.filter((line) => !AVAILABLE.test(line)))
  if (total === 0 && kinds.length === 0) return { ...loaded, full: 0, model: 0, kinds: [] }
  const sum = kinds.reduce((n, k) => n + k.count, 0)
  if (kinds.length === 0 || (total !== null && sum !== total)) return { ...loaded, ...unknown }
  const count = (kind) => kinds.filter((k) => k.kind === kind).reduce((n, k) => n + k.count, 0)
  return { ...loaded, full: count('full'), model: count('model'), kinds }
}
