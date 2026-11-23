# Grazr for Orca

Grazr rotates the **System default** Claude Code account on each of your hosts before a usage window runs out. It uses the grazr engine, a small Python program that runs on each host, so you keep working in the same conversation when a swap happens. Orca is the front end: a command palette, OS notifications, and a **Claude Accounts** panel in the right sidebar that shows every host in one place.

Hosts are this Mac plus any remote machines you reach over `ssh`. Orca's own managed accounts are left alone.

## Screenshots

<!-- Screenshots of the panel. Replace the placeholders when the images are added. -->

| Dial (dark) | List (dark) | Clock (light) |
|---|---|---|
| ![Dial face of the Claude Accounts panel](docs/images/dial-dark.png) | ![List face of the Claude Accounts panel](docs/images/list-dark.png) | ![Clock face of the Claude Accounts panel](docs/images/clock-light.png) |

The panel has three faces. **Dial** shows a ring with one segment per account. **Clock** shows a 24-hour face (5h view) or a 7-day face (Week view), with the swaps and refills projected ahead. **List** shows one card per account with a bar for each usage window. On every face the active account comes first, then the accounts usable now, then the spent ones by soonest refill.

## Requirements

- Orca 1.4.246 or later, with the plugin system enabled, for working panel buttons. The plugin installs on 1.4.245 too, where its actions are the palette commands and each button names the command to run.
- Python 3 (`python3`) on this Mac and on each remote host.
- Claude Code on each host that signs accounts in, at its `claudeBin` (default `~/.local/bin/claude`).
- For sign-in: the `orca` CLI on this Mac (`orcaBin`, default `/usr/local/bin/orca`), a local Orca project on this Mac whose worktree hosts the sign-in tab (`signinWorkspace`), `claude` on the login host, and on that host plain `ssh`, `setsid` and GNU `timeout`. See [Enrolling accounts](#enrolling-accounts).
- `ssh` access to each remote host in batch mode, with keys or Tailscale SSH.
- `rsync` on this Mac and on each remote host. `Install engine` copies the engine with it.

## Install

Once the plugin is listed in Orca's plugin catalog, install it from there.

Until then, in Orca open **Settings › Plugins**, turn the plugin system on, and install from the git URL:

```
https://github.com/senadaruc/orca-grazr
```

An installed copy shows the committed placeholder panel, and the palette commands work. To see live data in the panel, add the plugin's checkout as a development folder, as described under [Development](#development). An installed copy cannot rewrite its own panel, because Orca verifies installed files. On Orca 1.4.246 or later an open panel of an installed copy still gets the live page: the placeholder asks the worker for a refresh when it opens, and the worker posts the page to it.

## First steps

1. **Add your hosts.** The shipped default manages only this Mac. To add a remote host, edit the plugin's `settings.json` (see [Settings](#settings) and [Remote hosts](#remote-hosts)). The file lives at `<userData>/plugins-data/senadaruc.grazr/settings.json`.
2. **Install the engine on the target host.** Press Cmd-J and run `Grazr: Install engine on target`. Use `Grazr: Target → next host` to move the target to another host first.
3. **Enrol accounts.** Press Cmd-J and run `Grazr: Add an account (this workspace's server)`, which signs in through a local Orca workspace's built-in browser. Sign-in needs a remote host to log in on and a local Orca project on this Mac for the browser tab, and the default settings manage only this Mac, so add a remote host first (see [Remote hosts](#remote-hosts)). A new account joins the end of the host's rotation order by itself; see [Enrolling accounts](#enrolling-accounts) to change the order. Repeat for each host.
4. **Open the panel.** Run `Grazr: Reload panel`, then open the right sidebar and choose **Claude Accounts**.

If another grazr already owns Claude's status line on the Mac, read [Status line owned by another grazr](#status-line-owned-by-another-grazr) before step 2.

## Running actions on official Orca

Grazr runs on official Orca. Its actions are commands in the Cmd-J palette, and each one acts on the server of the workspace you are in:

- `Grazr: Re-authenticate a blocked account (this workspace's server)` signs in the first blocked account in rotation order.
- `Grazr: Add an account (this workspace's server)` signs in a new account.
- `Grazr: Sign in another organization of the active login (this workspace's server)` signs in another organization of the login that server is using.
- `Grazr: Swap to the next account (this workspace's server)`, `Grazr: Refresh usage (this workspace's server)` and `Grazr: Turn rotation on/off (this workspace's server)` act on the focused workspace's server. When Orca does not report the focused workspace, they act on the target instead.

`Install engine`, `Uninstall` and `Target → next host` act on the target, as their titles say. Assign shortcuts to any of these commands in Orca's Shortcuts settings.

On Orca 1.4.246 and later the panel's buttons run these same commands, through the panel-to-worker bridge (`plugin.request`) that Orca ships for plugins; no extra capability is needed. On 1.4.245, which has no such bridge, each button names the palette command to run on its card instead.

In a development install the panel follows your workspace (see [Claude Accounts panel](#claude-accounts-panel)). The palette commands work the same in either install.

## Settings

Orca keeps the settings in `<userData>/plugins-data/senadaruc.grazr/settings.json`. On first activation the plugin writes only the default keys that are missing; values you set are kept. Edit the file to change them. Changes to `drainIntervalMs` and the hosts take effect on the next drain tick, without a restart.

- `hosts`: the hosts to manage. See [Remote hosts](#remote-hosts) for the fields.
- `target`: the host that target-scoped commands act on. It must match a host `name`. The default is `mac`.
- `engineDir`: where the engine is installed on each host. The default is `~/.local/share/orca-grazr/engine`.
- `stateDir`: where the engine keeps its state, passed to it as `GRAZR_STATE_DIR`. The default is `~/.local/state/orca-grazr`.
- `configDir`: where the engine reads its `config.env`, passed as `GRAZR_CONFIG_DIR`. The default is `~/.config/orca-grazr`.
- `drainIntervalMs`: how often the plugin drains the engine's notices. It is also the base for backoff after a failed drain. It is clamped to 30 seconds through 4 minutes, because Orca reaps an idle worker after five minutes.
- `drainEnabled`: whether the drain loop runs. Agent and worktree events respect it too, so `false` keeps the loop stopped.
- `maxToastsPerHostPerCycle`: how many notices one host can show per drain. Extra notices collapse into one `+N more notices` toast.
- `forceInstall`: whether `Install engine` takes over a status line that another grazr owns. It is the default for every host; a host can override it with its own `forceInstall`.
- `panelFace`: the face every card opens with: `clock`, `dial` or `list`. The default is `clock`.
- `panelView`: the window every card opens with: `session` (5h) or `weekly` (Week). The default is `session`. A host whose accounts with readings are all Ultra accounts with no 5-hour limit opens on Week whatever this says.
- `browserOnSwap`: whether a swap from the panel or the palette also opens claude.ai as the account swapped to, in that account's browser profile (see [Browser profiles](#browser-profiles)). The default is `true`. Automatic rotation by the engine never opens a browser.
- `readLimitResets`: whether Grazr reads each login's organizations and limit resets from claude.ai, in that login's browser profile (see [Limit resets](#limit-resets)). The default is `true`. With `false` nothing is opened, no organizations are discovered, and the panel goes by Claude Code's own note alone.
- `orcaBin`: the Orca CLI that opens each sign-in tab in a local Orca workspace. The default is `/usr/local/bin/orca`. A value that is blank or starts with `-` falls back to the default.
- `signinWorkspace`: optional. The local Orca worktree the sign-in tab opens in, as an `id:<worktree id>` or `path:<folder>` selector. When it is unset, the first local worktree is used, and the plugin's own folder when it is one.
- `signinHost`: optional. The name of a configured remote host. A sign-in for a card on this Mac logs in on it. When it is unset, the first remote host is used.
- `orcaProfileDb`: the Orca profile database the panel reads to find the host of the focused workspace. It is opened read-only. The default is `~/Library/Application Support/orca/profiles/local-default/profile-state.db`. A value that is blank or starts with `-` falls back to the default.
- `sqliteBin`: the `sqlite3` that reads that database. The default is `/usr/bin/sqlite3`. A value that is blank or starts with `-` falls back to the default.
- `sshBin`, `rsyncBin`: the `ssh` and `rsync` binaries to run.
- `sshOptions`: the options passed to every `ssh` call. The defaults are `BatchMode=yes` and a 5 second connect timeout.

## Remote hosts

Add a remote host to `hosts` in `settings.json`. Each host has these fields:

- `name`: the label used in toasts and by `target`.
- `ssh`: the `ssh` host alias, or `null` for this Mac. The alias must work non-interactively (`BatchMode`), so set up keys first.
- `python`: the Python 3 interpreter on that host. The default is `python3`.
- `claudeBin`: optional. The Claude Code binary on that host, run for a sign-in over `ssh`. The default is `~/.local/bin/claude`. A value that is blank or starts with `-` falls back to the default.
- `orcaEnvironment`: optional. The name of the Orca environment this host is paired as. The panel matches a workspace on that environment to this host. The default is the host's `name` for an ssh host, and none for this Mac. A value that starts with `-` is ignored.
- `notifier`: how the engine reports notices. Every host uses `queue` by default, this Mac included: the engine queues each notice and the plugin shows it as an Orca notification on its next drain. `osascript` posts a macOS notification directly, which macOS files under Script Editor; set it on the host to bring that back. A comma list fans out to each channel, so `queue,osascript` shows each notice through Orca and through macOS. With `queue`, notices appear only while Orca is running; otherwise they wait in the queue until Orca is back. A change to the Mac host's notifier reinstalls its status line and failure hook (they carry the notifier) the next time the plugin starts, when grazr is connected there.
- `forceInstall`: optional, `true` or `false`. It overrides the global `forceInstall` for this host only. Leave it out to follow the global value.

For example, a remote box named `devbox`, reached through the `ssh` alias of the same name:

```json
{ "name": "devbox", "ssh": "devbox", "python": "python3", "notifier": "queue" }
```

A host list that includes the Mac must keep the Mac's entry with `"ssh": null` and a `notifier` (`queue` by default).

## Ultra accounts

An Ultra account (the plan formerly called Max 20x) has no 5-hour limit under the engine's `ULTRA_NO_SESSION` setting, which is on by default (`ULTRA_NO_SESSION=1` in the host's `config.env`). With it on, the engine rotates an Ultra account on its weekly limit only, and the panel shows `no 5-hour limit (Ultra)` on its 5h views. A 5-hour limit that is still enforced on an Ultra account is caught by the failure hook, which swaps to another account. Set `ULTRA_NO_SESSION=0` to turn the rule off, so that Ultra accounts rotate on the 5-hour window too.

## Enrolling accounts

`Grazr: Add an account (this workspace's server)` and `Grazr: Re-authenticate a blocked account (this workspace's server)` sign in through Orca's built-in browser and enrol the account on the focused workspace's server. Nothing opens in your system browser.

How a sign-in works:

- The login runs on one of your ssh hosts, in a throwaway directory there, over plain `ssh` with its stdin kept open (no pty). A card on a remote host logs in on that host. A card on this Mac logs in on `signinHost`, or on the first remote host. Without a remote host to log in on, the sign-in is refused at once.
- The sign-in tab opens in a local Orca workspace on this Mac (`signinWorkspace`, or the first local worktree), in Orca's built-in browser, in an isolated browser profile, and is brought to the front. The start message names that workspace. A re-authentication, and another organization of a login, use the login's own profile. An add-account sign-in gets a fresh profile, `grazr · new account <yyyy-mm-dd hh:mm>`, which becomes the account's profile once it is enrolled, and is deleted when the sign-in fails or is cancelled (see [Browser profiles](#browser-profiles)).
- The sign-in fills in the e-mail and approves Claude Code, so you only type the code from the e-mail. A re-authentication fills in the account's e-mail, presses Continue and opens the code box, and Claude Code's consent is clicked once. An add-account sign-in leaves the e-mail to you. The plugin never fills the code box. Open the e-mail's link on another device (your phone), not in Orca's tab: a link opened there cannot sign the login in, so the tab is sent back to the start with a notice.
- A re-authentication reads the account's e-mail and organization from a fresh status of its host, never from the panel, asks claude.ai for that organization, and refuses an enrolment of another e-mail or organization. Another organization of a login is covered in [Several organizations of one login](#several-organizations-of-one-login).
- Approving in the tab sends the code back to the login by itself: the plugin reads the tab's address, and when it is Claude's code callback for this sign-in (matched by its state), it writes the code into the login's stdin, once. Nothing is copied by hand, and the code is never logged or shown.
- A sign-in that is steered off the authorize flow is returned to it, at most five times.
- Only an https address on claude.ai, claude.com or anthropic.com is opened. Anything else is refused and nothing is opened.
- The enrolment reads the login on the remote host. The account may be enrolled on a different host than the one that logged in. This Mac receives the account's export only on the stdin of its engine, never in an argument, and the login is discarded afterwards on the remote host.
- A sign-in gets 30 minutes. The remote command runs under `timeout -k 5 1830`, so a sign-in that never finishes stops on the remote host too. Cancelling, failing or timing out stops the login's whole process group there, because Claude ignores TERM and a dropped connection does not reach it. The `timeout` and `setsid` commands must exist on that host.
- A second sign-in for the same card cancels the running one: its login is stopped, discarded and its tab closed, and then the new sign-in starts. The exception is a second click for the same account while its tab is still open, which only switches to that tab.

To enrol from the terminal instead:

1. Open a new shell terminal in a worktree, then run `Grazr: Type enrol command into terminal` from the palette. The command goes to the most recently opened terminal, so open a fresh shell first.
2. Press Return in that terminal.
3. Press `s` to save the account you are logged in to now, or `l` to log in to another account. After `l`, enter a name for the account when asked. To re-authenticate an enrolled account, enter the name it already has.
4. A new account joins the end of the host's rotation order (`ACCOUNTS`) by itself. An empty `ACCOUNTS` stays empty, since it already rotates through every account. To change the order, set it in the host's `~/.config/orca-grazr/config.env`:

   ```
   ACCOUNTS="work personal"
   ```

   You can also set it from the shell:

   ```
   GRAZR_STATE_DIR=~/.local/state/orca-grazr GRAZR_CONFIG_DIR=~/.config/orca-grazr python3 ~/.local/share/orca-grazr/engine/grazr.py set ACCOUNTS "work personal"
   ```

   On a remote host, prefix the command with `ssh <host> '…'`, or run it on that host.

5. Repeat for each host.

## Status line owned by another grazr

If another grazr, such as the one in the Herdr terminal app, already owns Claude's status line on a host, `Install engine` refuses and the toast names the state directory. Two ways out:

- **Take the host over.** Set `forceInstall: true` on that host only, as in [Remote hosts](#remote-hosts). Leave the other hosts on the global default.
- **Hand the status line over.** On a Mac, first disconnect the other grazr from the status line, restart Orca or open a Claude pane so Orca fills the empty status line slot, and then run `Grazr: Install engine on target`. Orca only fills an empty slot; in the reverse order, Orca has no status line.

A status bar of your own that calls grazr is never taken over, forced or not. Edit that bar by hand.

## Commands

These commands appear in the Orca command palette. A command whose title says "this workspace's server" acts on the server of the workspace you are in, and on the target when Orca does not report it.

- `Grazr: Target → next host`: moves the target to the next host in the list.
- `Grazr: Status (all hosts)`: shows each host's accounts and usage, one toast per host.
- `Grazr: Swap to the next account (this workspace's server)`: swaps the focused workspace's server to its next account now.
- `Grazr: Re-authenticate a blocked account (this workspace's server)`: signs in the first blocked account in rotation order on the focused workspace's server. It says so when no account is blocked.
- `Grazr: Add an account (this workspace's server)`: signs in a new account on the focused workspace's server.
- `Grazr: Sign in another organization of the active login (this workspace's server)`: signs in another organization of the login the focused workspace's server is using, and enrols it as an account of its own (see [Several organizations of one login](#several-organizations-of-one-login)).
- `Grazr: Refresh usage (this workspace's server)`: refreshes every account on the focused workspace's server, including the active one. It asks Claude's usage endpoint and refreshes any lapsed token.
- `Grazr: Open claude.ai as the active account (this workspace's server)`: opens claude.ai in Orca's browser, in the browser profile of that server's active account, so it is already signed in as that account. A claude.ai tab already open in that profile is brought to the front instead.
- `Grazr: Use a model limit reset on claude.ai (active account of this workspace's server)` and `Grazr: Use a full limit reset on claude.ai (active account of this workspace's server)`: use that reset of the server's active account on claude.ai at once, as the panel's reset buttons do (see [Using a reset](#using-a-reset)). No terminal or worktree is needed.
- `Grazr: Turn rotation on/off (this workspace's server)`: turns automatic rotation on or off on the focused workspace's server.
- `Grazr: Install engine on target`: copies the engine to the target and installs grazr's status line and failure hook.
- `Grazr: Uninstall from target`: removes grazr's status line and failure hook from the target.
- `Grazr: Drain notices now`: delivers the queued notices immediately.
- `Grazr: Type enrol command into terminal`: types the enrol command into the newest terminal of the focused worktree. It does not press Return.
- `Grazr: Type status command into terminal`: types the status command into the newest terminal of the focused worktree. It does not press Return.
- `Grazr: Show the focused workspace's host`: toasts the host the focused workspace belongs to. The panel asks for the same answer itself and does not toast.
- `Grazr: Reload panel`: regenerates the Claude Accounts panel from a fresh status run on every host, and reports whether the page changed. The panel redraws itself on every change, so this is for a panel that looks stuck.

## Claude Accounts panel

The panel shows every managed host. A tab strip across the top has one tab per host, each with a status dot: green when rotation is on and the host is reachable, grey when rotation is off, red when the host is unreachable or has no engine. One host's card shows at a time. Click a tab to read another host, or use Left and Right (Home and End) to move between tabs. The strip scrolls sideways when there are more hosts than fit.

The tab of the host the focused workspace is on is selected first, and the panel follows the focused workspace in a development install: a local workspace selects this Mac's tab, and a workspace on a paired environment selects that host's tab. The selected tab follows a change of workspace within about four seconds. The panel reads the focused workspace's host from Orca's profile database, read-only, and maps a paired environment to its host through `orca environment list --json` (cached for 60 seconds). Only a change of host moves the selection, so a tab you pick by hand stays selected until you switch workspace. If the Orca CLI or the database cannot be read, the panel keeps the cards as they are and tries again.

Each card, under its tab, shows:

- A header line with the swap thresholds the engine reports for that host, the time the host's data last changed, and a chip for the host's state: `rotation on`, `rotation off`, `not connected`, `unreachable`, `engine not installed`, `managed profile`, `engine update available` or `another grazr owns the status line`. `not connected` means the status line or the stop hook is missing on that host, so nothing rotates there.
- An `engine <version>` line. When the installed engine differs from the one the plugin bundles, `engine update available` appears. Run `Grazr: Install engine on target` to update it.
- A 5h view and a Week view, switched with the buttons at the top of the card. Each view has a ring with one numbered segment per account, in the panel's order (see below). A needle marks the share used on the active account's segment, and a tick marks the swap threshold. When the engine watches per-model limits (`MODEL_LIMITS=1` in that host's `config.env`), the Week view adds an inner ring per model. An account that has a weekly reading but no 5-hour window (some plans have no 5-hour limit) reads `no 5-hour limit` on the 5h view, muted and never counted as spent, and a host where no account has a 5-hour window opens on Week whatever `panelView` says. An Ultra account with no 5-hour limit (see [Ultra accounts](#ultra-accounts)) reads `no 5-hour limit (Ultra)` on every 5h face, muted, and is never spent or skipped for its 5-hour window. A host whose accounts with readings are all such Ultra accounts opens on Week too.
- A `Dial | Clock | List` switch. Hovering a segment shows its account, the percentage left, the swap threshold and the reset time.
- Colours by account state: red for an account that is spent or blocked, green at reduced opacity for a parked account that still has tokens, grey for an unknown or unenrolled account, and orange and dashed for the next account.
- One row per account, with its percentage and status: `active`, `NEXT ▸`, `spent · resets <day and time>`, `blocked: <reason>`, `not read yet` or `not enrolled`.
- Buttons. Every button says what it does on hover. A card has `Refresh`, which asks Claude for fresh usage on that server and redraws the panel when it answers, and on a reachable host `Add account…`, `Swap to next` and the rotation switch. A row has `Swap to` or `Switch`, `Re-authenticate…` when it is blocked, `Open claude.ai` (see [Browser profiles](#browser-profiles)) and the reset buttons (see [Limit resets](#limit-resets)). A login's group header, and the List card of a login with one account, have `Sign in another organization…`, and a discovered organization that is not enrolled has `Sign in…` (see [Several organizations of one login](#several-organizations-of-one-login)).

The rows, the ring's segments and the list's cards are in the same order on every face, rearranged as the accounts change: the active account first, then the accounts usable now in rotation order (the first is `NEXT ▸`), then the spent ones, the one that has tokens again soonest first, and last the accounts grazr cannot swap to (blocked, no parked login, or not enrolled). The number on a row is its place in that order, and the clock's dots carry the same numbers. An account keeps its colour however it moves. The order is only how the panel shows the accounts: rotation still follows the engine's order.

The next account is the first account in rotation order, other than the active one, that is parked, not blocked, and has no live window below its threshold. This is the engine's rule, so `NEXT ▸` names the account that a swap moves to.

### Clock

The Clock face shows a 24-hour face on the 5h view and a 7-day face on the Week view. The hand sits at now. The ring ahead of the hand is coloured by the account grazr is projected to be on, and red where nothing can run. A swap is a tick across the ring, and a refill is a numbered dot outside it. The projection uses the engine's pace figures, so the host needs engine `0.4.7+fork.7` or later.

### List

The List face shows one card per account, with a bar for each usage window: 5h, Week, and each per-model week when model limits are on. A bar is green when fine, amber below the swap threshold, and red at 2% or less. A window whose reset has passed reads `reset since`. The card also carries the Active and Blocked chips, the organisation, and the Switch and Re-authenticate… buttons.

### When the panel updates

The worker regenerates the panel when the plugin activates, after each drain tick while the drain loop runs, and after target next, status, swap, refresh, toggle rotation, install and uninstall. The page changes only when something on it changed.

On Orca 1.4.246 or later a change reaches an open panel as a post from the worker (`orca.panels.post`): the page swaps its tabs and cards in place, keeping the selected tab and the `5h | Week` and `Dial | Clock | List` toggles. The page file is written only while no panel is open, because a write to a development folder remounts the panel and restarts the worker. Before 1.4.246 every change is a write, and the panel reloads with it.

A host that times out under a short command budget keeps its last reading. A host that times out at the full ten seconds is shown as `unreachable`.

## Browser profiles

Orca's built-in browser keeps one cookie jar per browser profile. Grazr keeps one profile per login, shared by the login's organizations, so claude.ai stays signed in as that login there. It remembers which profile belongs to which login by the profile's id, in the plugin's storage (`browserProfiles`, keyed by the login's e-mail and by each account name), so a relabelled profile is still the login's. A profile Grazr creates for a login is labelled `grazr · <email>`; one made before 0.11.0 keeps its `grazr · <account>` label and is still found.

- `Open claude.ai` on an account's row, and `Grazr: Open claude.ai as the active account (this workspace's server)`, bring a claude.ai tab open in the account's profile to the front, or open `https://claude.ai/` in that profile in the sign-in workspace. An account with no profile yet gets one, and claude.ai asks for one sign-in there; the profile is the account's from then on.
- A swap from the panel or the palette opens claude.ai as the account swapped to, once the swap has answered, with the outcome as a toast. `browserOnSwap: false` turns that off.
- A link an agent or Orca opens in a workspace still lands in Orca's default profile, since Orca offers no way for a plugin to set the default profile. Pick the account's profile from the browser toolbar there, or use `Open claude.ai`.

## Limit resets

An account can hold unused limit resets. Grazr shows them, and its reset buttons use them on claude.ai in one press.

Grazr reads the resets from claude.ai's own data, in each login's browser profile, one login after another and one tab per login:

- It opens `https://claude.ai/settings/usage` in a background tab of the sign-in workspace and, from inside the page, asks claude.ai with GET requests only for the login's organizations, the one selected there (the `lastActiveOrg` cookie, read and never set by a reading), and for each organization that can chat its limit-reset grants. Then it closes the tab. A reading never clicks anything.
- Resets are read per organization. Each account is matched to its organization by the `organization_uuid` the engine reports (an account an older engine reports none for, to its login's only subscription organization), and only ever gets its own organization's grants. A grant that clears the weekly window is a full reset; one that does not is a model reset, named after its model (`Fable`).
- When claude.ai's data cannot be read, a login with one enrolled account and at most one subscription organization falls back to the text of the Usage page's `Limit resets` section, and the log says so. A login with several organizations then gets no reading, since the page shows only the organization selected there.
- It reads every 3 hours while the plugin runs, a minute after start when the last reading is older than that, and after a card's `Refresh`. `readLimitResets: false` turns it off.
- Readings are kept in the plugin's storage (`limitResets`, by account name, with the organization and whether they came from the data or the page), and each login's organizations under `organizations` (by e-mail: uuid, name, plan and kind only). A reading older than 12 hours counts as none, and a failed read keeps the last good one until then.
- Only logins that already have a browser profile are read; Grazr creates none for this. An account without one, or whose profile is signed out, says so in the hover text of its `Open claude.ai` button. Sign in there once.
- The readings are made on this Mac, where the profiles are, and apply to every host's card.

What the panel offers:

- With a current reading, an account offers exactly the resets it counts: a model reset (the button names the model, e.g. `Fable reset`) when it holds one, and `Full reset` when it holds a full one. A kind claude.ai counts but does not let be used right now shows greyed out, with claude.ai's reason as hover text. The chip and the row say how many resets there are, and their hover text says which and until when. An account read without resets offers none.
- Without a reading the panel goes by Claude Code's own note of the account, passed on by the engine, which lapses after three days. `Reset available` shows when Claude noted an unused reset. The active account offers both buttons unless Claude noted it holds none; a parked account offers them only on Claude's note. An organization of a login with several offers buttons only with a reading of its own organization.
- The buttons read the same on a parked account and never swap: the reset is used for that account where it stays parked, and `Switch` (or `Swap to`) is how to move to it.

### Using a reset

A reset button, or its palette command for the active account, uses the reset on claude.ai in one press, in the login's browser profile, on the account's organization:

- The command answers at once (`Using a model reset of <account> on claude.ai…`), and the result comes as a notification. A second press for an account whose reset is under way is refused, and a reset never runs beside a scheduled reading.
- It opens the Usage page in a background tab. When claude.ai has another organization of the login selected, Grazr selects the account's organization the way claude.ai's account menu does (the `lastActiveOrg` cookie), reloads the page, and checks that the page now shows that organization and counts what its grants count. Otherwise nothing is clicked (`could not switch claude.ai to <org> — select it in the account menu and try again`). The previous selection is put back afterwards.
- It clicks `Reset for free` only in the row of that kind, matched by its title (a model's for a model reset, `Weekly reset` or `Full reset` for a full one). claude.ai greys the button out while its window has no focus, as a background tab never has, so Grazr tells the page it has focus, in its own tab only, and waits up to 10 s for the button. A button still greyed out is never clicked.
- A confirmation dialog is answered only when it has exactly one confirming button. The reset counts as used when the organization's grants (or, without them, the page) count one fewer of that kind; otherwise the notification says it could not confirm the reset was used — check claude.ai.
- The tab is closed in every case, and the new reading is stored, so the panel shows it at once. Once the reset counts as used, the host's usage is refreshed and the panel redrawn. Nothing is swapped.
- On a remote host (e.g. `devbox`) it works the same: the browser profiles are on this Mac, and only the refresh goes to that host.

This drives claude.ai's own page and data, which are not a published API, so it can stop working when Anthropic changes them. An unreadable answer counts as not known, never as no resets, and the plugin never claims a reset it did not see counted. Selecting an organization by its cookie has not been tried against a live session yet; the check after the reload is what keeps a reset from being used on another organization. Every 3 hours a tab opens briefly in the background for each login with a profile.

## Several organizations of one login

One Claude login (an e-mail) can belong to several organizations, each with its own plan and limits. With engine `0.4.7+fork.16` or later, which the plugin bundles, each organization is an account of its own: the first one of a login keeps its name (the e-mail), and each further one is named `<email>:<organization>` (lowercased, other characters as `-`, at most 24 characters, `-2`, `-3`… when taken). Run `Grazr: Install engine on target` on each host to update it.

- **Grouping.** The panel keeps the organizations of one login together, under a header with the e-mail, ranked where the first of them ranks. Each row and List card of the group names its organization and plan instead of repeating the e-mail (`Personal` for the default `<email>'s Organization`). A login with one account and nothing more found looks as it always did. Rotation is not grouped: `NEXT ▸` and the swaps follow the engine's order, and the colours stay tied to each account.
- **Discovery.** The organizations claude.ai lists for each login (read with its limit resets) that are not enrolled on a host close that login's group on its card, unnumbered and without a dial segment: one that can run Claude Code as not signed in, with `Sign in…`; a free one greyed as `Free plan — Claude Code needs a paid plan`; an API console one greyed as `API console organization — not a Claude subscription`.
- **Sign in another organization.** `Sign in another organization…` (on the group header, on the List card of a login with one account, or from the palette for the active login) runs the usual sign-in for that e-mail in the login's browser profile. Grazr fills in the e-mail and leaves claude.ai's consent page to you: pick the organization there and approve Claude Code. `Sign in…` on a discovered organization does the same for that organization, taken from the list stored for that login, and asks claude.ai for it (`orgUUID`); the enrolment refuses another organization (`claude.ai signed in to <org>, not <wanted> — pick <wanted> on the authorize page`). An organization already enrolled is not enrolled twice, and a new one joins the end of the rotation order. A host whose engine is older than `0.4.7+fork.16` refuses it (`update the engine on <host> first`), since that engine would overwrite the login's first organization.
- **Everything else** works as for any account: swapping by hand or by rotation, re-authenticating, limit resets per organization, and one browser profile per login.

A remote host with an older engine still renders: its accounts are grouped by e-mail, get no discovered organizations, and get a reading only when their login has one subscription organization.

## Notifications

Notices reach Orca through each host's queue; this Mac's default notifier is `queue` too, with `osascript` as an opt-in. Each host whose `notifier` includes `queue` queues its notices, and the plugin drains those queues every `drainIntervalMs` and shows each one as an OS notification. A host without the engine installed is logged and retried quietly, with backoff capped at 10 minutes. An unreachable host is reported once, then retried with backoff; its later failures do not toast again until it recovers.

## Limits

- Pinning an agent to its own account is not supported yet.
- The plugin does not sync accounts between machines. That would move OAuth tokens between machines, which is a separate project.
- There are no keyboard shortcuts for the commands.
- Plugins run on the desktop only.

## Credits and license

Grazr for Orca is MIT licensed; see [LICENSE](LICENSE).

The rotation engine in `engine/` is derived from [wazum/herdr-grazr](https://github.com/wazum/herdr-grazr) by Wolfgang Klinger (MIT). The copy here is a fork maintained with the plugin; see [engine/VENDORED.md](engine/VENDORED.md) for the source commit and how to refresh it.

## Development

Run the tests from the repository root. The suite uses Node's built-in test runner:

```
npm test
```

To run the plugin from a checkout with live panel data, add the folder in Orca under **Settings › Plugins › Development folders**. A development folder overrides an installed copy with the same id. Orca then writes `panel/accounts.html` in the folder while no panel is open. The file embeds your host names and account names, so keep it out of commits:

```sh
git update-index --skip-worktree panel/accounts.html
```

Run `git update-index --no-skip-worktree panel/accounts.html` to undo it. To regenerate the committed placeholder after changing the panel template, run `npm run placeholder`.

Editing `main.mjs` or anything under `lib/` does not restart the running worker. Use **Restart** on the plugin row, or disable and re-enable the plugin, to load your changes.
