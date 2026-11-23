# Changelog

All notable changes to this plugin are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.11.4 - 2026-11-23

### Changed

- The panel's text is 20% smaller: the base size, the account names, badges, buttons, bar labels and the dial and clock text. Buttons, tabs and pills shrink with it. Nothing goes below 9px, so the smallest text is 9px.

## 0.11.3 - 2026-11-23

### Changed

- Notices on the Mac go through Orca's notifications via the queue instead of AppleScript. They appear only while Orca runs. `osascript` or `queue,osascript` is still available as the host's notifier.
- A stored `osascript` from the old default is moved to `queue` once, and the status line and hook command are re-installed.

## 0.11.2 - 2026-11-23

### Changed

- The organizations of one login sit inside one outline in the List face.

## 0.11.1 - 2026-11-23

### Fixed

- A panel page on disk built from an older template is rewritten once instead of only being posted to. Pages carry a template marker (a comment at their end); a worker finding another marker, or none, writes the file even while a page is open, once per template, so it cannot loop. Before, a page left by an older release kept its old script and styles through every later release.

## 0.11.0 - 2026-11-23

Summarises 0.9.12 through 0.11.0. Needs the same Orca as 0.9.11. The bundled engine is `0.4.7+fork.16`: run `Grazr: Install engine on target` on each host.

### Added

- Several organizations of one login. Engine `0.4.7+fork.16` makes an account a login plus its organization: enrolling a second organization of a login no longer overwrites the first one's credential, the first one keeps its id and name, and each further one is enrolled as `<email>:<organization>`. `status --json` now reports each account's `login` and `organization_uuid`, and `enrol` takes `--expect-organization`.
- The panel groups the organizations of one login under a header with its e-mail, and names each by its organization and plan. A login with one account looks as before. Rotation is not grouped.
- Organizations are discovered automatically: those claude.ai lists for a login that are not enrolled close the login's group on each card, one that can run Claude Code as not signed in with `Sign in…`, and free and API console organizations greyed out with the reason.
- `Sign in another organization…` on a login's group header and on the List card of a login with one account, and as `Grazr: Sign in another organization of the active login (this workspace's server)`. It signs in with the login's e-mail in its browser profile and leaves the organization to claude.ai's consent page. `Sign in…` on a discovered organization also asks claude.ai for that organization (`orgUUID`). An organization already enrolled is refused, a new one joins the end of the rotation order, and a host with an older engine is refused (`update the engine on <host> first`).

### Changed

- The reset buttons use the reset on claude.ai in one press instead of typing `claude '/limit-reset …'` into a terminal. Grazr opens the account's Usage page in a background tab of its browser profile, clicks `Reset for free` in the row of that kind, answers a confirmation dialog when it has exactly one confirming button, and closes the tab. It reports success only when one fewer of that kind is counted afterwards. claude.ai greys the button out in a background tab, so Grazr tells the page, in its own tab only, that it has focus and waits up to 10 s for the button; a button still greyed out is never clicked.
- Reset buttons never swap. On a parked account they read as on the active one (`Fable reset`, `Full reset`) and use that account's reset where it stays parked; `Switch` or `Swap to` moves to it. The host's usage is refreshed afterwards.
- The palette's reset commands are `Grazr: Use a model limit reset on claude.ai (active account of this workspace's server)` and `Grazr: Use a full limit reset on claude.ai (active account of this workspace's server)`. They no longer need a terminal or a workspace, answer at once and report by notification.
- Limit resets and organizations are read from claude.ai's own data instead of the Usage page's text, with GET requests only, per organization: each account gets only its own organization's grants. A kind claude.ai counts but does not let be used now shows greyed out with claude.ai's reason. One tab per login. When the data cannot be read, a login with one account and at most one subscription organization falls back to the page's text.
- A reset for an organization that claude.ai does not have selected first selects it (the `lastActiveOrg` cookie), reloads the page and checks the page now shows that organization before clicking; the previous selection is put back afterwards.
- One browser profile per login: profiles are stored under the login's e-mail as well as the account name, and a new one is labelled `grazr · <email>`. Existing profiles are still found.
- A sign-in keeps the e-mail and the account name apart, and a re-authentication reads the account's e-mail and organization from a fresh status and checks both.
- Stored readings gain `organizationUuid` and `source`, and each login's organizations are stored under `organizations`.

### Notes

- No new capability is declared. The resets, organizations and browser profiles are driven through the `orca` CLI.
- Verified read-only against a live claude.ai page: the organization list, the selected organization's cookie, a Team organization's grants, and the reset buttons greyed out in a background tab and enabled after the focus event. Not yet verified live: spending a reset, selecting an organization by its cookie, and whether claude.ai's authorize page honours `orgUUID`.

## 0.9.11 - 2026-11-23

Summarises 0.9.0 through 0.9.11. Needs the same Orca as 0.8.1; the in-place panel updates need 1.4.246 or later. The bundled engine is `0.4.7+fork.15`: run `Grazr: Install engine on target` on each host.

### Added

- One Orca browser profile per account, remembered by id in the plugin's storage (`browserProfiles`), so claude.ai opens already signed in as that account. A missing profile is created labelled `grazr · <account>`, and a relabelled one is still the account's.
- `Open claude.ai` on every enrolled account, and the palette command `Grazr: Open claude.ai as the active account (this workspace's server)`. An open claude.ai tab in the account's profile is brought to the front; otherwise claude.ai opens in that profile in the sign-in workspace.
- A swap from the panel or the palette opens claude.ai as the account swapped to, with the outcome as a toast. The setting `browserOnSwap` (default `true`) turns it off. Automatic rotation by the engine opens nothing.
- Limit resets. An account that holds an unused limit reset shows a chip and offers reset buttons that type Claude Code's own `claude '/limit-reset fable'` or `claude '/limit-reset full'` (over `ssh -t` for a remote host) into the newest terminal, without pressing Return; Claude names the reset and asks before using it. A parked account offers `Swap + …` buttons, which swap the host to that account first. The same two are in the palette as `Grazr: Use a model limit reset` and `Grazr: Use a full limit reset`.
- Grazr reads each account's limit resets from claude.ai's Settings › Usage page, in that account's browser profile: a background tab opens, the `Limit resets` section is read, and the tab closes, without clicking anything. Accounts are read one after another every 3 hours, shortly after start when the last reading is stale, and after a card's `Refresh`. Readings are kept in the plugin's storage (`limitResets`) and count for 12 hours. Team and Ultra pages are both read. The setting `readLimitResets` (default `true`) turns the reading off.
- With a current reading an account offers exactly the resets the page counts, and the model reset button names the model (`Fable reset`). The chip says how many resets there are, and its hover text says which and until when. Without a reading the panel goes by Claude Code's own note, passed on by the engine.
- Every button says what it does on hover.

### Changed

- The panel lists accounts in the order they matter, on every face: the active account first, then the accounts usable now, then the spent ones by soonest refill, and last the accounts grazr cannot swap to. Rotation still follows the engine's order, and each account keeps its colour.
- On Orca 1.4.246 or later a change reaches an open panel as a post from the worker (`orca.panels.post`), and the page swaps its tabs and cards in place, keeping the selected tab and the toggles. The page file is written only while no panel is open, since a write to a development folder remounts the panel and restarts the worker. The page polls the focused host itself, so the worker no longer follows the workspace on those versions.
- An installed copy's placeholder asks the worker for a refresh when it opens on Orca 1.4.246 or later, so its open panel shows live data too.
- An add-account sign-in's fresh browser profile is kept as the account's once it is enrolled; it is deleted only when the sign-in fails or is cancelled.
- A newly added account joins the end of the host's rotation order (`ACCOUNTS`) by itself, so it no longer shows `Not in ACCOUNTS` until `config.env` is edited by hand.
- `Refresh parked` is now `Refresh`, one button per card, and the palette titles are `Grazr: Refresh usage (this workspace's server)` and `Grazr: Reload panel`. The command ids are unchanged. `Reload panel` has no button on the card any more.

### Notes

- Reading the Usage page depends on the page claude.ai shows the signed-in user, so it can stop working when that page changes; an unreadable page counts as not known, never as no resets. Each account's profile must be signed in to claude.ai.
- A link an agent or Orca opens in a workspace still lands in Orca's default profile: Orca offers no way for a plugin to set it.
- No new capability is declared. The browser profiles and the Usage page are driven through the `orca` CLI, and the panel posts need none.

## 0.8.1 - 2026-11-03

Runs on official Orca 1.4.246 and later with working panel buttons, and still declares no capability for them. On 1.4.245 it behaves as 0.8.0 did.

### Changed

- The panel's buttons, its focus poll and its stale-page wake-up ask the plugin's own worker through `plugin.request`, the panel-to-worker bridge official Orca ships since 1.4.246, when the frame's `host.has` offers it. The worker registers every command as a panel handler (`orca.panels.handle`) under the command's id, so a button runs exactly what the palette runs. No capability is needed and the consent screen does not change.
- A host without `plugin.request` is tried through `commands.execute` as before, and a host with neither (official Orca 1.4.245) still names the Cmd-J command on the card.

## 0.8.0 - 2026-11-02

Runs on official Orca 1.4.245. The plugin declares no `commands:execute` capability, since official Orca refuses a manifest that declares it. The panel's buttons name the palette command to run instead of running it.

### Added

- Two palette commands: `Grazr: Re-authenticate a blocked account (this workspace's server)`, which signs in the first blocked account in rotation order (or says there is none), and `Grazr: Add an account (this workspace's server)`. Both use the sign-in the panel's buttons use.
- A palette action with no parameters acts on the server of the focused workspace, read from Orca's session (at most every 3 seconds), and on the target when the focus cannot be read.
- While the drain loop runs, the worker follows the focused workspace every 3 seconds. A change of its host re-renders the panel with that host selected. Only a change re-renders, and the target setting is not written.

### Changed

- Palette titles name the server they act on: `Grazr: Swap to the next account (this workspace's server)`, `Grazr: Refresh parked accounts (this workspace's server)`, `Grazr: Turn rotation on/off (this workspace's server)`.
- On an Orca without `commands.execute`, a panel button names its Cmd-J command on the card's message line (`Run Cmd-J › <title>`). A `Switch` or `Swap to` button on a named account also shows that account's command in a selectable line.
- The panel's own focus poll stops silently on official Orca, and the worker's follow is what selects the focused host there. An official Orca cannot rewrite an installed plugin's panel, so the page there is the placeholder until the plugin is added as a development folder.
- `Grazr: Target → next host` sets the page back to the target setting: the followed host stops overriding it until the focused workspace changes.

### Removed

- The fallback that typed a button's command into the newest terminal of the worktree. Enrol and status still type from the palette.
- The `commands:execute` capability and its consent line.

### Notes

- Install, uninstall and Target → next host still act on the target, as their titles say.
- A palette command whose focus names a workspace on no configured host acts on the target.

## 0.7.1 - 2026-10-31

Summarises 0.7.0 and 0.7.1. Needs the same Orca as 0.6.9, and the `orca` CLI on this Mac. The bundled engine is `0.4.7+fork.12`.

### Added

- The sign-in steps in Orca's tab are automated. The sign-in fills in the e-mail and approves Claude Code, so you only type the code from the e-mail. Each poll takes at most one step, read from the tab's accessibility snapshot:
  - A re-authentication fills in the account's e-mail when it differs, then presses Continue.
  - The link-sent page: "Enter verification code" opens the login code box. A toast then asks for the code from the e-mail, and for the e-mail's link to be opened on another device.
  - The consent page: a button named "Authorize", "Allow" or "Approve" is clicked once.
  - The magic-link page: the tab is sent back to the authorize page, with a toast to open the link on another device.
- The login code box, the password fields and the Google, Apple and other buttons are never filled or clicked by the plugin. An add-account sign-in never fills the e-mail.

### Changed

- With the engine's `ULTRA_NO_SESSION` setting on (its default), an Ultra account rotates on its weekly limit only. The panel reads `no 5-hour limit (Ultra)` on every 5h face, muted, and the account is never spent or skipped for its 5-hour window. The list face omits its 5h bar, and a host whose accounts with readings are all such Ultra accounts opens on Week, with `Ultra: week only` in the header.
- The engine reports each account's `ultra` field, or the plan label is read when an older engine sends none.

## 0.6.9 - 2026-10-31

Summarises 0.6.4 through 0.6.9. Needs Orca 1.4.245 or later, the `orca` CLI on this Mac, a local Orca project on this Mac for the sign-in tab, and `setsid` and GNU `timeout` on each login host. The direct buttons and sign-in, and the panel's workspace-following, need an Orca with `commands.execute` (proposed in [stablyai/orca#36400](https://github.com/stablyai/orca/pull/36400)). The bundled engine is still `0.4.7+fork.11`.

### Changed

- Sign-in uses Claude's manual flow. The login runs on one of your ssh hosts (a remote card's own host; for a Mac card, `signinHost`, else the first remote host) over plain ssh, with its stdin kept open. The approval page redirects to Claude's code callback, and the plugin relays the code into that login by itself. The code is written once, never logged or shown, and only for a callback whose state matches the sign-in's own.
- The sign-in tab opens in a local Orca workspace on this Mac, so the browser is visible in the Orca window. The workspace is set by `signinWorkspace`, else the first local worktree, else the plugin's own folder. Without a local worktree the sign-in is refused with a message that says to add a project.
- Once the sign-in tab opens it is brought to the front, and a tab that leaves the authorize flow is steered back to it, at most 5 times per sign-in.
- A second click for the same account switches to its open tab instead of starting another sign-in.
- A sign-in has a 30-minute window. The remote login runs under `timeout -k 5 1830`.
- A cancelled, failed or timed-out sign-in stops the remote login's whole process group, since Claude ignores TERM and a dropped connection does not reach it.
- The Claude Accounts panel follows the focused workspace's host. Every 4 seconds while it is visible, it asks which host the focused workspace is on, read from Orca's profile database with `sqlite3 -readonly`, and selects that host's tab when the host changes. A failed read leaves the panel as it is.
- The panel shows one tab per server in a strip across the top, each with a status dot. One host's card shows at a time. Left and Right (Home and End) move between the tabs, and the strip scrolls sideways when there are more hosts than fit.
- New settings: `signinWorkspace`, `orcaProfileDb` (default `~/Library/Application Support/orca/profiles/local-default/profile-state.db`), `sqliteBin` (default `/usr/bin/sqlite3`), and a `signinHost` that a Mac card logs in on. The `active-host` command (`Grazr: Show the focused workspace's host`) toasts the focused host.
- The `orcaEnvironment` setting no longer selects where a sign-in opens. It still names the Orca environment a remote host is paired as, which the panel uses to match a workspace to its host.

### Fixed

- A cancelled sign-in left the remote login running until its timeout. The process group kill above ends it at once.
- A sign-in that signs in as a different account enrols nothing, and says which account signed in.

## 0.6.3 - 2026-10-31

Needs Orca 1.4.245 or later, the `orca` CLI on this Mac, and a paired Orca environment for each remote host that signs in. The bundled engine is still `0.4.7+fork.11`.

### Changed

- `Add account…` and `Re-authenticate…` open Claude's login in Orca's built-in browser, never the system browser. A re-authentication uses its account's own isolated browser profile, `grazr · <account>`, reused by later sign-ins. An add-account sign-in gets a fresh profile, `grazr · new account <yyyy-mm-dd hh:mm>`, which is deleted when that sign-in ends, whatever the outcome.
- The login runs on a remote host, in a throwaway directory there: the card's own host, or for a card on this Mac `signinHost`, else the first remote host with an Orca environment. The Mac-local `claude auth login` path is removed. With no such host, the sign-in is refused at once.
- A second sign-in for the same card cancels the running one: its login is stopped and discarded and its tab closed, then the new sign-in starts. A sign-in that is already enrolling is left to finish.
- The remote login runs under `ssh -tt` and `timeout 630`, so dropping the connection ends it on the remote host too.
- Only an https address on claude.ai, claude.com or anthropic.com is opened for a sign-in.
- New settings: `orcaBin` (default `/usr/local/bin/orca`), `signinHost`, and per host `claudeBin` (default `~/.local/bin/claude`) and `orcaEnvironment` (default: the host's name for an ssh host). The top-level `claudeBin` setting is no longer read.

### Fixed

- The `engine update available` chip shows only when the bundled engine is newer than the installed one. It compares major, minor and patch numerically, then the `+fork.N` number. An installed engine newer than the bundled one shows nothing.
- Orca's pretty-printed JSON replies are read whole, then by their last line.
- A sign-in address is taken with or without its trailing newline, on stdout or stderr.
- A tab that fails to open closes any tab on the same address. A fresh profile is deleted even when the sign-in is cancelled while it is being created.
- Each add-account profile label carries a random suffix, so concurrent sign-ins get distinct profiles.
- An ssh alias that starts with `-` is dropped, and an `orcaEnvironment` that starts with `-` is ignored.
- A login that reaches the 10-minute limit before its address appears is reported as a timed-out sign-in.

## 0.6.2 - 2026-10-31

Needs Orca 1.4.245 or later. The bundled engine is `0.4.7+fork.11`.

Anthropic renamed the Max plans on 2026-10-30: Max 20x is now Ultra, and Max 5x is now Max.

### Changed

- Plan chips follow the rename. A Max plan at 20x reads `Ultra`, a Max plan at 5x reads `Max`, and any plan whose type or tier says `ultra` reads `Ultra`. Pro, Team and Enterprise are unchanged.
- An account with a current weekly reading and no 5-hour window reads `no 5-hour limit` on the 5h view, in the muted tone, instead of `no reading`. It is never shown as spent on the 5h view because of its missing 5-hour window. The dial's tooltip and centre say the same, and the active and next accounts keep their labels with the wording added.
- A host where no account has a 5-hour window, but some account has a live weekly reading, opens on Week whatever `panelView` says. Its 5h button still works and shows `no 5-hour limit`.
- The bundled engine is `0.4.7+fork.11`: a status line whose `five_hour` window is null or unusable keeps the weekly reading instead of dropping it.

## 0.6.1 (public) - 2026-10-31

First public release. It has the features of the development 0.6.1 below, with these differences:

### Changed

- The manifest is format 2 (`"manifestVersion": 2`, `"execution": "trusted-worker"`), needs Orca 1.4.245 or later, and is MIT licensed.
- The capabilities use the format 2 names (`storage:own`, `workspace:read`, `agent:read`, `terminal:send`, `notifications:show`, `settings:own`). `commands:execute` is no longer requested, since no released Orca offers it yet. The panel then types the command into the terminal instead, as it does on any Orca without the method.
- The worktree event is subscribed as `workspace.created`, the format 2 name for `worktree.created`.
- The default hosts are only the local Mac. Add ssh hosts in `settings.json`; the README explains how.
- The panel icon is `gauge`, one of the format 2 icon names.

The history below comes from the development repository.

## 0.6.1 (development) - 2026-10-31

Needs the same Orca as 0.6.0 (`commands.execute`). The bundled engine is `0.4.7+fork.10`.

### Added

- `Add account…` and `Re-authenticate…` sign in from the panel with no terminal. The plugin runs `claude auth login` on the Mac with a throwaway config directory, so your browser opens Claude's login. The card's message line shows `Sign in to … in your browser` at once; the outcome arrives as a toast and a refreshed card.
- The account is enrolled on the card's host: on the Mac from the throwaway login, and on a remote host by piping the login's export over ssh stdin. The throwaway login is discarded afterwards whatever the outcome.
- A sign-in that signs in as a different account than the card names enrols nothing and says which account signed in. A sign-in left unfinished for 10 minutes is abandoned, and a second sign-in for the same host waits for the first.
- The `claudeBin` setting, the Claude Code binary to run, default `claude`.

### Changed

- The bundled engine is `0.4.7+fork.10`: non-interactive `enrol --from` and `enrol --stdin`, `login-export` and `login-discard`.
- The panel's enrol no longer opens a Terminal window. From the palette, `enrol` still types into the newest terminal.

### Removed

- The `terminalApp` setting and `lib/terminal-window.mjs`.

## 0.6.0 - 2026-10-30

Needs an Orca with the `commands.execute` host method (capability `commands:execute`), proposed upstream and not in any stock release yet; until it ships that means a local Orca build with the change. Stock Orca rejects this manifest; use 0.5.x there.

### Added

- The panel's buttons run their command on the host the card names, and the result shows on the card's message line. Refresh, Swap, Turn rotation on or off and Refresh panel no longer type into a terminal.
- `Add account…` and `Re-authenticate…` open a Terminal window that runs the enrol command on that card's host, with two lines saying what to press. The window opens in the app named by the `terminalApp` setting, which defaults to `Terminal`.
- A `Refresh panel` action on each card.
- The `terminalApp` setting.
- Commands take params from the panel: `swap` with an `account`, `refresh` and `uninstall` with a `host`, and `rotation-toggle` with an `enabled` boolean. A missing or unknown `host` falls back to the target, so the palette behaves as before.

### Changed

- Every command resolves to `{ ok, message }` with the same text it toasts, so the panel can show the result.
- The panel asks for a refresh whenever it is opened on a page older than three minutes, not only after an Orca restart. That refresh raises no notification; the card's message line shows its outcome.
- The parked accounts' Refresh button is labelled `Refresh parked`.

### Unchanged

- From the palette, `enrol` and `status-terminal` still type into the newest terminal of the focused worktree.

## 0.5.0 - 2026-10-22

### Added

- A `List` face, switched with a `Dial | Clock | List` control. It shows one card per account with a bar per usage window (5h, Week, and each per-model week when model limits are on), with the percentage left and its tone, the reset time, the Active and Blocked chips, the organisation, the reading age (which updates in the page), and the Switch and Re-authenticate… buttons. Re-authenticate… is offered on a blocked account even while it is active.
- `panelFace` accepts `list` as well as `dial` and `clock`.
- The engine's `status --json` accounts carry `organization`.
- The engine's `status --json` accounts carry `plan`.
- A plan chip on each account's head in the List face, such as `Max 20x`, `Team 5x` or `Pro`.
- Tooltips on the dial's segments: the account, its percentage left, the swap threshold and the reset time.
- Per-model inner rings on the dial's Week view when model limits are on, with their own tooltips, the active account's per-model lines in the centre, and the `Outer ring: all models · inner: …` footnote.

### Changed

- The bundled engine is `0.4.7+fork.9`.
- The panel's background is Orca's card colour, matching the sidebar.
- The big-page guard is 1.25 MB: the 300-account test fixture renders 1.13 MB with two model rings per account; a real panel is a few accounts.

## 0.4.0 - 2026-10-22

### Added

- A `Clock` face on each card, switched with a `Dial | Clock` control. On the 5h view it shows a 24-hour face, and on the Week view a 7-day face. The hand sits at now and the local time is in the centre. The ring ahead of the hand is coloured by the account grazr is projected to be on, and it is red where nothing can run. Swaps are ticks across the ring, and refills are numbered dots outside it.
- `panelFace` and `panelView` settings choose the face and window each card opens with; the toggles switch every card at once and hold until the page is next rewritten.

### Changed

- The bundled engine is `0.4.7+fork.7`. Its `status --json` carries each account's reading time, which the clock needs for its pace. Until the engine is reinstalled on a host, the card shows `engine update available` and the clock projects without pace.
- The bundled engine's version suffix is `+fork.N` instead of the earlier suffix.
- The `5h | Week` toggle now switches every card at once.

## 0.3.1 - 2026-10-22

### Added

- A needle on each card's ring at what the active account has used, and a tick at the swap threshold on the active slice.

### Changed

- The active slice's track is dimmed, and its remaining arc runs from the needle to the slice end in the tone colour, as in HerdrM.

## 0.3.0 - 2026-10-22

### Added

- Per-host header line in the panel, with the swap thresholds and the time the page last changed with a fresh reading of that host.
- Engine version line in each card, and an `engine update available` chip when the installed engine version differs from the bundled version.
- `Turn rotation on` / `Turn rotation off` button in each card, which types the rotation command into the newest terminal.
- Stock-Orca install guide in the README, for installing from a path and from a git URL.

### Changed

- The ring and the account rows are coloured by account state, as in the native dialog: green for accounts with tokens, red when out of tokens, orange and dashed for the next account, grey for parked or unknown.
- The centre text of the ring stays inside the ring.
- The footer is reduced to the `Cmd-J Grazr: Refresh panel` hint.
- An unchanged page is no longer rewritten when only the minute changes.

## 0.2.0 - 2026-10-21

### Added

- Claude Accounts panel in Orca's sidebar, with one card per host, a 5h and Week view, and buttons for refresh, add account, swap to next, swap to a named account and re-authenticate a blocked account.
- `Grazr: Refresh panel` command, which regenerates the panel and reports whether the page was updated, unchanged, not writable or failed.
- Panel regeneration after each drain tick and after each command that changes a host.
- Status command hands its results to the panel, so each press asks every host once.

## 0.1.0 - 2026-10-21

### Added

- Plugin manifest for `senadaruc.grazr` with ten palette commands, two events (`agent.status.changed`, `worktree.created`) and six capabilities.
- Host settings with defaults, merged over whatever Orca stores and seeded on first activation.
- Running the grazr engine locally or over `ssh`, with JSON status and line-based command output.
- Deploying the engine to each host with `rsync`, excluding bytecode and test files.
- Install, uninstall, swap, refresh and rotation toggle on the target host, with OS toasts for each result.
- Status across all hosts, with each host's failure isolated so one unreachable host does not hide the others.
- Install refuses a status line owned by another grazr unless `forceInstall` is set, globally or per host, and gives up when its time budget expires.
- A per-host `forceInstall` override, so taking over Herdr's status line on one remote box leaves the Mac alone.
- The Mac host notifies through `osascript` by default. Hosts whose notifier includes `queue` are drained, so each notice shows once.
- Drain loop that delivers engine notices as OS notifications every `drainIntervalMs`, with per-host isolation, backoff for unreachable hosts and a cap on toasts per cycle.
- Palette commands that type the enrol and status commands into a shell terminal in a worktree.
- Engine failures are classified (timeout, missing binary, unreachable host, engine error) and reported with the host name.
