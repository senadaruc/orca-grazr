import { isRemote } from './hosts.mjs'
import { quote } from './shell-quote.mjs'

// Claude Code's own /limit-reset, by the plugin command that asks for it. Anthropic gives the list of resets (which
// kinds, how many, when they expire) to its own clients only, so the plugin shows no list and spends nothing itself:
// the command opens Claude, which names the reset and asks before using it.
export const RESET_KINDS = { 'limit-reset-model': 'fable', 'limit-reset-full': 'full' }

// The line typed into a terminal for one kind of reset on a host. On a remote host Claude runs there, in a login
// shell, so its PATH is the one a terminal on that host has.
export function limitResetText(h, kind) {
  if (!isRemote(h)) return `claude ${quote(`/limit-reset ${kind}`)}`
  // Double quotes around the prompt keep the nesting to two levels of single quotes.
  return `ssh -t ${quote(h.ssh)} ${quote(`exec "$SHELL" -lic ${quote(`claude "/limit-reset ${kind}"`)}`)}`
}
