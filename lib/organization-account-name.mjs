// The name a further organization of an enrolled login is enrolled under: `<email>:<org-slug>`. The engine keeps
// account names unique, and the first organization of a login keeps the bare e-mail.

// A slug is at most this long.
export const SLUG_MAX = 24

// The organization's name in lowercase without accents, each run of other characters a single '-', cut to SLUG_MAX;
// the first 8 characters of its uuid when the name leaves nothing.
export function organizationSlug(name, uuid) {
  const plain = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  const slug = plain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, SLUG_MAX).replace(/-+$/, '')
  if (slug !== '') return slug
  const short = String(uuid ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 8).replace(/-+$/, '')
  return short !== '' ? short : 'org'
}

// `<email>:<slug>`, with -2, -3… added while the name is taken (compared without case, as an e-mail is).
export function organizationAccountName({ email, organization, organizationUuid, taken = [] }) {
  const used = new Set([...taken].filter((n) => typeof n === 'string').map((n) => n.toLowerCase()))
  const base = `${email}:${organizationSlug(organization, organizationUuid)}`
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`
    if (!used.has(name.toLowerCase())) return name
  }
}
