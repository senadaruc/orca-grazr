import { test } from 'node:test'
import assert from 'node:assert/strict'
import { organizationAccountName, organizationSlug, SLUG_MAX } from '../lib/organization-account-name.mjs'

test('the slug is the organization name in lowercase without accents, other characters a single dash, cut to 24 characters', () => {
  assert.equal(organizationSlug('Acme Corp.', 'o1'), 'acme-corp')
  assert.equal(organizationSlug('  Ünïcode & Söns GmbH  ', 'o1'), 'unicode-sons-gmbh')
  assert.equal(SLUG_MAX, 24)
  assert.equal(organizationSlug('The Very Long Organization Name Inc', 'o1'), 'the-very-long-organizati')
  assert.equal(organizationSlug('Twenty Three Characters- x', 'o1'), 'twenty-three-characters', 'no dash is left at the cut')
})

test('a name with nothing to slug falls back to the first 8 characters of the organization uuid', () => {
  assert.equal(organizationSlug('日本', '8F3A2B1C-0000-4000-8000-000000000000'), '8f3a2b1c')
  assert.equal(organizationSlug(null, 'abc'), 'abc')
  assert.equal(organizationSlug('', ''), 'org')
})

test('the account name is <email>:<slug>, with -2, -3 while it is taken, compared without case', () => {
  assert.equal(organizationAccountName({ email: 'a@b.io', organization: 'Acme', organizationUuid: 'o1', taken: ['a@b.io'] }), 'a@b.io:acme')
  assert.equal(organizationAccountName({ email: 'a@b.io', organization: 'Acme', organizationUuid: 'o1', taken: ['A@b.io:ACME', 'a@b.io:acme-2'] }), 'a@b.io:acme-3')
})
