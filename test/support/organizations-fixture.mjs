// Reports for the grouping of the organizations of one login, shared by the panel tests.
export const NOW = new Date('2026-10-21T10:00:00Z')
export const TZ = 'UTC'
export const AT = NOW.getTime() - 3600 * 1000

export const session = (remaining, resets_at = null) => ({ kind: 'session', scope: null, group: 'session', remaining, resets_at })
export const weekly = (remaining, resets_at = null) => ({ kind: 'weekly_all', scope: null, group: 'weekly', remaining, resets_at })

const TEAM = { type: 'claude_team', tier: 'default_claude_team_5x' }
const MAX = { type: 'claude_max', tier: 'default_claude_max_5x' }

// One enrolled account of an engine from fork.16 on: login and organization_uuid set.
export const member = (name, email, login, org, extra = {}) => ({
  id: name, name, email, login, organization_uuid: org, parked: true, blocked: null, in_order: true, updated: null,
  organization: null, plan: MAX, snapshot: [session(80), weekly(80)], ...extra,
})

// Every login with one organization: the panel must look exactly as it did before logins were grouped.
// a active (with a reading of its Usage page), b next, c blocked, d spent until 12:00 (its page signed out), ghost named only.
export const singles = () => ({
  version: '0.4.7+fork.16',
  active: { id: 'a', name: 'a', email: 'a@example.com', organization: 'Acme', organization_uuid: 'oa' },
  order: ['a', 'b', 'c', 'd', 'ghost'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    member('a', 'a@example.com', 'ua', 'oa', { parked: false, organization: 'Acme', plan: TEAM, updated: 1790875000, unused_reset: { holds: true } }),
    member('b', 'b@example.com', 'ub', 'ob', { organization: "b's Organization", unused_reset: { holds: true } }),
    member('c', 'c@example.com', 'uc', 'oc', { blocked: 'authentication_failed' }),
    member('d', 'd@example.com', 'ud', 'od', { snapshot: [session(5, '2026-10-21T12:00:00Z'), weekly(60)] }),
  ],
})
export const singlesReadings = () => ({
  a: { readAt: AT, state: 'ok', full: 1, model: 2, kinds: [{ kind: 'full', label: 'Full', count: 1, expires: 'Expires Dec 10' }, { kind: 'model', label: 'Fable', count: 2, expires: '' }] },
  b: { readAt: AT, state: 'ok', full: 1, model: 0, kinds: [{ kind: 'full', label: 'Full', count: 1, expires: '' }] },
  d: { readAt: AT, state: 'signed-out' },
})

// Two organizations of one login (s@example.com), interleaved by rank with two other logins: s's personal organization ranks
// second (NEXT), t is active, s's Acme organization is spent and ranks after u, and v is blocked.
export const shared = () => ({
  version: '0.4.7+fork.16',
  active: { id: 't', name: 't@example.com', email: 't@example.com', organization: 'T Org', organization_uuid: 'ot' },
  order: ['t@example.com', 's@example.com', 'u@example.com', 's@example.com:acme', 'v@example.com'],
  settings: { enabled: true, thresholds: { session: 15, weekly: 20 } },
  accounts: [
    member('t@example.com', 't@example.com', 'ut', 'ot', { id: 't', parked: false, organization: 'T Org' }),
    member('s@example.com', 's@example.com', 'us', 'os1', { organization: "s@example.com's Organization", unused_reset: { holds: true } }),
    member('u@example.com', 'u@example.com', 'uu', 'ou'),
    member('s@example.com:acme', 's@example.com', 'us', 'os2', { organization: 'Acme', plan: TEAM, snapshot: [session(3, '2026-10-21T12:00:00Z'), weekly(70)] }),
    member('v@example.com', 'v@example.com', 'uv', 'ov', { blocked: 'authentication_failed' }),
  ],
})
export const sharedReadings = () => ({
  's@example.com': { readAt: AT, state: 'ok', full: 1, model: 1, kinds: [] },
  'u@example.com': { readAt: AT, state: 'ok', full: 1, model: 0, kinds: [] },
})
