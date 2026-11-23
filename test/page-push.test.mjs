import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPage } from './support/page-harness.mjs'

// A worker post of the event 'panel' (Orca 1.4.246+) replaces the cards in place: the page is not reloaded, so the
// selected tab and the chosen view and face hold, and the new cards' buttons and tabs work. The stub DOM parses no
// HTML, so a test posts the cards as JSON, and the harness builds them as the renderer would.
const refresh = (name) => ({ kind: 'refresh', command: 'refresh', params: { host: name }, text: `${name} refresh`, label: 'Refresh usage' })
const CARDS = [
  { name: 'mac', open: true, buttons: [refresh('mac')] },
  { name: 'devbox', buttons: [refresh('devbox')] },
]
const FRESH = () => new Date(Date.now() - 1000).toISOString()
const selectedOf = (page) => page.tabs().filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-host'))
const shownOf = (page) => page.main.querySelectorAll('section.host').filter((s) => s.getAttribute('hidden') === null).map((s) => s.getAttribute('data-host'))
const commandCalls = (page) => page.calls.filter((c) => c.action === 'plugin.request' && c.params.name !== 'active-host')

async function load(cards = CARDS) {
  const page = await loadPage({ transport: 'frame', request: true, generatedAt: FRESH(), cards })
  page.doc.parseCards = (html) => JSON.parse(html)
  return page
}
const post = (page, cards, data = { generatedAt: new Date().toISOString(), target: cards[0]?.name ?? null, hosts: {} }) =>
  page.push('panel', { main: JSON.stringify(cards), data })

test('the page listens for the worker\'s panel event on a host that offers plugin.request', async () => {
  const page = await load()
  assert.deepEqual(page.pushEvents(), ['panel'])
})

test('a post replaces the cards and keeps the selected tab, and the new card\'s button runs its command', async () => {
  const page = await load()
  await page.click(page.tabOf('devbox'))
  const next = [{ name: 'mac', open: true, buttons: [] }, { name: 'devbox', buttons: [refresh('devbox')] }]
  await post(page, next)
  assert.equal(page.buttonOf('mac', 'refresh'), null, 'the old cards are gone')
  assert.deepEqual(selectedOf(page), ['devbox'])
  assert.deepEqual(shownOf(page), ['devbox'])
  assert.equal(page.main.querySelectorAll('button.host-tab').length, 2)
  await page.click(page.buttonOf('devbox', 'refresh'))
  assert.equal(commandCalls(page).length, 1)
  assert.equal(commandCalls(page)[0].params.name, 'refresh')
  await page.click(page.tabOf('mac'))
  assert.deepEqual(shownOf(page), ['mac'])
})

test('a post keeps the view and face the user chose on every new card', async () => {
  const page = await load()
  // The stub cards open on the session view and the list face; the user picks the week and the dial.
  const card = page.cardOf('mac')
  await page.click(card.querySelector('button.view[data-view="weekly"]'))
  await page.click(card.querySelector('button.face[data-face="dial"]'))
  assert.equal(card.getAttribute('data-view'), 'weekly')
  await post(page, CARDS)
  assert.equal(page.cardOf('mac').querySelector('button.view[data-view="weekly"]').getAttribute('aria-pressed'), 'true')
  for (const name of ['mac', 'devbox']) {
    assert.equal(page.cardOf(name).getAttribute('data-view'), 'weekly')
    assert.equal(page.cardOf(name).getAttribute('data-face'), 'dial')
  }
})

test('a post whose cards no longer hold the selected host shows the target it renders', async () => {
  const page = await load()
  await page.click(page.tabOf('devbox'))
  await post(page, [{ name: 'mac', open: true, buttons: [] }, { name: 'lab', buttons: [] }])
  assert.deepEqual(selectedOf(page), ['mac'])
  assert.deepEqual(shownOf(page), ['mac'])
})

test('a post replaces the embedded data and redraws the clocks', async () => {
  const page = await load()
  let drawn = 0
  page.win.grazrDraw = () => { drawn += 1 }
  const data = { generatedAt: new Date().toISOString(), target: 'mac', hosts: { mac: { clock: { accounts: [] } } } }
  await post(page, CARDS, data)
  assert.equal(drawn, 1)
  assert.deepEqual(page.data().hosts, data.hosts)
  assert.equal(page.data().generatedAt, data.generatedAt)
})

test('a post without a markup string or without data is ignored', async () => {
  const page = await load()
  await page.push('panel', { data: {} })
  await page.push('panel', { main: JSON.stringify([{ name: 'lab', buttons: [] }]) })
  await page.push('panel', null)
  assert.deepEqual(selectedOf(page), ['mac'])
  assert.equal(page.tabOf('lab'), null)
})
