import os from 'node:os'
import * as nodeFs from 'node:fs/promises'
import { spawn as nodeSpawn } from 'node:child_process'
import { execCapture } from './exec.mjs'
import { expandTilde } from './paths.mjs'
import { createRunner } from './runner.mjs'
import { createDeploy } from './deploy.mjs'
import { createDrainLoop } from './drain.mjs'
import { createPanelRefresher } from './panel-refresh.mjs'
import { DEFAULT_SETTINGS, mergeSettings, currentTarget, hostFor, nextTarget, engineEnv, enginePath, isRemote, forceInstallFor } from './hosts.mjs'
import { toast, formatStatus, formatFailure, failureBody } from './toast.mjs'
import { join, quote } from './shell-quote.mjs'
import { describe } from './errors.mjs'
import { readBundledVersion as readBundledEngineVersion } from './engine-version.mjs'
import { createSigninJobs } from './signin.mjs'
import { createFocus } from './focus.mjs'
import { orderedAccounts, severalOrganizationNames } from './panel-data.mjs'
import { createAccountProfiles } from './browser-profiles.mjs'
import { RESET_KINDS, SEVERAL_ORGANIZATIONS, useLimitReset } from './limit-reset-use.mjs'
import { READINGS_KEY, loadReadings, nextReading } from './limit-reset-readings.mjs'
import { readLimitResets } from './usage-page-reader.mjs'
import { ORGANIZATIONS_KEY, loadOrganizations, organizationFor, organizationsFor } from './organizations.mjs'
import { createLimitResetSchedule } from './limit-reset-schedule.mjs'
import { migrateOldLocalDefault, recordShimNotifier, syncLocalShims } from './local-notifier.mjs'

// The focused workspace is read at most this often for a palette command; the worker follows it every FOLLOW_MS.
const FOCUS_CACHE_MS = 3000
const FOLLOW_MS = 3000
// A page is open while it asks the worker anything this often: a visible page polls the focused host every 4 s.
const PANEL_OPEN_MS = 15000

// Orca kills a command at 30 s; the rest of the budget covers loading settings before and publishing after.
const INSTALL_BUDGET_MS = 25000

// The engine's stable refusal for a foreign owner; its text ends with a how-to that does not name forceInstall.
const FOREIGN_OWNER_PREFIX = "Claude's status line or StopFailure hook already belongs"
const TAKEOVER_HINT = 'Set forceInstall: true for this host to take it over.'

const isObject = (v) => v !== null && typeof v === 'object'

// The account a panel's swap or enrol names, or null when the params name none.
const accountOf = (params) => (isObject(params) && typeof params.account === 'string' && params.account !== '' ? params.account : null)

const textOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null)

// The e-mail a report gives the named account, or null.
const emailIn = (report, name) => textOrNull((Array.isArray(report?.accounts) ? report.accounts : []).find((a) => isObject(a) && a.name === name)?.email)

// The text a toast shows, which is also the message the panel shows for the command.
const messageOf = (t) => (t.body ? `${t.title}\n${t.body}` : t.title)

// A toast for an engine line command: its lines on success, the classified failure otherwise.
const linesToast = (h, title, result) =>
  result.ok ? toast(h.name, title, result.lines.join('\n')) : formatFailure(h.name, result.failure, title)

export async function createGrazrPlugin({
  orca,
  exec = execCapture,
  spawn = nodeSpawn,
  homedir = os.homedir,
  root,
  timers = { setTimeout, clearTimeout },
  now = Date.now,
  log = (msg) => orca.log(msg),
  fs = nodeFs,
  readTemplate = () => fs.readFile(`${root}/panel/template.html`, 'utf8'),
  readBundledVersion = () => readBundledEngineVersion({ root, fs }),
  sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)),
}) {
  const host = (name, params) => orca.host.call(name, params)

  // A toast that cannot be shown must not fail the command that produced it.
  async function publish(t) {
    try {
      await host('notifications.show', t)
    } catch (err) {
      log(`grazr: notification failed: ${describe(err)}`)
    }
  }
  // Shows the toast and returns the command's outcome for the panel: ok, and the same text as its message.
  const say = async (ok, t) => {
    await publish(t)
    return { ok, message: messageOf(t) }
  }
  // The host a panel names must be configured; the message says so, and the command runs nowhere.
  const unknownHost = (params) => say(false, { title: `unknown host ${params?.host ?? 'for this command'}; refresh the panel`, body: '' })

  const storage = {
    get: async (key) => (await host('storage.get', { key }))?.value,
    set: (key, value) => host('storage.set', { key, value }),
  }

  const readSettings = async () => (await host('settings.get', {}))?.settings

  // A failed read must not fail the command: the defaults still let it run, and the log says why.
  async function loadSettings() {
    try {
      return mergeSettings(await readSettings())
    } catch (err) {
      log(`grazr: settings unavailable, using defaults: ${describe(err)}`)
      return mergeSettings(undefined)
    }
  }

  async function seedSettings(stored) {
    const object = isObject(stored) ? stored : {}
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in object)) await host('settings.set', { key, value: structuredClone(DEFAULT_SETTINGS[key]) })
    }
  }

  // Runner and deploy take settings at construction, so each command builds them from fresh settings.
  const toolsFor = (settings) => ({
    runner: createRunner({ settings, exec, homedir }),
    deploy: createDeploy({ settings, exec, homedir, root }),
  })

  // Races the work against a clock; onExpire runs first so the work can stop itself at its next step.
  function withBudget(promise, ms, onExpire) {
    let handle
    const expired = new Promise((resolve) => {
      handle = timers.setTimeout(() => {
        onExpire()
        resolve({ ok: false, failure: { kind: 'timeout', detail: `exceeded ${ms / 1000}s` } })
      }, ms)
    })
    return Promise.race([promise, expired]).finally(() => timers.clearTimeout(handle))
  }

  // Each command shows one toast, or a grazr: toast with the error message if anything throws.
  // It resolves to { ok, message } either way, so the panel can show the result and nothing rejects.
  const guard = (id, fn) => async (params) => {
    try {
      return await fn(params)
    } catch (err) {
      log(`grazr ${id}: ${describe(err)}`)
      return say(false, toast('grazr', describe(err)))
    }
  }

  async function targetNext() {
    const settings = await loadSettings()
    const { host: next, index, count } = nextTarget(settings)
    await host('settings.set', { key: 'target', value: next.name })
    return say(true, toast('grazr', `Target: ${next.name} (${index}/${count})`))
  }

  // Returns the per-host [{ host, result }] it collected, so the panel refresh that follows need not ask again,
  // and { ok, message } for the panel: the same per-host texts the toasts show.
  async function status() {
    const settings = await loadSettings()
    const { runner } = toolsFor(settings)
    // One host throwing must not lose the other hosts' toasts or the stored record.
    const statusOf = async (h) => {
      try {
        const result = await runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
        const t = result.ok ? formatStatus(h.name, result.value) : formatFailure(h.name, result.failure, 'status')
        await publish(t)
        return { host: h, result, text: messageOf(t) }
      } catch (err) {
        const t = toast('grazr', describe(err))
        await publish(t)
        return { host: h, result: { ok: false, failure: { kind: 'error', detail: describe(err) } }, text: messageOf(t) }
      }
    }
    const collected = await Promise.all(settings.hosts.map(statusOf))
    const at = now()
    const record = Object.fromEntries(collected.map(({ host, result }) => [
      host.name,
      result.ok ? { at, ok: true, report: result.value } : { at, ok: false, failure: result.failure },
    ]))
    // The record is for the status view; a failed save must not stop the panel from the same results.
    try {
      await storage.set('lastStatus', record)
    } catch (err) {
      log(`grazr: lastStatus not saved: ${describe(err)}`)
    }
    const results = collected.map(({ host, result }) => ({ host, result }))
    return {
      results,
      outcome: { ok: results.every(({ result }) => result.ok), message: collected.map((c) => c.text).join('\n') },
    }
  }

  // The engine runs on the host the params name; a palette call uses pick, which is the focused workspace's host unless said otherwise.
  async function runOn(params, args, timeoutMs, title, pick = actionHost) {
    const settings = await loadSettings()
    const h = await pick(settings, params)
    if (!h) return unknownHost(params)
    const result = await toolsFor(settings).runner.runLines(h, args, { timeoutMs })
    return say(result.ok, linesToast(h, title, result))
  }

  // With params.enabled a boolean, the rotation is set to it; otherwise it is flipped from its current state.
  async function rotationToggle(params) {
    const settings = await loadSettings()
    const h = await actionHost(settings, params)
    if (!h) return unknownHost(params)
    const { runner } = toolsFor(settings)
    const wanted = isObject(params) ? params.enabled : undefined
    if (typeof wanted === 'boolean') {
      const set = await runner.runLines(h, ['set', 'ENABLED', wanted ? '1' : '0'], { timeoutMs: 10000 })
      if (!set.ok) return say(false, formatFailure(h.name, set.failure, 'rotation'))
      return say(true, toast(h.name, `rotation ${wanted ? 'on' : 'off'}`))
    }
    const current = await runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
    if (!current.ok) return say(false, formatFailure(h.name, current.failure, 'rotation'))
    const enabled = Boolean(current.value.settings?.enabled)
    const set = await runner.runLines(h, ['set', 'ENABLED', enabled ? '0' : '1'], { timeoutMs: 10000 })
    if (!set.ok) return say(false, formatFailure(h.name, set.failure, 'rotation'))
    return say(true, toast(h.name, `rotation ${enabled ? 'off' : 'on'}`))
  }

  // The engine decides about a foreign owner or a user's own bar; the plugin only passes --force through.
  // Once the budget has expired its toast is already out, so a cancelled sequence stops before its next step.
  // Resolves to { ok, t }: whether the install worked, and the toast that says so.
  async function installSteps(settings, h, budget) {
    const { runner, deploy } = toolsFor(settings)
    const deployed = await deploy.deploy(h, { timeoutMs: 15000 })
    if (budget.cancelled) return null
    if (!deployed.ok) return { ok: false, t: formatFailure(h.name, deployed.failure, 'deploy') }
    const install = await runner.runLines(h, ['install', ...(forceInstallFor(settings, h) ? ['--force'] : [])], { timeoutMs: 8000 })
    if (install.ok) await recordShimNotifier(storage, h).catch((err) => log(`grazr: could not record notifier: ${describe(err)}`))
    return { ok: install.ok, t: installToast(h, install) }
  }

  // A refused install shows the engine's line in the body; a foreign owner also gets the hint to set forceInstall.
  function installToast(h, result) {
    if (result.ok || result.failure.kind !== 'engine' || !result.failure.detail.startsWith(FOREIGN_OWNER_PREFIX)) {
      return linesToast(h, 'install', result)
    }
    return toast(h.name, 'install failed', `${failureBody(result.failure)}\n${TAKEOVER_HINT}`)
  }

  async function install(params) {
    const settings = await loadSettings()
    const h = hostFor(settings, params)
    if (!h) return unknownHost(params)
    const budget = { cancelled: false }
    const outcome = await withBudget(installSteps(settings, h, budget), INSTALL_BUDGET_MS, () => { budget.cancelled = true })
    if (outcome.failure?.kind === 'timeout') {
      return say(false, toast(h.name, 'install timed out', 'install may still be finishing; run Grazr: Status (all hosts) to check'))
    }
    return say(outcome.ok, outcome.t)
  }

  async function drainNow() {
    await drain.tick({ force: true, deadline: now() + COMMAND_BUDGET_MS })
    return say(true, toast('grazr', 'drained'))
  }

  // The text is typed, not run, so the user reads it and presses Return themselves.
  function commandText(settings, h, args) {
    if (isRemote(h)) {
      const inner = toolsFor(settings).runner.command(h, args).argv.at(-1)
      return `ssh -t ${quote(h.ssh)} ${quote(inner)}`
    }
    const assignments = Object.entries(engineEnv(settings, h)).map(([k, v]) => `${k}=${quote(expandTilde(v, homedir))}`)
    const argv = [expandTilde(h.python, homedir), expandTilde(enginePath(settings), homedir), ...args]
    return [...assignments, join(argv)].join(' ')
  }

  // One Orca browser profile per account, remembered in the plugin's storage: sign-ins and claude.ai opens share it.
  const profiles = createAccountProfiles({ storage, log })
  // The panel is a view of the same hosts, so every command that changes a host ends by regenerating it.
  // The sign-in job runs after the command has returned, so it refreshes the panel itself with its own budget.
  const signin = createSigninJobs({
    exec,
    spawn,
    homedir,
    timers,
    log,
    publish,
    refreshPanel: () => refreshPanel({ deadline: now() + COMMAND_BUDGET_MS }),
    pluginRoot: root,
    profiles,
  })

  // The name and e-mail of the host's active account, read from a fresh status: { account, email } or { failure }.
  async function activeAccountOf(settings, h) {
    const current = await toolsFor(settings).runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
    if (!current.ok) return { failure: current.failure }
    const name = current.value?.active?.name
    if (typeof name !== 'string' || name === '') return { account: null, email: null }
    return { account: name, email: emailIn(current.value, name) ?? textOrNull(current.value.active.email) }
  }

  // The named account as { name, email }, its e-mail from a fresh status; without one, the name alone still finds its profile.
  async function namedAccountOf(settings, h, name) {
    const current = await toolsFor(settings).runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
    return { name, email: current.ok ? emailIn(current.value, name) : null }
  }

  // Opens claude.ai as the account in Orca's browser, in its login's profile: { ok, message }. The account named,
  // else the host's active one; with nobody logged in, it says so.
  async function openClaudeAs(settings, h, account) {
    let target
    if (account === null) {
      const active = await activeAccountOf(settings, h)
      if (active.failure) return { ok: false, message: messageOf(formatFailure(h.name, active.failure, 'status')) }
      if (active.account === null) return { ok: false, message: `${h.name}: nobody is logged in, so there is no account to open claude.ai as` }
      target = { name: active.account, email: active.email }
    } else {
      target = await namedAccountOf(settings, h, account)
    }
    return profiles.openClaude({ exec, settings, homedir }, settings, target, root)
  }

  // The panel's and the palette's Open claude.ai: the account named, else the server's active account.
  async function openBrowser(params) {
    const settings = await loadSettings()
    const h = await actionHost(settings, params)
    if (!h) return unknownHost(params)
    const opened = await openClaudeAs(settings, h, accountOf(params))
    return say(opened.ok, toast(h.name, opened.ok ? 'claude.ai' : 'claude.ai not opened', opened.message))
  }

  // A swap the user asked for, then claude.ai as the account swapped to. The browser opens after the swap has answered,
  // in the background, so the swap keeps its own budget; its outcome comes as a toast.
  async function swap(params) {
    const settings = await loadSettings()
    const h = await actionHost(settings, params)
    if (!h) return unknownHost(params)
    const account = accountOf(params)
    const result = await toolsFor(settings).runner.runLines(h, account ? ['swap', account] : ['swap'], { timeoutMs: 15000 })
    const outcome = await say(result.ok, linesToast(h, 'swap', result))
    if (!result.ok || !settings.browserOnSwap) return outcome
    void openClaudeAs(settings, h, account)
      .then((opened) => publish(toast(h.name, opened.ok ? 'claude.ai' : 'claude.ai not opened', opened.message)))
      .catch((err) => log(`grazr swap: claude.ai was not opened: ${describe(err)}`))
    return { ...outcome, message: `${outcome.message}\nOpening claude.ai as ${account ?? 'the active account'}…` }
  }
  // The focused workspace's host: the panel polls it, and the palette shows it.
  const focus = createFocus({ exec, homedir, now, log })
  // Every read of the focus is kept, so a palette command within FOCUS_CACHE_MS uses the last read.
  let focusSeen = null
  async function readFocus(settings) {
    const { ok, host: name } = await focus.current(settings)
    focusSeen = { at: now(), ok, host: name }
    return focusSeen
  }
  async function focusedHost(settings) {
    if (focusSeen && now() - focusSeen.at <= FOCUS_CACHE_MS) return focusSeen
    return readFocus(settings)
  }
  // Install and uninstall keep the target for a palette call, as their titles say.
  const hostNamed = async (settings, params) => hostFor(settings, params)
  // The host a command acts on: a panel call names its host; a palette call (no params) acts on the focused workspace's
  // server, and on the target when the focus is unknown or names no configured host.
  async function actionHost(settings, params) {
    if (params !== undefined) return hostFor(settings, params)
    const seen = await focusedHost(settings)
    const focused = seen.ok && seen.host ? settings.hosts.find((h) => h.name === seen.host) : undefined
    return focused ?? currentTarget(settings)
  }
  async function activeHost(params) {
    const settings = await loadSettings()
    const { ok, host } = await readFocus(settings)
    if (params !== undefined) return { ok, message: '', host }
    const t = ok
      ? toast('grazr', `Focused workspace: ${host ?? 'no configured host'}`)
      : toast('grazr', 'Focused workspace: unknown', "Orca's session could not be read; see the log")
    return { ...(await say(ok, t)), host }
  }

  // Orca 1.4.246+ routes a page's plugin.request to the handlers below, and the worker's posts to the open pages.
  const pageBridge = typeof orca.panels?.handle === 'function'
  const post = typeof orca.panels?.post === 'function' ? (parts) => orca.panels.post('panel', parts) : null
  let panelSeenAt = -Infinity
  const panelOpen = () => now() - panelSeenAt <= PANEL_OPEN_MS
  const panel = createPanelRefresher({ loadSettings, toolsFor, commandText, readTemplate, readBundledVersion, root, fs, log, now, post, panelOpen, loadLimitResets: () => loadReadings(storage, log), loadOrganizations: () => loadOrganizations(storage, log) })
  const refreshPanel = (options) => panel.refresh(options)
  // Orca kills a command at 30 s; the panel refresh gets what a 28 s budget leaves after the command's own work.
  const COMMAND_BUDGET_MS = 28000
  const thenPanel = (fn) => async (params) => {
    const deadline = now() + COMMAND_BUDGET_MS
    const outcome = await fn(params)
    await refreshPanel({ deadline })
    return outcome
  }
  // The status command hands its own results to the panel, so the hosts are asked once per press.
  const statusThenPanel = async () => {
    const deadline = now() + COMMAND_BUDGET_MS
    const { results, outcome } = await status()
    await refreshPanel({ results, deadline })
    return outcome
  }

  // The accounts enrolled on the host named (null: on every host) as { name, email, organizationUuid, several }, from a
  // fresh status of each, without duplicates. several marks an organization of a login with two or more enrolled.
  async function enrolledAccounts(settings, hostName) {
    const named = hostName === null ? undefined : settings.hosts.find((h) => h.name === hostName)
    const { runner } = toolsFor(settings)
    const lists = await Promise.all((named ? [named] : settings.hosts).map(async (h) => {
      try {
        const result = await runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
        if (!result.ok || !isObject(result.value)) return []
        const several = severalOrganizationNames(result.value)
        return orderedAccounts(result.value).filter((a) => !a.missing && typeof a.name === 'string' && a.name !== '')
          .map((a) => ({ name: a.name, email: textOrNull(a.email), organizationUuid: textOrNull(a.organization_uuid), several: several.has(a.name) }))
      } catch (err) {
        log(`grazr limit resets: the accounts of ${h.name} were not read: ${describe(err)}`)
        return []
      }
    }))
    const seen = new Set()
    return lists.flat().filter((a) => !seen.has(a.name) && seen.add(a.name))
  }

  // Each account's limit resets and its login's organizations, read from claude.ai in its login's browser profile: every
  // 3 hours, and after a Refresh. The organizations are stored here; the readings by the schedule. A reading that lands
  // redraws the panel.
  async function readAll({ settings, accounts, previous }) {
    const read = await readLimitResets({ ctx: { exec, settings, homedir }, accounts, profiles, pluginRoot: root, previous, organizations: await loadOrganizations(storage, log), now, log })
    if (read === null) return null
    try {
      await storage.set(ORGANIZATIONS_KEY, read.organizations)
    } catch (err) {
      log(`grazr organizations: the lists were not stored: ${describe(err)}`)
    }
    return read.readings
  }
  const limitResets = createLimitResetSchedule({
    loadSettings,
    enrolledAccounts,
    read: readAll,
    storage,
    timers,
    now,
    log,
    afterRun: () => refreshPanel(),
  })

  // Refresh answers with the usage first; the claude.ai reading of that server's accounts follows in the background.
  async function refreshUsage(params) {
    const outcome = await thenPanel((p) => runOn(p, ['refresh'], 20000, 'refresh'))(params)
    void (async () => {
      const h = await actionHost(await loadSettings(), params)
      if (h) await limitResets.run({ host: h.name })
    })().catch((err) => log(`grazr limit resets: not read after the refresh: ${describe(err)}`))
    return outcome
  }

  async function typeIntoTerminal(subcommand) {
    const context = await host('workspace.readContext', {})
    // The newest terminal is the last one listed; the user opens a shell right before running the command.
    const terminal = context?.terminals?.at(-1)
    if (!terminal) return say(false, toast('grazr', 'Open a shell terminal in this worktree first'))
    const settings = await loadSettings()
    const text = commandText(settings, currentTarget(settings), [subcommand])
    await host('terminal.sendText', { terminalId: terminal.id, text, enter: false })
    return say(true, toast('grazr', 'Typed into the newest terminal of this worktree', 'Open a shell right before running this if it landed in an agent pane.'))
  }

  // The accounts whose reset is under way: a second press for one of them is refused, never queued, so it cannot spend twice.
  const resetting = new Set()

  // Uses the reset on claude.ai for the account, in turn with the scheduled reads, and stores the reading it ends with so
  // the panel shows it at once. target is { account: { name, email }, organization, several }.
  async function useAndStore(settings, target, kind) {
    const { name } = target.account
    return limitResets.exclusive(async () => {
      const used = await useLimitReset({ ctx: { exec, settings, homedir }, ...target, kind, profiles, pluginRoot: root, sleep, log })
      if (used.outcome) {
        try {
          const previous = await loadReadings(storage, log)
          await storage.set(READINGS_KEY, { ...previous, [name]: nextReading(previous[name], used.outcome, now()) })
        } catch (err) {
          log(`grazr limit reset: the reading of ${name} was not stored: ${describe(err)}`)
        }
      }
      return used
    })
  }

  // The reset, then fresh usage for the host. A parked account stays parked: the reset is never followed by a swap (its
  // Switch does that). Each outcome comes as a toast.
  async function runReset(settings, h, target, kind) {
    const account = target.account.name
    const used = await useAndStore(settings, target, kind)
    const what = used.label ?? `${kind === 'full' ? 'Full' : 'Model'} reset`
    if (!used.ok) {
      const title = used.clicked === false ? `${what} not used for ${account}` : `${what} of ${account} not confirmed`
      await publish(toast(h.name, title, used.message))
      await refreshPanel({ deadline: now() + COMMAND_BUDGET_MS })
      return
    }
    await publish(toast(h.name, `${what} used for ${account}`, `claude.ai now counts ${used.now} ${kind === 'full' ? 'full' : 'model'} reset${used.now === 1 ? '' : 's'} (was ${used.was})`))
    const { runner } = toolsFor(settings)
    const refreshed = await runner.runLines(h, ['refresh'], { timeoutMs: 20000 })
    if (!refreshed.ok) log(`grazr limit reset: the usage of ${h.name} was not refreshed: ${messageOf(linesToast(h, 'refresh', refreshed))}`)
    await refreshPanel({ deadline: now() + COMMAND_BUDGET_MS })
  }

  // The account a reset is used for, with its login's e-mail and its organization from a fresh status (an engine before
  // fork.16 reports none: its login's only subscription organization stands in). { account, organization, several }.
  async function resetTarget(report, name) {
    const record = (Array.isArray(report?.accounts) ? report.accounts : []).find((a) => isObject(a) && a.name === name) ?? null
    const email = record ? textOrNull(record.email) : null
    const several = report ? severalOrganizationNames(report).has(name) : false
    let organization = null
    const uuid = record ? textOrNull(record.organization_uuid) : null
    const listed = email === null ? [] : organizationsFor(await loadOrganizations(storage, log), email)
    const org = organizationFor(uuid, listed)
    if (org !== null) organization = { uuid: org.uuid, name: org.name ?? org.label ?? org.uuid }
    else if (uuid !== null) organization = { uuid, name: textOrNull(record.organization) ?? uuid }
    return { account: { name, email }, organization, several }
  }

  // Uses a limit reset on claude.ai in one press: the account named (a parked one, which stays parked), else the host's
  // active account. The page work outlasts a command's 30 s, so it runs on after the command answers.
  const limitReset = (id) => async (params) => {
    const settings = await loadSettings()
    const h = await actionHost(settings, params)
    if (!h) return unknownHost(params)
    const kind = RESET_KINDS[id]
    let account = accountOf(params)
    const current = await toolsFor(settings).runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
    if (account === null) {
      if (!current.ok) return say(false, formatFailure(h.name, current.failure, 'limit reset'))
      const name = current.value?.active?.name
      if (typeof name !== 'string' || name === '') return say(false, toast(h.name, 'limit reset not used', 'nobody is logged in, so there is no account to use a reset of'))
      account = name
    }
    // A parked account is still offered its reset when the status could not be read, as before.
    const target = await resetTarget(current.ok ? current.value : null, account)
    if (target.several && target.organization === null) {
      return say(false, toast(h.name, 'limit reset not used', `${account}: ${SEVERAL_ORGANIZATIONS}`))
    }
    const what = kind === 'full' ? 'full' : 'model'
    if (resetting.has(account)) return say(false, toast(h.name, `a reset of ${account} is already under way`, 'Its result comes as a notification.'))
    resetting.add(account)
    void runReset(settings, h, target, kind)
      .catch((err) => log(`grazr limit reset: ${account}: ${describe(err)}`))
      .finally(() => resetting.delete(account))
    return say(true, toast(h.name, `Using a ${what} reset of ${account} on claude.ai…`, 'The result comes as a notification.'))
  }

  // The sign-in's outcome as the toast the command shows: its message, which says what the job is doing.
  const signinToast = (h, outcome) => say(outcome.ok, toast(h.name, outcome.ok ? 'sign-in' : 'sign-in failed', outcome.message))

  // The palette's Re-authenticate: the first blocked account in rotation order gets a sign-in; with none, the toast says so.
  async function reauth(params) {
    const settings = await loadSettings()
    const h = await actionHost(settings, params)
    if (!h) return unknownHost(params)
    const { runner } = toolsFor(settings)
    const current = await runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
    if (!current.ok) return say(false, formatFailure(h.name, current.failure, 'reauth'))
    const blocked = orderedAccounts(current.value).find((a) => typeof a.blocked === 'string' && a.blocked !== '')
    if (!blocked) return say(true, toast(h.name, 'no blocked account'))
    return signinToast(h, await signin.start({ host: h, settings, account: blocked.name }))
  }

  // The palette's Add an account: a sign-in for a new account on the focused workspace's server.
  async function addAccount(params) {
    const settings = await loadSettings()
    const h = await actionHost(settings, params)
    if (!h) return unknownHost(params)
    return signinToast(h, await signin.start({ host: h, settings }))
  }

  // Sign in another organization of a login: the login named by the panel's group, else the active one of the focused
  // workspace's server. The user picks the organization on claude.ai; the sign-in job checks the e-mail against a fresh
  // status and refuses an engine that would overwrite the login's first organization. A discovered organization's
  // Sign in names it: the organization is then the one stored for that login, never the panel's word alone.
  async function signInOrganization(params) {
    const settings = await loadSettings()
    const h = await actionHost(settings, params)
    if (!h) return unknownHost(params)
    let email = isObject(params) ? textOrNull(params.email) : null
    const asked = isObject(params) ? textOrNull(params.organization) : null
    let target = null
    if (asked !== null) {
      const org = email === null ? null : organizationsFor(await loadOrganizations(storage, log), email).find((o) => o.uuid === asked && o.claudeCode === true)
      if (!org) return { ok: false, message: messageOf(toast(h.name, 'sign-in failed', 'That organization is not one Grazr found for this login on claude.ai; refresh the panel')) }
      target = { uuid: org.uuid, name: org.name ?? org.label ?? org.uuid }
    }
    if (email === null) {
      const active = await activeAccountOf(settings, h)
      if (active.failure) return say(false, formatFailure(h.name, active.failure, 'sign-in'))
      if (active.email === null) return say(false, toast(h.name, 'sign-in failed', 'nobody is logged in, so there is no login to add an organization of'))
      email = active.email
    }
    const outcome = await signin.start({ host: h, settings, email, organization: true, target })
    return params === undefined ? signinToast(h, outcome) : outcome
  }

  // The panel's enrol starts a sign-in on the card's host: the browser opens now, the outcome comes later as a toast.
  async function startSignin(params) {
    const settings = await loadSettings()
    const h = await actionHost(settings, params)
    if (!h) return unknownHost(params)
    return signin.start({ host: h, settings, account: accountOf(params) })
  }

  const titles = {
    written: 'panel updated',
    posted: 'panel updated',
    unchanged: 'panel unchanged',
    skipped: 'panel not writable (installed plugin)',
    failed: 'panel refresh failed',
    'no-budget': 'panel refresh skipped, no budget left',
  }
  // From the palette the outcome is a notification; from the panel it is only the card's message, so the page's
  // wake-up on an old page raises no notification.
  async function panelRefresh(params) {
    const outcome = await refreshPanel({ deadline: now() + COMMAND_BUDGET_MS })
    const ok = outcome === 'written' || outcome === 'posted' || outcome === 'unchanged'
    if (params === undefined) return say(ok, toast('grazr', titles[outcome]))
    return { ok, message: messageOf(toast('grazr', titles[outcome])) }
  }

  // Each handler takes the panel's params (or undefined from the palette) and resolves to { ok, message }.
  const commands = {
    // The page selects the target again: a followed workspace's host stops overriding it until the workspace changes.
    'target-next': async () => {
      const deadline = now() + COMMAND_BUDGET_MS
      const outcome = await targetNext()
      await refreshPanel({ target: null, deadline })
      return outcome
    },
    status: statusThenPanel,
    swap: thenPanel(swap),
    refresh: refreshUsage,
    'rotation-toggle': thenPanel(rotationToggle),
    reauth,
    'add-account': addAccount,
    'sign-in-organization': signInOrganization,
    'open-browser': openBrowser,
    install: thenPanel(install),
    uninstall: thenPanel((params) => runOn(params, ['uninstall'], 8000, 'uninstall', hostNamed)),
    'drain-now': drainNow,
    // Only the palette calls enrol with no params (undefined); a panel call, even an empty object, starts a sign-in on its host.
    enrol: (params) => (params === undefined ? typeIntoTerminal('enrol') : startSignin(params)),
    'status-terminal': () => typeIntoTerminal('status'),
    'limit-reset-model': limitReset('limit-reset-model'),
    'limit-reset-full': limitReset('limit-reset-full'),
    'panel-refresh': panelRefresh,
    'active-host': activeHost,
  }

  // Events only wake the drain loop; the first one of each kind is logged so the trigger is visible.
  const logged = new Set()
  const onEvent = (name) => async () => {
    const settings = await loadSettings()
    if (!settings.drainEnabled) {
      if (!logged.has(`${name}:off`)) {
        logged.add(`${name}:off`)
        log(`grazr: ${name} does not start the drain loop, drainEnabled is false`)
      }
      return
    }
    startDrain()
    if (!logged.has(name)) {
      logged.add(name)
      log(`grazr: ${name} starts the drain loop`)
    }
  }

  // Activation must survive a failed settings read or seed: a rejection here means no command ever registers.
  let stored
  let moved = []
  try {
    stored = await readSettings()
    const empty = !isObject(stored) || Object.keys(stored).length === 0
    if (empty && (await storage.get('seeded'))) {
      // A file emptied after seeding is a broken edit, so the defaults stand in and nothing is written over it.
      const message = 'settings.json is empty or unreadable; using defaults until it is fixed'
      log(`grazr: ${message}`)
      await publish(toast('grazr', message))
      stored = undefined
    } else {
      moved = await migrateOldLocalDefault({ stored, host, storage, log })
      await seedSettings(stored)
      await storage.set('seeded', true)
    }
  } catch (err) {
    log(`grazr: settings unavailable at activation, using defaults: ${describe(err)}`)
  }
  const settings = mergeSettings(stored)
  void syncLocalShims({ settings, runner: toolsFor(settings).runner, storage, log, moved }).catch((err) => log(`grazr: notifier sync failed: ${describe(err)}`))

  // The drain loop re-reads settings on every tick, so edits take effect without a restart.
  const drain = createDrainLoop({
    loadSettings,
    runnerFor: (fresh) => createRunner({ settings: fresh, exec, homedir }),
    host,
    log,
    timers,
    now,
    storage,
    afterTick: refreshPanel,
  })

  // Official Orca before 1.4.246 runs none of the panel's calls, so its focus poll cannot run there. While the drain loop runs, the worker
  // follows the focused workspace instead: each change of its host re-renders the page with that host selected. Only a
  // change re-renders; the focus is read every FOLLOW_MS in between. The target setting is not written.
  // With the page bridge the page polls the focused host itself, so the worker never rewrites the page for a workspace change.
  let followHandle = null
  let followed = null
  async function followOnce() {
    const seen = await readFocus(await loadSettings())
    if (!seen.ok || !seen.host || seen.host === followed) return
    followed = seen.host
    await refreshPanel({ target: followed, deadline: now() + COMMAND_BUDGET_MS })
  }
  async function followTick() {
    followHandle = null
    if (!drain.isRunning()) return
    try {
      await followOnce()
    } catch (err) {
      log(`grazr follow: ${describe(err)}`)
    }
    if (drain.isRunning() && followHandle === null) followHandle = timers.setTimeout(followTick, FOLLOW_MS)
  }
  function startFollowing() {
    if (pageBridge) return
    if (followHandle === null) followHandle = timers.setTimeout(followTick, FOLLOW_MS)
  }
  function startDrain() {
    drain.start()
    startFollowing()
  }

  const guarded = Object.fromEntries(Object.entries(commands).map(([id, fn]) => [id, guard(id, fn)]))
  for (const [id, handler] of Object.entries(guarded)) {
    orca.commands.register(id, (args) => handler(args))
  }
  // Orca 1.4.246+ lets a panel ask its own worker (plugin.request, no capability): the same handlers, by command id.
  // A request without input reaches the handler as null, which the commands take as no params.
  // Any request from a page marks a page open, so the refreshes that follow post to it instead of rewriting the file.
  if (pageBridge) {
    for (const [id, handler] of Object.entries(guarded)) {
      orca.panels.handle(id, (input) => {
        panelSeenAt = now()
        return handler(input ?? undefined)
      })
    }
  }
  orca.events.on('agent.status.changed', onEvent('agent.status.changed'))
  orca.events.on('workspace.created', onEvent('workspace.created'))

  if (settings.drainEnabled) startDrain()
  limitResets.start()
  // The panel is regenerated at activation too; the promise never rejects, so nothing waits on it.
  void refreshPanel()

  return {
    commands: guarded,
    drain,
    loadSettings,
    deactivate: () => {
      drain.stop()
      limitResets.stop()
      timers.clearTimeout(followHandle)
      followHandle = null
    },
  }
}
