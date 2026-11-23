import { ok as commandOk } from './runner.mjs'
import { expandTilde } from './paths.mjs'

const ORCA_TIMEOUT_MS = 15000
// Any line of a reply that reaches a toast or a message is cut to this many characters.
export const LINE_MAX = 200

// Text is clipped before it is shown: one line, at most LINE_MAX characters, ending in an ellipsis when cut.
export function clip(text) {
  const s = String(text ?? '')
  return s.length <= LINE_MAX ? s : `${s.slice(0, LINE_MAX - 1)}…`
}

export const lastLine = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? null

const asObject = (text) => {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

// Orca prints pretty-printed JSON over several lines; the engine prints one line. The whole output is tried first,
// then its last line.
export function parseReply(stdout) {
  const text = (stdout ?? '').trim()
  return asObject(text) ?? asObject(lastLine(text) ?? '')
}

// One Orca CLI call on this Mac, with --json. Never rejects: a failure is { ok: false, message }.
// timeoutMs is for a call that waits longer itself (orca wait --timeout).
export async function orcaCall({ exec, settings, homedir }, args, { timeoutMs = ORCA_TIMEOUT_MS } = {}) {
  const bin = expandTilde(settings.orcaBin, homedir)
  const result = await exec([bin, ...args, '--json'], { timeoutMs })
  const reply = parseReply(result.stdout)
  if (commandOk(result) && reply?.ok === true) return { ok: true, result: reply.result }
  const message = typeof reply?.error?.message === 'string' ? reply.error.message : result.spawnError ? `could not run ${bin}` : 'no answer from Orca'
  return { ok: false, message: clip(message) }
}
