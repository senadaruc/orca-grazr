import * as nodeFs from 'node:fs/promises'
import { describe } from './errors.mjs'

// The engine version the plugin ships: the VERSION line of engine/grazr.py.
const VERSION_LINE = /^VERSION = "([^"]+)"/m

// A release as major.minor.patch, with an optional +fork.N suffix (N missing counts as 0).
const RELEASE = /^(\d+)\.(\d+)\.(\d+)(?:\+fork\.(\d+))?$/

const parse = (v) => {
  const m = typeof v === 'string' ? v.trim().match(RELEASE) : null
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : null
}

// The first engine that enrols each organization of a login as an account of its own; an older one would overwrite
// the login's first organization with the second.
export const ORGANIZATIONS_ENGINE = '0.4.7+fork.16'

// Whether an engine's version is ORGANIZATIONS_ENGINE or later; a missing or unparseable version is not.
export const supportsOrganizations = (version) => parse(version) !== null && !isNewerEngine(ORGANIZATIONS_ENGINE, version)

// True only when the bundled release is newer than the installed one, compared numerically part by part.
// An installed version newer than the bundled one is not outdated, and a version that cannot be parsed is never outdated.
export function isNewerEngine(bundled, installed) {
  const b = parse(bundled)
  const i = parse(installed)
  if (b === null || i === null) return false
  for (let k = 0; k < b.length; k++) {
    if (b[k] !== i[k]) return b[k] > i[k]
  }
  return false
}

// Rejects with the path when the engine cannot be read or has no VERSION line, so the caller can log it.
export async function readBundledVersion({ root, fs = nodeFs }) {
  const path = `${root}/engine/grazr.py`
  let source
  try {
    source = await fs.readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read the bundled engine at ${path}: ${describe(err)}`)
  }
  const match = source.match(VERSION_LINE)
  if (!match) throw new Error(`no VERSION line in the bundled engine at ${path}`)
  return match[1]
}
