import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { execCapture } from './exec.mjs'
import { createRunner, ok as commandOk } from './runner.mjs'
import { claudeBinOf, isRemote } from './hosts.mjs'
import { toast, failureBody } from './toast.mjs'
import { describe, describeFailure } from './errors.mjs'
import { quote, quoteTilde } from './shell-quote.mjs'
import { createStepper } from './signin-page.mjs'
import { orcaCall, parseReply, lastLine, clip, LINE_MAX } from './orca-cli.mjs'
import { chooseWorkspace, NO_WORKSPACE } from './signin-workspace.mjs'
import { createAccountProfiles, listProfiles, profileLabel } from './browser-profiles.mjs'
import { supportsOrganizations, ORGANIZATIONS_ENGINE } from './engine-version.mjs'
import { organizationAccountName } from './organization-account-name.mjs'

export { orcaCall, clip, LINE_MAX, chooseWorkspace, profileLabel }

// Claude must print its sign-in address within this long, or the job gives up.
export const URL_TIMEOUT_MS = 30 * 1000
// A sign-in not finished within this long is abandoned: the login is stopped and discarded. The same long a tab
// address may stay unchanged before the sign-in is treated as abandoned.
export const LOGIN_TIMEOUT_MS = 30 * 60 * 1000
// SIGTERM first so claude can clean up; SIGKILL only if it ignores that.
export const KILL_GRACE_MS = 2000
// After SIGKILL, a child (or a grandchild that holds its pipes open) may still never emit close; the job then gives up.
export const HARD_DEADLINE_MS = 5000
const STEP_TIMEOUT_MS = 20000
// The remote login is wrapped in timeout(1) at this many seconds, so it ends on the remote host too.
export const REMOTE_LOGIN_TIMEOUT_S = 1830
// claude ignores SIGTERM, so timeout(1) sends SIGKILL this many seconds after its TERM.
export const REMOTE_KILL_AFTER_S = 5
// The tab's address is read this often while the sign-in is waiting for its code.
export const RELAY_POLL_MS = 1500
// A tab that has left the sign-in is returned to the authorize page at most this often, and this many times per sign-in.
export const STEER_GAP_MS = 10 * 1000
export const STEER_MAX = 5
// The paths of the sign-in flow on claude.ai and claude.com. A page off these paths, after the user is signed in, is off the flow.
const FLOW_PATHS = ['/login', '/magic-link', '/oauth', '/cai/oauth', '/api', '/verify', '/sso', '/auth']
const ALREADY_OPEN = 'Sign-in already open — switched to it'
const signingIn = (job) => (job.mode === 'organization'
  ? (job.organizationName
    ? `Signing in ${job.organizationName} of ${job.email} in Orca's browser — sign in, check the organization is ${job.organizationName}, then approve Claude Code`
    : `Signing in another organization of ${job.email} in Orca's browser — sign in, pick the organization, then approve Claude Code`)
  : `Signing in ${job.account ?? 'a new account'} in Orca's browser — sign in, then approve Claude Code`)
// The organization a sign-in for another organization came back with is enrolled already.
export const ALREADY_ENROLLED = 'that organization is already enrolled — choose the other one on claude.ai'
// An engine before fork.16 enrols a further organization of a login over the first one.
export const updateEngineFirst = (host) => `Another organization needs engine ${ORGANIZATIONS_ENGINE} or later: update the engine on ${host} first`
// A sign-in address printed without its newline is taken once the output has been quiet this long.
const URL_QUIET_MS = 500
const NO_REMOTE_HOST = 'Sign-in needs a remote host to log in on'
// The remote login prints its shell's pid first, so a stop can end the remote process group (ssh hang-up does not reach it).
const PID_LINE = /grazr-pid:(\d+)\r?\n/
// The remote kill is best effort and short: a host that does not answer is left to its own timeout.
const KILL_TIMEOUT_MS = 5000
// The sign-in address: a line that starts with `visit:`. Whether it ends in a newline is checked by the caller.
const SIGNIN_URL = /visit:\s*(https:\/\/\S+)(\r?\n)?/
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// Only these sites may be opened in Orca's browser for a sign-in, and only over https.
const SIGNIN_SITES = ['claude.ai', 'claude.com', 'anthropic.com']
// Claude's manual flow ends on this page: the code and state in its query are the answer, written to the login's stdin.
const CALLBACK_HOST = 'platform.claude.com'
const CALLBACK_PATH = '/oauth/code/callback'
const CODE_CHARS = /^[A-Za-z0-9._~-]+$/
// A code or state longer than this is refused, whatever it holds.
const CODE_MAX = 512
// Consecutive failed reads of the sign-in tab's address before the tab is taken as closed.
export const TAB_READ_FAILURES = 5

// Whether a sign-in address is https on one of the sign-in sites, or a subdomain of one.
export function isSignInUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && SIGNIN_SITES.some((site) => parsed.hostname === site || parsed.hostname.endsWith(`.${site}`))
}

const ORGANIZATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The authorize address with the organization asked for: orgUUID=<uuid> appended to its query, the rest of the address
// kept as Claude printed it (state included). An address that names an organization already, or a uuid that is not one,
// is returned unchanged. Whether claude.ai honours orgUUID is not known, so the enrolment still checks the organization.
export function withOrganization(url, uuid) {
  if (typeof url !== 'string' || typeof uuid !== 'string' || !ORGANIZATION_UUID.test(uuid)) return url
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.searchParams.has('orgUUID')) return url
  const hash = url.indexOf('#')
  const [base, fragment] = hash === -1 ? [url, ''] : [url.slice(0, hash), url.slice(hash)]
  const joiner = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?'
  return `${base}${joiner}orgUUID=${encodeURIComponent(uuid)}${fragment}`
}

// The code and state the browser was sent to after the sign-in was approved, as { code, state }, or null. Only the
// callback page itself counts; its state must equal the state of the authorize address the job opened; and a code or
// state with anything but plain token characters, or longer than CODE_MAX, is refused.
export function callbackCode(url, expectedState) {
  if (typeof url !== 'string') return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== CALLBACK_HOST || parsed.pathname !== CALLBACK_PATH) return null
  const code = parsed.searchParams.get('code')
  const state = parsed.searchParams.get('state')
  if (!code || !state || typeof expectedState !== 'string' || expectedState === '') return null
  if (state !== expectedState || code.length > CODE_MAX || state.length > CODE_MAX) return null
  return CODE_CHARS.test(code) && CODE_CHARS.test(state) ? { code, state } : null
}

// One `StaticText "…"` line of a snapshot; the quoted text is taken as it stands.
const STATIC_TEXT = /^\s*(?:-\s*)?StaticText\s+"((?:[^"\\]|\\.)*)"/

// The code and state the callback page shows as text, as { code, state }, or null. Claude Code from 2.1.330 leaves its
// callback page without a query; the page shows `code#state` to paste instead. Only a StaticText whose whole text is
// `<code>#<state>`, each part of plain token characters and at most CODE_MAX long, is a candidate; there must be exactly
// one (the same text twice is one), and its state must equal the expected state.
export function snapshotCode(snapshot, expectedState) {
  if (typeof snapshot !== 'string' || typeof expectedState !== 'string' || expectedState === '') return null
  const candidates = new Set()
  for (const line of snapshot.split('\n')) {
    const text = line.match(STATIC_TEXT)?.[1]
    const parts = text?.split('#')
    if (parts?.length === 2 && tokenOrNull(parts[0]) !== null && tokenOrNull(parts[1]) !== null) candidates.add(text)
  }
  if (candidates.size !== 1) return null
  const [code, state] = [...candidates][0].split('#')
  return state === expectedState ? { code, state } : null
}

// The authorize pages of Claude's sign-in, and the login page whose returnTo may be one of them.
const AUTHORIZE_PATHS = ['/oauth/authorize', '/cai/oauth/authorize']
const LOGIN_PATH = '/login'

// The state of a token-shaped value: plain token characters, at most CODE_MAX of them; null otherwise.
const tokenOrNull = (value) => (typeof value === 'string' && value !== '' && value.length <= CODE_MAX && CODE_CHARS.test(value) ? value : null)

// The state a sign-in tab shows before its callback, or null. Claude Code from 2.1.330 prints a short address without a
// state, which claude.ai expands: a signed-in tab shows the long authorize address with its state, a signed-out one the
// login page with that address, relative, as returnTo. Only https on the sign-in sites counts, and only a returnTo on
// the same site; the state must pass the callback's own rules.
export function authorizeState(url) {
  if (typeof url !== 'string' || !isSignInUrl(url)) return null
  const parsed = new URL(url)
  if (AUTHORIZE_PATHS.includes(parsed.pathname)) return tokenOrNull(parsed.searchParams.get('state'))
  if (parsed.pathname !== LOGIN_PATH && !parsed.pathname.startsWith(`${LOGIN_PATH}/`)) return null
  const returnTo = parsed.searchParams.get('returnTo')
  if (typeof returnTo !== 'string' || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) return null
  let target
  try {
    target = new URL(returnTo, parsed.origin)
  } catch {
    return null
  }
  if (target.origin !== parsed.origin || !AUTHORIZE_PATHS.includes(target.pathname)) return null
  return tokenOrNull(target.searchParams.get('state'))
}

// Whether a tab address is the callback page, whatever its query holds.
const isCallbackPage = (url) => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === CALLBACK_HOST && parsed.pathname === CALLBACK_PATH
  } catch {
    return false
  }
}

// Whether a tab address is on claude.ai or claude.com, outside the sign-in flow: not on one of FLOW_PATHS, and not the
// platform callback that the code relay reads. Any other address (another site) is not steered.
export function offTheFlow(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname
  const onClaude = parsed.protocol === 'https:' && ['claude.ai', 'claude.com'].some((site) => host === site || host.endsWith(`.${site}`))
  if (!onClaude) return false
  if (host === CALLBACK_HOST && parsed.pathname === CALLBACK_PATH) return false
  return !FLOW_PATHS.some((flow) => parsed.pathname === flow || parsed.pathname.startsWith(`${flow}/`))
}

// Brings the sign-in tab to the front in its workspace. Best effort: a failure is logged and is never fatal.
async function focusTab(ctx, page, workspace, log) {
  const focused = await orcaCall(ctx, ['tab', 'switch', '--page', page, '--worktree', workspace, '--focus'])
  if (!focused.ok) log(`grazr sign-in: the sign-in tab could not be brought to the front: ${focused.message}`)
  return focused.ok
}

// The configured signinHost host, when it names one; undefined otherwise.
const namedSigninHost = (settings) => (typeof settings.signinHost === 'string' && settings.signinHost !== ''
  ? settings.hosts.find((h) => h.name === settings.signinHost)
  : undefined)

// The host that runs the login: the card's own host when it is remote; for a Mac card, signinHost when it names a remote
// host, else the first remote host. Null when there is none. The login needs no browser of its own.
export function loginHostFor(settings, host) {
  if (isRemote(host)) return host
  const named = namedSigninHost(settings)
  if (named && isRemote(named)) return named
  return settings.hosts.find((h) => isRemote(h)) ?? null
}

// Stops a remote login by its pid (from its first output line): the whole process group that shell leads. Best effort:
// a failure is logged, never thrown.
async function stopRemoteLogin({ exec, settings, log }, login, pid) {
  try {
    const killed = await exec([settings.sshBin, ...settings.sshOptions, login.ssh, `kill -KILL -- -${pid}`], { timeoutMs: KILL_TIMEOUT_MS })
    if (!commandOk(killed)) log(`grazr sign-in: the remote login on ${login.name} was not stopped`)
  } catch (err) {
    log(`grazr sign-in: stopping the remote login failed: ${describe(err)}`)
  }
}

// yyyy-mm-dd hh:mm in local time, for the label of a fresh profile.
const stamp = (date) => {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// The isolated profile for a sign-in. A re-authentication, and another organization of a login, use the login's own
// profile (remembered, found by its label, or created once). An add-account sign-in creates a fresh one: its label
// carries the time and a random suffix, and its id is the one listed after the create that was not listed before it.
// created is set as soon as Orca has made the profile, so a job that ends early still deletes it (by id, or by label
// when the id could not be read).
async function profileFor(ctx, profiles, owner, now, suffix) {
  if (owner !== null) {
    const own = await profiles.ensure(ctx, owner)
    return own.ok ? { ok: true, id: own.id, fresh: false } : { ok: false, message: own.message }
  }
  const before = await listProfiles(ctx)
  if (before.error) return { ok: false, message: before.error }
  const known = new Set(before.profiles.map((p) => p?.id))
  const label = `${profileLabel(null)} ${stamp(now())} ${suffix()}`
  const made = await orcaCall(ctx, ['tab', 'profile', 'create', '--label', label, '--scope', 'isolated'])
  if (!made.ok) return { ok: false, message: made.message }
  const created = { label, id: null }
  const after = await listProfiles(ctx)
  if (after.error) return { ok: false, message: after.error, fresh: true, created }
  const id = after.profiles.find((p) => p?.label === label && typeof p.id === 'string' && !known.has(p.id))?.id
  if (typeof id !== 'string') return { ok: false, message: `Orca did not list the profile ${label}`, fresh: true, created }
  created.id = id
  return { ok: true, id, fresh: true, created }
}

// The id of the one profile with this label, found again by label; null when there is none or more than one.
async function profileIdByLabel(ctx, label) {
  const listed = await listProfiles(ctx)
  if (listed.error) return null
  const matches = listed.profiles.filter((p) => p?.label === label && typeof p.id === 'string')
  return matches.length === 1 ? matches[0].id : null
}

// Closes every tab on this Mac whose address is the sign-in address. Best effort: it never throws.
async function closeTabsAt(ctx, url) {
  const listed = await orcaCall(ctx, ['tab', 'list', '--worktree', 'all'])
  if (!listed.ok) return
  for (const tab of listed.result?.tabs ?? []) {
    const page = tab?.browserPageId ?? tab?.id
    if (tab?.url === url && typeof page === 'string') await orcaCall(ctx, ['tab', 'close', '--page', page])
  }
}

// The remote login command. CLAUDE_CONFIG_DIR is set for the whole line. setsid makes the shell the leader of its own
// process group, so its pid names the group. The shell echoes its pid, then execs timeout(1) around claude: timeout
// sends SIGKILL after its TERM because claude ignores TERM. The claude path keeps its ~/ expansion, which the inner
// shell performs.
export function remoteLoginCommand({ dir, claudeBin, args }) {
  const inner = ['echo grazr-pid:$$;', 'exec', 'timeout', '-k', String(REMOTE_KILL_AFTER_S), String(REMOTE_LOGIN_TIMEOUT_S), quoteTilde(claudeBin), ...args.map(quote)].join(' ')
  return `CLAUDE_CONFIG_DIR=${quote(dir)} setsid sh -c ${quote(inner)}`
}

// Starts claude's login on the login host over plain ssh (no pty: claude's manual flow reads its code from stdin, and a
// pty makes it print nothing). stdin is a pipe that stays open until the login ends. handle.url resolves { url } once
// claude prints its sign-in address, or { reason } when it never does (the address may arrive on stdout or stderr).
// handle.exit resolves once the ssh child has ended, with the output it printed. handle.send(text) writes to the
// login's stdin. handle.stop() kills the ssh child. Nothing here rejects.
function startLogin({ spawn, timers, settings, login, command, loginTimeoutMs, urlTimeoutMs }) {
  let resolveUrl
  let resolveExit
  const handle = {
    url: new Promise((resolve) => { resolveUrl = resolve }),
    exit: new Promise((resolve) => { resolveExit = resolve }),
    timedOut: false,
    // The remote shell's pid, once its first line has been read; null until then.
    pid: null,
    send: () => false,
    stop: () => {},
  }
  let child
  try {
    child = spawn(settings.sshBin, [...settings.sshOptions, login.ssh, command], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (spawnError) {
    resolveUrl({ reason: 'exited' })
    resolveExit({ spawnError, code: null, signal: null, timedOut: false, stderr: '', output: '' })
    return handle
  }
  const err = []
  let text = ''
  let found = false
  let settled = false
  const timer = { url: null, limit: null, grace: null, hard: null, quiet: null }
  const finish = (outcome) => {
    if (settled) return
    settled = true
    for (const t of Object.values(timer)) timers.clearTimeout(t)
    child.stdin?.destroy?.()
    resolveUrl({ reason: 'exited' })
    resolveExit({
      timedOut: handle.timedOut,
      stderr: Buffer.concat(err).toString('utf8'),
      output: text.replace(ANSI, ''),
      spawnError: null,
      code: null,
      signal: null,
      ...outcome,
    })
  }
  // Once stop() has been asked for, nothing more is written to the login.
  let stopping = false
  handle.send = (value) => {
    if (settled || stopping) return false
    try {
      child.stdin.write(value)
      return true
    } catch {
      return false
    }
  }
  handle.stop = () => {
    stopping = true
    if (settled || timer.grace) return
    child.kill('SIGTERM')
    timer.grace = timers.setTimeout(() => {
      child.kill('SIGKILL')
      // close may still never come (a grandchild holding the pipes): the job stops waiting and is released.
      timer.hard = timers.setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), HARD_DEADLINE_MS)
    }, KILL_GRACE_MS)
  }
  const foundUrl = (url) => {
    found = true
    timers.clearTimeout(timer.url)
    timers.clearTimeout(timer.quiet)
    resolveUrl({ url })
  }
  // A line with its newline is the address at once. One without is taken only after the output has been quiet.
  const scan = (final) => {
    if (found) return
    const match = text.replace(ANSI, '').match(SIGNIN_URL)
    if (match === null) return
    if (match[2] !== undefined || final) return foundUrl(match[1])
    timers.clearTimeout(timer.quiet)
    timer.quiet = timers.setTimeout(() => scan(true), URL_QUIET_MS)
  }
  const onOutput = (chunk) => {
    text = (text + chunk.toString('utf8')).slice(-8192)
    // The pid line is read on the chunk that completes it, and only a whole numeric line counts.
    if (handle.pid === null) {
      const pid = Number(text.replace(ANSI, '').match(PID_LINE)?.[1])
      if (Number.isSafeInteger(pid) && pid > 0) handle.pid = pid
    }
    scan(false)
  }
  child.stdout.on('data', onOutput)
  child.stdout.on('end', () => scan(true))
  child.stderr.on('data', (chunk) => {
    err.push(chunk)
    onOutput(chunk)
  })
  child.stderr.on('end', () => scan(true))
  // ssh may exit before reading stdin; that EPIPE is reported through close, not thrown.
  child.stdin?.on('error', () => {})
  child.on('error', (spawnError) => finish({ spawnError }))
  child.on('close', (code, signal) => finish({ code, signal }))
  timer.limit = timers.setTimeout(() => { handle.timedOut = true; handle.stop() }, loginTimeoutMs)
  timer.url = timers.setTimeout(() => { resolveUrl({ reason: 'timeout' }); handle.stop() }, urlTimeoutMs)
  return handle
}

// Polls the sign-in tab's address until it is the callback with the expected state and a code, then writes `code#state`
// to the login's stdin, once, and stops polling. A callback page whose address has no usable code is read with a
// snapshot, and the code#state it shows is taken (snapshotCode). Without an expected state, the first one authorizeState
// reads from the tab is expected; a callback before any is not relayed. Resolves 'sent'; 'ended' (the login ended, or the job was cancelled, first);
// 'idle' (the address did not change for the whole login limit); or 'closed' (the tab could not be read
// TAB_READ_FAILURES times in a row). Nothing is written once cancelled() is true. The code is never logged or shown.
function relayCode({ ctx, page, workspace, authorizeUrl, handle, timers, now, expectedState, cancelled, log, automate }) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    let lastUrl = null
    let lastChange = now()
    let failedReads = 0
    let steers = 0
    let lastSteer = null
    // The state the callback must carry: the printed address's, or else the first one the tab shows.
    let state = expectedState
    let unlearnedLogged = false
    let snapshotFailedLogged = false
    const finish = (outcome) => {
      if (done) return
      done = true
      timers.clearTimeout(timer)
      resolve(outcome)
    }
    handle.exit.then(() => finish('ended'))
    const poll = async () => {
      timer = null
      const shown = await orcaCall(ctx, ['tab', 'show', '--page', page])
      if (done) return
      if (!shown.ok) {
        failedReads++
        if (failedReads >= TAB_READ_FAILURES) return finish('closed')
      } else {
        failedReads = 0
      }
      const url = shown.ok && typeof shown.result?.tab?.url === 'string' ? shown.result.tab.url : null
      if (url !== null && url !== lastUrl) {
        lastUrl = url
        lastChange = now()
      }
      // A sign-in address without a state (the short form) takes the first state the tab shows before its callback.
      if (state === null && url !== null) state = authorizeState(url)
      if (state === null && !unlearnedLogged && url !== null && isCallbackPage(url)) {
        unlearnedLogged = true
        log('grazr sign-in: the sign-in reached its callback, but no state was learned from the sign-in address or the tab, so the code was not relayed')
      }
      let callback = callbackCode(url, state)
      // A callback page without the code in its address shows it as text: read it there, from a snapshot still on that page.
      if (callback === null && state !== null && url !== null && isCallbackPage(url) && !cancelled()) {
        const snapped = await orcaCall(ctx, ['snapshot', '--page', page])
        if (done) return
        if (snapped.ok && typeof snapped.result?.snapshot === 'string') {
          if (typeof snapped.result.url === 'string' && isCallbackPage(snapped.result.url)) callback = snapshotCode(snapped.result.snapshot, state)
        } else if (!snapshotFailedLogged) {
          snapshotFailedLogged = true
          log(`grazr sign-in: the callback page could not be read for its code: ${snapped.message ?? 'no snapshot'}`)
        }
      }
      if (callback !== null) {
        if (cancelled()) return finish('ended')
        return finish(handle.send(`${callback.code}#${callback.state}\n`) ? 'sent' : 'ended')
      }
      // A sign-in page is stepped at most once per poll (e-mail, continue, code box, approve, or the magic-link restart).
      // A failing step is logged and the poll goes on; it never ends the relay.
      let stepped = 'quiet'
      if (url !== null && !cancelled()) {
        try {
          stepped = await automate(url)
        } catch (err) {
          log(`grazr sign-in: a sign-in step failed: ${describe(err)}`)
        }
        if (done) return
      }
      // Signed in but off the flow (say, claude.ai/new): the authorize page is opened again in this tab, at most every
      // STEER_GAP_MS and STEER_MAX times in all, so the flow is not lost. A tab that was stepped is not moved this poll.
      if (stepped === 'quiet' && url !== null && offTheFlow(url) && steers < STEER_MAX && (lastSteer === null || now() - lastSteer >= STEER_GAP_MS)) {
        steers++
        lastSteer = now()
        const moved = await orcaCall(ctx, ['goto', '--page', page, '--worktree', workspace, '--url', authorizeUrl])
        if (done) return
        log(moved.ok
          ? `grazr sign-in: the tab had left the sign-in; returned it to the authorize page (${steers} of ${STEER_MAX})`
          : `grazr sign-in: the tab could not be returned to the authorize page: ${moved.message}`)
      }
      if (now() - lastChange >= LOGIN_TIMEOUT_MS) return finish('idle')
      timer = timers.setTimeout(poll, RELAY_POLL_MS)
    }
    void poll()
  })
}

const cancelledToast = (host) => toast(host.name, 'sign-in cancelled', 'A newer sign-in on this card replaced it. Nothing was enrolled.')

const notFinishedToast = (host, login) => toast(host.name, 'sign-in failed', `The login did not finish on ${login.name}.\nNothing was enrolled.`)

// A step over ssh that failed: an unreachable login host is said so; anything else shows the engine's or ssh's failure.
function stepFailedToast(host, login, result) {
  const failure = describeFailure(result)
  if (failure.kind === 'unreachable') return toast(host.name, 'sign-in failed', `${login.name} could not be reached; nothing was enrolled.`)
  return toast(host.name, 'sign-in failed', `${clip(failureBody(failure))}\nNothing was enrolled.`)
}

function loginFailedToast(host, login, exit) {
  if (exit.spawnError) return toast(host.name, 'sign-in failed', `Could not run ssh: ${clip(exit.spawnError.message)}\nNothing was enrolled.`)
  if (describeFailure({ ...exit, remote: true }).kind === 'unreachable') return toast(host.name, 'sign-in failed', `${login.name} could not be reached; nothing was enrolled.`)
  // The remote's stderr and stdout are both read, so the last line of either is the reason.
  const last = [exit.stderr, exit.output].map((t) => (t ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1)).find(Boolean)
  return toast(host.name, 'sign-in failed', `${clip(last ?? `exit ${exit.code ?? exit.signal}`)}\nNothing was enrolled.`)
}

// A storage that lives as long as the worker, for jobs made without the plugin's.
function memoryStorage() {
  const values = new Map()
  return { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value) } }
}

const orcaFailedToast = (host, label, message) => toast(host.name, 'sign-in failed', `Orca's browser in the ${clip(label)} workspace could not open the sign-in: ${clip(message)}\nNothing was enrolled.`)

// The enrolment's outcome as { toast, enrolled, email }: the toast says enrolled, refused, or the engine's failure;
// enrolled is the name the account was enrolled under, or null when it was not, and email its login's e-mail.
// Never includes the export itself.
function enrolOutcome(host, result, name) {
  const reply = parseReply(result.stdout)
  if (commandOk(result) && reply?.ok === true) {
    const blocked = reply.unblocked === false ? '\nIt is still blocked; press Refresh on the card.' : ''
    const note = `${reply.ordered === true ? '\nAdded to the end of the rotation order.' : ''}${blocked}`
    const email = typeof reply.email === 'string' && reply.email !== '' ? reply.email : null
    const organization = typeof reply.organization === 'string' && reply.organization !== '' && name !== email ? ` (${reply.organization})` : ''
    return {
      toast: toast(host.name, 'signed in', `Enrolled ${clip(`${name ?? email ?? 'the account'}${organization}`)} on ${host.name}${note}`),
      enrolled: name,
      email,
    }
  }
  if (typeof reply?.error === 'string' && reply.error !== '') {
    return { toast: toast(host.name, 'sign-in failed', `${clip(reply.error)}\nNothing was enrolled.`), enrolled: null }
  }
  return { toast: stepFailedToast(host, { name: host.name }, result), enrolled: null }
}

const textOrNull = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const sameText = (a, b) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Who the export signed in: { email, login, organization, organizationName }, or null without an e-mail. Read from the
// export's identity (the isolated login's own config); the export itself is never kept.
function identityIn(result) {
  const identity = commandOk(result) ? parseReply(result.stdout)?.identity : null
  const email = textOrNull(identity?.emailAddress)
  if (email === null) return null
  return {
    email,
    login: textOrNull(identity.accountUuid),
    organization: textOrNull(identity.organizationUuid),
    organizationName: textOrNull(identity.organizationName),
  }
}

// The enrolled accounts of a status report, as records with a name.
const enrolledIn = (report) => (Array.isArray(report?.accounts) ? report.accounts : []).filter((a) => isRecord(a) && textOrNull(a.name) !== null)

// Whether an enrolled account is of the login the identity names: the same login id when both are known, else the same
// e-mail.
const ofLogin = (account, identity) => {
  const login = textOrNull(account.login)
  if (login !== null && identity.login !== null) return login === identity.login
  return sameText(textOrNull(account.email), identity.email)
}

// The enrolled account of the identity's login and organization, or undefined. An engine before fork.16 reports no
// organization, so nothing matches there.
const enrolledAs = (report, identity) => enrolledIn(report).find((a) => ofLogin(a, identity) && sameText(textOrNull(a.organization_uuid), identity.organization))

// The name a new login is enrolled under: the name of the account already enrolled for its login and organization;
// `<email>:<org-slug>` when other organizations of its login are enrolled (an engine from fork.16 on keeps them apart);
// else its e-mail, as before. Without a status, the e-mail.
function newLoginName(identity, report) {
  if (report === null) return { name: identity.email }
  const same = enrolledAs(report, identity)
  if (same) return { name: same.name }
  const sibling = supportsOrganizations(report.version) && identity.organization !== null && enrolledIn(report).some((a) => ofLogin(a, identity))
  if (!sibling) return { name: identity.email }
  return { name: organizationAccountName({ email: identity.email, organization: identity.organizationName, organizationUuid: identity.organization, taken: enrolledIn(report).map((a) => a.name) }) }
}

// A sign-in targeted at one organization that came back with another.
export const wrongOrganization = (signedIn, wanted) => `claude.ai signed in to ${signedIn}, not ${wanted} — pick ${wanted} on the authorize page`

// The name another organization of the job's login is enrolled under, decided from the organization the sign-in came
// back with, before anything is enrolled: { name, organization } or { refused }. A sign-in targeted at an organization
// takes that one alone.
function organizationName(job, identity, report) {
  if (!sameText(identity.email, job.email)) return { refused: `signed in as ${identity.email}, expected ${job.email}` }
  if (report === null) return { refused: `the accounts on ${job.host.name} could not be read` }
  if (!supportsOrganizations(report.version)) return { refused: updateEngineFirst(job.host.name) }
  if (identity.organization === null) return { refused: 'claude.ai did not say which organization was signed in to' }
  if (job.organization !== null && identity.organization !== job.organization) {
    return { refused: wrongOrganization(identity.organizationName ?? identity.organization, job.organizationName ?? job.organization) }
  }
  const same = enrolledAs(report, identity)
  if (same) return { refused: `${ALREADY_ENROLLED} (${same.name})` }
  const taken = enrolledIn(report).map((a) => a.name)
  return { name: organizationAccountName({ email: identity.email, organization: identity.organizationName, organizationUuid: identity.organization, taken }), organization: identity.organization }
}

export function createSigninJobs({
  exec = execCapture,
  spawn = nodeSpawn,
  homedir = os.homedir,
  timers = { setTimeout, clearTimeout },
  log = () => {},
  publish,
  refreshPanel,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  urlTimeoutMs = URL_TIMEOUT_MS,
  now = () => new Date(),
  suffix = () => randomBytes(2).toString('hex'),
  pluginRoot = null,
  // The account profiles, remembered in the plugin's storage; without one, they are remembered for this worker only.
  profiles = createAccountProfiles({ storage: memoryStorage(), log }),
}) {
  // The job holding each card's host. A host has at most one: a newer start replaces the older one.
  const active = new Map()
  // The host names with a job that has not yet released its login.
  const running = new Set()

  // The host's status, fresh: { report } or { message }.
  async function statusOf(settings, host) {
    const read = await createRunner({ settings, exec, homedir }).runJson(host, ['status', '--json'], { timeoutMs: STEP_TIMEOUT_MS })
    if (!read.ok) return { message: `The accounts on ${host.name} could not be read: ${clip(failureBody(read.failure))}` }
    return isRecord(read.value) ? { report: read.value } : { message: `The accounts on ${host.name} could not be read` }
  }

  // What a sign-in is for, from a fresh status of the card's host; never from the panel's word alone. A
  // re-authentication takes its account's e-mail and organization; another organization needs an engine that keeps
  // the organizations of a login apart, and an enrolled account of that e-mail. { target } or { message }.
  async function targetOf({ host, settings, account, email, mode, wantedOrganization }) {
    if (mode === 'add') return { target: { mode, account: null, email: null, organization: null, owner: null } }
    const status = await statusOf(settings, host)
    if (status.message) return status
    const accounts = enrolledIn(status.report)
    if (mode === 'reauth') {
      const record = accounts.find((a) => a.name === account)
      if (!record) return { message: `${account} is not enrolled on ${host.name}; refresh the panel` }
      const known = textOrNull(record.email)
      if (known === null) return { message: `The engine on ${host.name} does not know the e-mail of ${account}, so it cannot be signed in again here` }
      const organization = supportsOrganizations(status.report.version) ? textOrNull(record.organization_uuid) : null
      return { target: { mode, account, email: known, organization, owner: { name: account, email: known } } }
    }
    if (!supportsOrganizations(status.report.version)) return { message: updateEngineFirst(host.name) }
    const member = accounts.find((a) => sameText(textOrNull(a.email), email))
    if (!member) return { message: `No account of ${email} is enrolled on ${host.name}; refresh the panel` }
    const known = textOrNull(member.email)
    const wanted = wantedOrganization ?? null
    if (wanted !== null && accounts.some((a) => sameText(textOrNull(a.email), email) && textOrNull(a.organization_uuid) === wanted.uuid)) {
      return { message: `${wanted.name ?? 'That organization'} is already enrolled on ${host.name}; refresh the panel` }
    }
    return { target: { mode, account: null, email: known, organization: wanted?.uuid ?? null, organizationName: wanted?.name ?? null, owner: { name: member.name, email: known } } }
  }

  // Resolves at once with the outcome of the start; the job runs in the background after it. account names an
  // enrolled account to sign in again; organization true signs in another organization of the login of email (target,
  // { uuid, name }, names the one asked for, from the stored organizations of the login); neither signs in a new account.
  async function start({ host, settings, account = null, email = null, organization = false, target: wantedOrganization = null }) {
    if (account !== null && account.startsWith('-')) return { ok: false, message: 'That account name cannot be used for a sign-in' }
    const mode = organization === true ? 'organization' : account !== null ? 'reauth' : 'add'
    const wanted = mode === 'organization' ? textOrNull(email) : null
    if (mode === 'organization' && (wanted === null || wanted.startsWith('-'))) return { ok: false, message: 'That e-mail cannot be used for a sign-in' }
    const login = loginHostFor(settings, host)
    if (!login) return { ok: false, message: NO_REMOTE_HOST }
    const chosen = await chooseWorkspace({ exec, settings, homedir }, settings, pluginRoot)
    if (chosen.error) return { ok: false, message: clip(chosen.error) }
    if (chosen.none) return { ok: false, message: NO_WORKSPACE }
    const { workspace } = chosen
    // One sign-in per account, per login's other organization, or for a new account: a second click switches to it.
    const key = mode === 'reauth' ? `account:${account}` : mode === 'organization' ? `organization:${wanted.toLowerCase()}${wantedOrganization ? `:${wantedOrganization.uuid}` : ''}` : 'new'
    const current = active.get(host.name) ?? null
    if (current !== null && current.key === key && current.pageId !== null && !current.cancelled && !current.enrolling) {
      const shown = await orcaCall({ exec, settings, homedir }, ['tab', 'show', '--page', current.pageId])
      if (shown.ok) {
        await focusTab({ exec, settings, homedir }, current.pageId, current.workspace.selector, log)
        return { ok: true, message: ALREADY_OPEN }
      }
    }
    const found = await targetOf({ host, settings, account, email: wanted, mode, wantedOrganization: mode === 'organization' ? wantedOrganization : null })
    if (found.message) return { ok: false, message: found.message }
    const { target } = found
    const previous = active.get(host.name) ?? null
    previous?.cancel()
    const job = {
      host, settings, login, workspace, key,
      mode, account: target.account, email: target.email, organization: target.organization, organizationName: target.organizationName ?? null, owner: target.owner,
      cancelled: false, enrolling: false, dir: null, pageId: null, freshProfile: null, profileId: null, handle: null, loginExit: null,
      // The name the account was enrolled under once the enrolment succeeded; its fresh profile is then kept for it.
      enrolledAs: null, enrolledEmail: null,
      released: null, releaseDone: null, cancel: null,
    }
    job.released = new Promise((resolve) => { job.releaseDone = resolve })
    // Once the enrolment has begun the login is kept: a newer start waits for it instead.
    job.cancel = () => {
      if (job.enrolling || job.cancelled) return
      job.cancelled = true
      job.handle?.stop()
    }
    active.set(host.name, job)
    running.add(host.name)
    void execute(job, previous)
    return { ok: true, message: signingIn(job) }
  }

  // Runs the job after the one it replaces has released its login. Every path discards the login and closes the tab.
  async function execute(job, previous) {
    let outcome
    try {
      if (previous) await previous.released
      outcome = await attempt(job)
    } catch (err) {
      log(`grazr sign-in: ${describe(err)}`)
      outcome = toast(job.host.name, 'sign-in failed', 'The sign-in stopped before it finished.')
    }
    // The result shows at once; the cleanup's slow steps (the ssh discard, the tab close) follow.
    await refresh()
    try {
      await cleanup(job)
    } catch (err) {
      log(`grazr sign-in: cleanup failed: ${describe(err)}`)
    }
    release(job)
    try {
      await publish(outcome)
    } catch (err) {
      log(`grazr sign-in: notification failed: ${describe(err)}`)
    }
    await refresh()
  }

  async function refresh() {
    try {
      await refreshPanel()
    } catch (err) {
      log(`grazr sign-in: panel refresh failed: ${describe(err)}`)
    }
  }

  function release(job) {
    const name = job.host.name
    if (active.get(name) === job) {
      active.delete(name)
      running.delete(name)
    }
    job.releaseDone()
  }

  // A login directory is usable when it is an absolute path without NUL; quote carries any such path safely.
  const usableDir = (dir) => typeof dir === 'string' && dir.startsWith('/') && !dir.includes('\0')

  // Best effort: removes a directory mktemp printed but that is not usable, only when it is empty. Never throws.
  async function removeEmptyDir({ exec, settings }, login, dir) {
    try {
      await exec([settings.sshBin, ...settings.sshOptions, login.ssh, `rmdir -- ${quote(dir)}`], { timeoutMs: STEP_TIMEOUT_MS })
    } catch {
      // The directory stays; nothing else depends on it.
    }
  }

  // The login, the browser, the code, then the enrolment. Returns the toast for the outcome.
  async function attempt(job) {
    const { host, settings, login, workspace } = job
    const ctx = { exec, settings, homedir }
    if (job.cancelled) return cancelledToast(host)

    const made = { ...(await exec([settings.sshBin, ...settings.sshOptions, login.ssh, 'mktemp -d'], { timeoutMs: STEP_TIMEOUT_MS })), host: login.name, remote: true }
    if (!commandOk(made)) return stepFailedToast(host, login, made)
    const dir = lastLine(made.stdout)
    if (!usableDir(dir)) {
      // A directory that mktemp printed but that cannot be used is removed if it is empty; rmdir never removes more.
      if (dir) await removeEmptyDir(ctx, login, dir)
      return toast(host.name, 'sign-in failed', `${login.name} did not give a usable login directory.\nNothing was enrolled.`)
    }
    job.dir = dir
    if (job.cancelled) return cancelledToast(host)

    // The login's e-mail, never the account's name: the name of a further organization is not an e-mail.
    const args = ['auth', 'login', ...(job.email ? ['--email', job.email] : [])]
    const command = remoteLoginCommand({ dir, claudeBin: claudeBinOf(login), args })
    const handle = startLogin({ spawn, timers, settings, login, command, loginTimeoutMs, urlTimeoutMs })
    job.handle = handle
    handle.exit.then((exit) => { job.loginExit = exit })
    const reached = await handle.url
    const stopped = async () => {
      handle.stop()
      await handle.exit
    }
    if (job.cancelled) {
      await stopped()
      return cancelledToast(host)
    }
    if (!reached.url) {
      await stopped()
      // The overall limit can fire before the address appears; that is a timed-out sign-in, whatever the stream said.
      if (handle.timedOut) return toast(host.name, 'sign-in timed out', 'Nothing was enrolled.')
      if (reached.reason === 'timeout') {
        return toast(host.name, 'sign-in failed', `Claude did not print its sign-in address within ${urlTimeoutMs / 1000} s.\nNothing was enrolled.`)
      }
      return loginFailedToast(host, login, await handle.exit)
    }

    // The sign-in address must be one of Claude's own sites, over https, before anything is opened for it.
    if (!isSignInUrl(reached.url)) {
      await stopped()
      return toast(host.name, 'sign-in failed', `Claude's sign-in address is not on claude.ai, claude.com or anthropic.com, so nothing was opened.\nNothing was enrolled.`)
    }

    // The browser is Orca's, in the local workspace, in the login's own isolated profile.
    const profile = await profileFor(ctx, profiles, job.owner, now, suffix)
    if (profile.fresh && profile.created) job.freshProfile = profile.created
    if (profile.ok && !profile.fresh) job.profileId = profile.id
    if (job.cancelled) {
      await stopped()
      return cancelledToast(host)
    }
    if (!profile.ok) {
      await stopped()
      return orcaFailedToast(host, workspace.label, profile.message)
    }
    // A sign-in for a known organization asks claude.ai for it; the enrolment checks it either way.
    const authorizeUrl = job.organization !== null ? withOrganization(reached.url, job.organization) : reached.url
    const tab = await orcaCall(ctx, ['tab', 'create', '--worktree', workspace.selector, '--url', authorizeUrl, '--profile', profile.id])
    if (tab.ok && typeof tab.result?.browserPageId === 'string') job.pageId = tab.result.browserPageId
    if (job.pageId !== null) await focusTab(ctx, job.pageId, workspace.selector, log)
    if (job.pageId === null) {
      // A tab that failed or timed out may still have opened: close any on this address, then stop the login.
      await closeTabsAt(ctx, authorizeUrl)
      await stopped()
      return orcaFailedToast(host, workspace.label, tab.ok ? 'Orca did not return a tab' : tab.message)
    }

    // The user approves in the tab; the callback's code is relayed to the login, so nothing is copied by hand. Only a
    // callback carrying the state of the address this job opened is relayed; a short address without one leaves the
    // relay to learn it from the tab.
    const expectedState = new URL(reached.url).searchParams.get('state')
    // The sign-in pages are stepped in this tab: the e-mail (re-authentication only), Continue, the code box and the
    // consent. The code box itself is never typed into, and the identity is proved by the user alone.
    const automate = createStepper({
      call: (args) => orcaCall(ctx, args),
      log,
      notify: publish,
      host,
      page: job.pageId,
      workspace: workspace.selector,
      email: job.email,
      // Another organization is picked on the consent page, so that page is left to the user.
      approve: job.mode !== 'organization',
      authorizeUrl,
      isSignInPage: (url) => !offTheFlow(url) && isSignInUrl(url) && new URL(url).hostname !== CALLBACK_HOST,
    })
    const relayed = await relayCode({ ctx, page: job.pageId, workspace: workspace.selector, authorizeUrl, handle, timers, now, expectedState, cancelled: () => job.cancelled, log, automate })
    if (relayed === 'idle' || relayed === 'closed') {
      await stopped()
      if (job.cancelled) return cancelledToast(host)
      if (relayed === 'closed') return toast(host.name, 'sign-in failed', 'The sign-in tab was closed.\nNothing was enrolled.')
      return toast(host.name, 'sign-in timed out', 'Nothing was enrolled.')
    }
    const exit = await handle.exit
    if (job.cancelled) return cancelledToast(host)
    if (exit.timedOut) return toast(host.name, 'sign-in timed out', 'Nothing was enrolled.')
    if (exit.spawnError || exit.code !== 0) return loginFailedToast(host, login, exit)

    job.enrolling = true
    const done = await enrol(job, dir)
    job.enrolledAs = done.enrolled
    job.enrolledEmail = done.email ?? null
    return done.toast
  }

  // The card's host enrols the login. On the login host itself the directory is read there (enrol --from). On any other
  // host the export is read on the login host and piped to that host's engine as its stdin, never in an argument.
  // A re-authentication enrols under its account's name, expecting its e-mail and organization. A new login and another
  // organization read the export first, so the name is chosen once the login and organization signed in are known.
  // Resolves { toast, enrolled, email }: the outcome, and the name enrolled under when the enrolment succeeded.
  async function enrol(job, dir) {
    const { host, settings, login } = job
    const runner = createRunner({ settings, exec, homedir })
    const notFinished = { toast: notFinishedToast(host, login), enrolled: null }
    const here = host.name === login.name
    const enrolWith = async (name, expect, exported) => enrolOutcome(host, await (here
      ? runner.run(login, ['enrol', '--from', dir, '--name', name, ...expect, '--json'], { timeoutMs: STEP_TIMEOUT_MS })
      : runner.run(host, ['enrol', '--stdin', '--name', name, ...expect, '--json'], { timeoutMs: STEP_TIMEOUT_MS, input: exported.stdout })), name)
    if (job.mode === 'reauth') {
      const expect = ['--expect-email', job.email, ...(job.organization ? ['--expect-organization', job.organization] : [])]
      if (here) return enrolWith(job.account, expect, null)
      const exported = await runner.run(login, ['login-export', '--from', dir], { timeoutMs: STEP_TIMEOUT_MS })
      if (identityIn(exported) === null) return notFinished
      return enrolWith(job.account, expect, exported)
    }
    const exported = await runner.run(login, ['login-export', '--from', dir], { timeoutMs: STEP_TIMEOUT_MS })
    const identity = identityIn(exported)
    if (identity === null) return notFinished
    const status = await statusOf(settings, host)
    if (job.mode === 'add') {
      if (status.message) log(`grazr sign-in: ${status.message}; the account is named by its e-mail`)
      return enrolWith(newLoginName(identity, status.report ?? null).name, [], exported)
    }
    const chosen = organizationName(job, identity, status.report ?? null)
    if (chosen.refused) return { toast: toast(host.name, 'sign-in failed', `${clip(chosen.refused)}\nNothing was enrolled.`), enrolled: null }
    return enrolWith(chosen.name, ['--expect-email', job.email, '--expect-organization', chosen.organization], exported)
  }

  // Stops a job's login if it is still running, closes the browser tab and discards the login on the login host.
  // Every path runs it. It never throws.
  async function cleanup(job) {
    const ctx = { exec, settings: job.settings, homedir }
    // The login is stopped and has ended before its directory is discarded. A login that did not exit 0 is also ended
    // on the login host by its pid, since a dropped ssh connection does not hang up the remote process.
    if (job.handle) {
      job.handle.stop()
      await job.handle.exit
      if (job.handle.pid !== null && job.loginExit?.code !== 0) await stopRemoteLogin({ exec, settings: job.settings, log }, job.login, job.handle.pid)
      else if (job.handle.pid === null && job.loginExit?.code !== 0) log('grazr sign-in: remote login pid unknown; it ends by itself within 30 minutes')
    }
    if (job.pageId !== null) {
      try {
        const closed = await orcaCall(ctx, ['tab', 'close', '--page', job.pageId])
        if (!closed.ok) log(`grazr sign-in: the browser tab did not close: ${closed.message}`)
      } catch (err) {
        log(`grazr sign-in: tab close failed: ${describe(err)}`)
      }
    }
    if (job.dir !== null) {
      try {
        const discarded = await createRunner(ctx).run(job.login, ['login-discard', '--from', job.dir], { timeoutMs: STEP_TIMEOUT_MS })
        if (!commandOk(discarded)) log(`grazr sign-in: the login on ${job.login.name} was not discarded`)
      } catch (err) {
        log(`grazr sign-in: discard failed: ${describe(err)}`)
      }
    }
    // The login's own profile is remembered for the name a further organization was enrolled under too.
    if (job.profileId !== null && job.enrolledAs !== null) await profiles.remember({ name: job.enrolledAs, email: job.enrolledEmail ?? job.email }, job.profileId)
    // A fresh profile whose account was enrolled is now that account's, signed in: it is kept and remembered. Any other
    // goes once its tab is closed, since Orca will not delete a profile a tab still uses.
    if (job.freshProfile !== null) {
      try {
        // Without an id (the list after the create failed), the profile is found again by its label.
        const id = job.freshProfile.id ?? (await profileIdByLabel(ctx, job.freshProfile.label))
        if (id === null) {
          log(`grazr sign-in: the fresh browser profile could not be found to ${job.enrolledAs === null ? 'delete' : 'keep'}`)
        } else if (job.enrolledAs !== null) {
          await profiles.remember({ name: job.enrolledAs, email: job.enrolledEmail }, id)
          log(`grazr sign-in: the browser profile is kept for ${job.enrolledAs}`)
        } else {
          const deleted = await orcaCall(ctx, ['tab', 'profile', 'delete', '--profile', id])
          if (!deleted.ok) log(`grazr sign-in: the fresh browser profile was not deleted: ${deleted.message}`)
        }
      } catch (err) {
        log(`grazr sign-in: profile ${job.enrolledAs === null ? 'delete' : 'keep'} failed: ${describe(err)}`)
      }
    }
  }

  return { start, running }
}
