// The limit resets of one organization, from claude.ai's usage reply (GET /api/organizations/<uuid>/usage?cedar_ember=1):
// its cedar_ember grants, read as the Usage page counts them. A grant that clears the weekly window ("seven_day") is a
// full reset; one that does not gives back a model's share only and is a model reset, named after its model when the
// grant says which ("launch-2610-fable" → Fable). The grants' own type says "full" for both, so it is not used.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => Number.isInteger(v) && v >= 0

// The model a model reset gives back: Fable, as the grants name it today, else none known ("Model").
function modelLabel(grant) {
  if (/fable/i.test(String(grant.id ?? '')) || /\bfable\b/i.test(String(grant.label ?? ''))) return 'Fable'
  return 'Model'
}

// "Mar 9, 2027, 8:59 AM GMT+1", as the Usage page writes its dates.
function dateText(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone })
    .format(new Date(ms)).replace(/[  ]/g, ' ')
}

// Why a grant with resets left cannot be used now, as claude.ai says it; null when it can.
function unavailableOf(grant, cedar) {
  if (grant.usable_now === true) return null
  if (typeof grant.unavailable_reason === 'string' && grant.unavailable_reason !== '') return grant.unavailable_reason
  if (cedar.eligible === false && typeof cedar.ineligible_reason === 'string' && cedar.ineligible_reason !== '') return cedar.ineligible_reason
  if (grant.paused === true) return 'paused'
  if (grant.use_requires_limit === true) return 'requires_limit'
  return 'unavailable'
}

// The reading of the grants: { full, model, kinds: [{ kind, label, count, expires, expiresAt, usableNow, unavailableReason }],
// usableNow: { full, model } }, or null when the reply carries no grants in a known form. Only grants with resets left
// count. A kind is usable now when one of its grants is; usableNow is null for a kind with none left.
export function readingFromGrants(cedar, { timeZone } = {}) {
  if (!isObject(cedar) || !Array.isArray(cedar.grants)) return null
  const groups = new Map()
  for (const grant of cedar.grants) {
    if (!isObject(grant)) return null
    if (!isCount(grant.resets_left)) return null
    if (grant.resets_left === 0) continue
    if (!Array.isArray(grant.clears)) return null
    const kind = grant.clears.includes('seven_day') ? 'full' : 'model'
    const label = kind === 'full' ? 'Full' : modelLabel(grant)
    const key = `${kind}:${label}`
    if (!groups.has(key)) groups.set(key, { kind, label, grants: [] })
    groups.get(key).grants.push(grant)
  }
  const kinds = [...groups.values()]
    .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'full' ? -1 : 1))
    .map(({ kind, label, grants }) => {
      const count = grants.reduce((n, g) => n + g.resets_left, 0)
      const ends = grants.map((g) => Date.parse(g.ends_at)).filter(Number.isFinite)
      const first = ends.length > 0 ? Math.min(...ends) : null
      const same = ends.length === grants.length && ends.every((t) => t === first)
      const lead = count === 1 ? 'Expires' : same ? 'All expire' : 'First expires'
      const usable = grants.some((g) => g.usable_now === true)
      return {
        kind,
        label,
        count,
        expires: first === null ? '' : `${lead} ${dateText(first, timeZone)}`,
        expiresAt: first === null ? null : new Date(first).toISOString(),
        usableNow: usable,
        unavailableReason: usable ? null : unavailableOf(grants[0], cedar),
      }
    })
  const total = (kind) => kinds.filter((k) => k.kind === kind).reduce((n, k) => n + k.count, 0)
  const usable = (kind) => (total(kind) === 0 ? null : kinds.some((k) => k.kind === kind && k.usableNow))
  return { full: total('full'), model: total('model'), kinds, usableNow: { full: usable('full'), model: usable('model') } }
}

// What claude.ai's reason says, for a button's hover text.
export function unavailableText(reason) {
  if (reason === 'unavailable' || reason === null || reason === undefined) return 'claude.ai: not usable right now'
  if (reason === 'paused') return 'claude.ai: paused right now'
  if (reason === 'requires_limit') return 'claude.ai: usable once a limit is reached'
  return `claude.ai: not usable right now (${String(reason).replace(/_/g, ' ')})`
}
