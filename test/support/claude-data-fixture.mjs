// claude.ai's data as a signed-in page reads it (GET /api/organizations, /api/organizations/<uuid>/usage?cedar_ember=1),
// trimmed to the fields Grazr keeps, in the shapes seen live: a free personal organization, a Team organization and an
// API console organization; Pro and Max personal organizations are assumed shapes.

export const ORG = {
  free: '11111111-1111-4111-8111-111111111111',
  team: '22222222-2222-4222-8222-222222222222',
  api: '33333333-3333-4333-8333-333333333333',
  pro: '44444444-4444-4444-8444-444444444444',
  max: '55555555-5555-4555-8555-555555555555',
}

export const freeOrg = (email = 'pat@example.com') => ({
  uuid: ORG.free, name: `${email}'s Organization`, capabilities: ['chat'], rate_limit_tier: 'default_claude_ai', billing_type: 'none', raven_type: null,
})
export const teamOrg = () => ({
  uuid: ORG.team, name: 'Acme', capabilities: ['chat', 'raven', 'customer_terms:standard'], rate_limit_tier: 'default_raven', billing_type: 'stripe_subscription', raven_type: 'team',
})
export const apiOrg = () => ({
  uuid: ORG.api, name: 'Acme API', capabilities: ['api', 'compliance_logging', 'compliance_api', 'customer_terms:standard'], rate_limit_tier: 'auto_trust_tier_c', billing_type: 'prepaid', raven_type: null,
})
export const proOrg = (email = 'pat@example.com') => ({
  uuid: ORG.pro, name: `${email}'s Organization`, capabilities: ['chat', 'claude_pro'], rate_limit_tier: 'default_claude_ai', billing_type: 'stripe_subscription', raven_type: null,
})
export const maxOrg = (email = 'pat@example.com') => ({
  uuid: ORG.max, name: `${email}'s Organization`, capabilities: ['chat', 'claude_max'], rate_limit_tier: 'default_claude_max_20x', billing_type: 'apple_subscription', raven_type: null, plan_display_name: 'Max 20x',
})

// The grants of the Team organization as seen live: a spent full reset and two Fable resets.
export const fullGrant = (left = 0, extra = {}) => ({
  id: 'full-reset-2611', label: 'One full limit reset (November 2026)', resets_total: 1, resets_left: left,
  starts_at: '2026-11-01T00:00:00+00:00', ends_at: '2026-12-10T22:00:00+00:00', clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
  paused: false, usable_now: left > 0, use_requires_limit: false, percent_used: {}, blocking: [], arm: null, type: 'full',
  unavailable_reason: left > 0 ? null : 'unavailable', gives_back_weekly: false, ...extra,
})
export const fableGrant = (id = 'launch-2610-fable', left = 1, extra = {}) => ({
  id, label: 'New model launch: one Fable reset for Max, Team Premium and Enterprise Premium', resets_total: 1, resets_left: left,
  starts_at: '2026-10-30T00:00:00+00:00', ends_at: '2027-03-09T07:59:00+00:00', clears: ['five_hour', 'seven_day_overage_included'],
  paused: false, usable_now: true, use_requires_limit: false, percent_used: {}, blocking: [], arm: null, type: 'full',
  unavailable_reason: null, gives_back_weekly: true, ...extra,
})
export const cedar = (grants, extra = {}) => ({ eligible: true, ineligible_reason: null, at_limit: false, exhausted: [], grants, ...extra })
export const teamCedar = () => cedar([fullGrant(0), fableGrant('launch-2610-fable'), fableGrant('launch-2610-fable-6mo')])

// The page's answer to the organizations request.
export const answer = ({ organizations, usage = {}, selectedOrg = null }) => ({ signedIn: true, selectedOrg, organizations, usage })
export const usageOk = (cedarEmber) => ({ status: 200, cedar_ember: cedarEmber })
