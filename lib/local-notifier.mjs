import { isRemote, forceInstallFor } from './hosts.mjs'
import { describe } from './errors.mjs'

const MIGRATED_KEY = 'notifierMigrated'
const SHIM_NOTIFIERS_KEY = 'shimNotifiers'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Once, a local host still on the old default (osascript alone) moves to queue; the flag keeps a later, deliberate osascript.
// Resolves to the names of the hosts it changed.
export async function migrateOldLocalDefault({ stored, host, storage, log }) {
  try {
    if (await storage.get(MIGRATED_KEY)) return []
    const moved = []
    if (isObject(stored) && Array.isArray(stored.hosts)) {
      const hosts = stored.hosts.map((h) => {
        if (!(isObject(h) && !isRemote(h) && h.notifier === 'osascript')) return h
        moved.push(h.name)
        return { ...h, notifier: 'queue' }
      })
      if (moved.length > 0) {
        await host('settings.set', { key: 'hosts', value: hosts })
        stored.hosts = hosts
      }
    }
    await storage.set(MIGRATED_KEY, true)
    return moved
  } catch (err) {
    log(`grazr: notifier migration failed: ${describe(err)}`)
    return []
  }
}

async function readRecorded(storage) {
  const recorded = await storage.get(SHIM_NOTIFIERS_KEY)
  return isObject(recorded) ? recorded : {}
}

export async function recordShimNotifier(storage, h) {
  if (isRemote(h)) return
  await storage.set(SHIM_NOTIFIERS_KEY, { ...(await readRecorded(storage)), [h.name]: h.notifier })
}

// The status line and failure hook carry the notifier in their command, so a changed notifier needs `install` again.
// Only a Mac already connected is touched, so this never connects a status line the user did not ask for.
export async function syncLocalShims({ settings, runner, storage, log, moved = [] }) {
  const recorded = await readRecorded(storage)
  for (const h of settings.hosts.filter((x) => !isRemote(x))) {
    const changed = moved.includes(h.name) || (h.name in recorded && recorded[h.name] !== h.notifier)
    if (!changed) continue
    const status = await runner.runJson(h, ['status', '--json'], { timeoutMs: 10000 })
    if (!status.ok || !status.value?.installed) continue
    const args = ['install', ...(forceInstallFor(settings, h) ? ['--force'] : [])]
    const install = await runner.runLines(h, args, { timeoutMs: 8000 })
    if (install.ok) await recordShimNotifier(storage, h)
    else log(`grazr ${h.name}: reinstall for notifier ${h.notifier} failed: ${install.failure?.detail ?? ''}`)
  }
}
