import { describe } from './errors.mjs'

// The limit resets read from each account's claude.ai usage page, kept in the plugin's storage (never a file in the
// plugin folder, whose writes remount an open panel): { [account]: { readAt, triedAt?, state, full, model, kinds } }.
// state is 'ok', 'signed-out' (the profile shows a login), 'no-profile' (the account has no browser profile yet) or 'failed'.
export const READINGS_KEY = 'limitResets'
// Older than this a reading says nothing: resets come and go, and a reading this old is a guess.
export const READING_MAX_AGE_MS = 12 * 3600 * 1000

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => Number.isInteger(v) && v >= 0

// The stored readings from the plugin's storage; a store that cannot be read holds none.
export async function loadReadings(storage, log = () => {}) {
  try {
    const value = await storage.get(READINGS_KEY)
    return isObject(value) ? value : {}
  } catch (err) {
    log(`grazr limit resets: the readings could not be loaded: ${describe(err)}`)
    return {}
  }
}

// The account's reading while it is current, else null. An ok reading must carry its counts.
export function currentReading(entry, now) {
  if (!isObject(entry) || !Number.isFinite(entry.readAt) || now - entry.readAt > READING_MAX_AGE_MS) return null
  if (entry.state === 'ok') {
    if (!isCount(entry.full) || !isCount(entry.model)) return null
    return { ...entry, kinds: Array.isArray(entry.kinds) ? entry.kinds.filter(isObject) : [] }
  }
  return ['signed-out', 'no-profile', 'failed'].includes(entry.state) ? entry : null
}

// When any account's page was last tried: the schedule reads again once this is three hours old. -Infinity with none.
export function lastTriedAt(readings) {
  const times = Object.values(isObject(readings) ? readings : {}).filter(isObject)
    .map((e) => Math.max(Number.isFinite(e.readAt) ? e.readAt : -Infinity, Number.isFinite(e.triedAt) ? e.triedAt : -Infinity))
  return times.length > 0 ? Math.max(...times) : -Infinity
}

// A new outcome for one account over its last one: a failed read keeps a good reading (it lapses on its own) and notes the try.
export function nextReading(previous, outcome, at) {
  if (outcome.state === 'failed') {
    return isObject(previous) && previous.state === 'ok' ? { ...previous, triedAt: at } : { readAt: at, state: 'failed' }
  }
  if (outcome.state === 'ok') return { readAt: at, state: 'ok', full: outcome.full, model: outcome.model, kinds: outcome.kinds }
  return { readAt: at, state: outcome.state }
}
