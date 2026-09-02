// Steps 5-11 of the Design Studio E2E: the user's side of the canvas —
// selection + inspector, undo/redo, drag reorder, layers, draw tool,
// preview links and the live agent badge.
import { screenshot } from '../../driver/capture'
import {
  clickAt,
  computedIn,
  dragFrom,
  nodeCenterOnScreen,
  pwSelector,
  waitForArtboardFrame,
  waitForValue,
} from '../../driver/design'
import {
  HOME_WIDTH,
  PRIMARY_RGB,
  SHOT,
  TEXT_RGB,
  byName,
  centerOf,
  childIds,
  docsPanelRow,
  findNode,
  homeFrame,
  homeIframe,
  keyRedo,
  keyUndo,
  nodeGet,
  selectedIds,
  type Ctx,
} from './ctx'
import { CARD_NAMES } from './content'

// Resize handles of the SelectionOverlay (fill = surface token); icon rects
// of the same size elsewhere in the chrome must not count.
const handleCount = (ctx: Ctx) =>
  ctx.page.locator('svg rect[width="8"][height="8"][fill="var(--color-surface)"]').count()

export async function step5SelectInspector(ctx: Ctx): Promise<void> {
  const { page, ids, cards, checker } = ctx
  await docsPanelRow(ctx, 'Home').click()
  await page.waitForTimeout(600)
  const frame = await homeFrame(ctx)
  cards.section = (await findNode(ctx, ids.home, byName('Destaques'))).id
  ;[cards.card1, cards.card2] = await childIds(ctx, ids.home, cards.section)
  const title = (n: { tag: string; text?: string }) =>
    n.tag === 'h3' && n.text === 'Croissant de manteiga'
  cards.title2 = (await findNode(ctx, ids.home, title)).id

  await clickAt(page, await centerOf(ctx, frame, cards.card2))
  await page.waitForTimeout(400)
  const first = (await selectedIds(ctx))[0]
  await page.keyboard.press('Enter') // enter the Destaques scope
  await page.waitForTimeout(200)
  await clickAt(page, await centerOf(ctx, frame, cards.card2))
  await page.waitForTimeout(400)
  const second = (await selectedIds(ctx))[0]
  const handles = await handleCount(ctx)
  await screenshot(page, `${SHOT}-04-selected`)
  checker.check(
    '5a click selects section, Enter+click selects card with 8 handles',
    first === cards.section && second === cards.card2 && handles === 8,
    `first=${first === cards.section} second=${second === cards.card2} handles=${handles}`,
  )

  await clickAt(page, await centerOf(ctx, frame, cards.title2), { ctrl: true })
  await page.waitForTimeout(500)
  const deep = (await selectedIds(ctx))[0]
  const typo = page.locator('section', {
    has: page.getByText('Tipografia', { exact: true }),
  })
  const typoVisible = await typo.isVisible().catch(() => false)
  const colorInput = typo
    .locator('div.grid', { has: page.locator('span[title="Cor"]') })
    .locator('input')
  await colorInput.fill('#7a3e12')
  const t0 = Date.now()
  await colorInput.press('Enter')
  const color = await waitForValue(() => computedIn(frame, cards.title2, 'color'), PRIMARY_RGB)
  const elapsed = Date.now() - t0
  const stored = await waitForValue(
    async () => (await nodeGet(ctx, ids.home, cards.title2)).style.color,
    '#7a3e12',
    1500,
  )
  await screenshot(page, `${SHOT}-05-color-changed`)
  checker.check(
    '5b Ctrl+click → Tipografia; colour #7a3e12 reaches frame <1s and DB',
    deep === cards.title2 &&
      typoVisible &&
      color === PRIMARY_RGB &&
      elapsed < 1000 &&
      stored === '#7a3e12',
    `deep=${deep === cards.title2} typo=${typoVisible} color=${color} in ${elapsed}ms stored=${stored}`,
  )
}

export async function step6UndoRedo(ctx: Ctx): Promise<void> {
  const { cards, checker } = ctx
  const frame = await homeFrame(ctx)
  const read = () => computedIn(frame, cards.title2, 'color')
  await keyUndo(ctx)
  const afterUndo = await waitForValue(read, TEXT_RGB)
  await keyRedo(ctx)
  const afterRedo = await waitForValue(read, PRIMARY_RGB)
  await keyUndo(ctx)
  const final = await waitForValue(read, TEXT_RGB)
  checker.check(
    '6 Ctrl+Z reverts, Ctrl+Shift+Z reapplies, Ctrl+Z reverts again',
    afterUndo === TEXT_RGB && afterRedo === PRIMARY_RGB && final === TEXT_RGB,
    `undo=${afterUndo} redo=${afterRedo} final=${final}`,
  )
}

export async function step7Drag(ctx: Ctx): Promise<void> {
  const { page, ids, cards, checker } = ctx
  const frame = await homeFrame(ctx)
  await clickAt(page, await centerOf(ctx, frame, cards.card1))
  await page.waitForTimeout(400)
  const selected = (await selectedIds(ctx))[0]
  const from = await centerOf(ctx, frame, cards.card1)
  const width = await frame.evaluate(
    (sel) => document.querySelector(sel)!.getBoundingClientRect().width,
    pwSelector(cards.card1),
  )
  // Flex child: a 40px nudge stays before the sibling's midpoint (a no-op by
  // design), so the drag lands past card 2's midpoint to change the index.
  await dragFrom(page, from, (width * 1.4 + 32) * from.zoom, 0)
  await page.waitForTimeout(500)
  const order = await childIds(ctx, ids.home, cards.section)
  await screenshot(page, `${SHOT}-06-after-drag`)
  await keyUndo(ctx)
  await page.waitForTimeout(400)
  const restored = await childIds(ctx, ids.home, cards.section)
  checker.check(
    '7 drag card 1 across card 2 → reorder (index 0→1); Ctrl+Z restores',
    selected === cards.card1 && order[1] === cards.card1 && restored[0] === cards.card1,
    `selected=${selected === cards.card1} order=${order.indexOf(cards.card1)} restored=${restored.indexOf(cards.card1)}`,
  )
}

export async function step8Layers(ctx: Ctx): Promise<void> {
  const { page, ids, cards, checker } = ctx
  const label = page.locator(`aside span[title="${CARD_NAMES[0]}"]`).first()
  await label.waitFor({ state: 'visible', timeout: 3000 })
  const row = label.locator('xpath=..')
  const highlighted = await row.evaluate((el) =>
    el.className.includes('bg-[var(--color-surface-2)]'),
  )
  await row.dblclick()
  // The label span is replaced by the input, so the row locator (derived from
  // the label) no longer resolves; the input carries the label as placeholder.
  const input = page.locator(`aside input[placeholder="${CARD_NAMES[0]}"]`)
  await input.waitFor({ state: 'visible', timeout: 2000 })
  await input.fill('Card destaque')
  await input.press('Enter')
  const renamed = await waitForValue(
    async () => (await nodeGet(ctx, ids.home, cards.card1)).name,
    'Card destaque',
    1500,
  )
  checker.check(
    '8 layers row highlighted for selected card; double-click rename',
    highlighted && renamed === 'Card destaque',
    `highlighted=${highlighted} name=${renamed}`,
  )
}

export async function step9RectTool(ctx: Ctx): Promise<void> {
  const { page, ids, checker } = ctx
  await page.keyboard.press('r')
  await page.waitForTimeout(150)
  const pressed = await page.getByTitle('Retângulo (R)').getAttribute('aria-pressed')
  const box = await page.locator(homeIframe(ctx)).boundingBox()
  if (!box) throw new Error('no Home iframe box')
  const zoom = box.width / HOME_WIDTH
  const start = { x: box.x + 1000 * zoom, y: box.y + 570 * zoom, zoom }
  await dragFrom(page, start, 200 * zoom, 120 * zoom)
  await page.waitForTimeout(500)
  const newId = (await selectedIds(ctx))[0]
  const node = newId ? await nodeGet(ctx, ids.home, newId) : null
  const w = parseInt(node?.style.width ?? '0', 10)
  const h = parseInt(node?.style.height ?? '0', 10)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(400)
  const gone = await nodeGet(ctx, ids.home, newId).then(
    () => false,
    () => true,
  )
  checker.check(
    '9 R + drag creates a ~200×120 rectangle; Delete removes it',
    pressed === 'true' &&
      node?.name === 'Rectangle' &&
      Math.abs(w - 200) <= 4 &&
      Math.abs(h - 120) <= 4 &&
      gone,
    `pressed=${pressed} name=${node?.name} size=${w}×${h} gone=${gone}`,
  )
}

export async function step10Preview(ctx: Ctx): Promise<void> {
  const { page, ids, checker } = ctx
  await docsPanelRow(ctx, 'Home').click()
  await page.waitForTimeout(300)
  await page.getByTestId('design-preview').click()
  const root = page.getByTestId('design-preview-root')
  await root.waitFor({ state: 'visible', timeout: 5000 })
  const preview = await waitForArtboardFrame(page, ids.home, {
    mode: 'preview',
  })
  await page.waitForTimeout(500)
  const cta = await findNode(ctx, ids.home, byName('CTA'))
  const p = await nodeCenterOnScreen(
    page,
    preview,
    'iframe[title="Preview: Home"]',
    HOME_WIDTH,
    pwSelector(cta.id),
  )
  await clickAt(page, p)
  const select = page.getByTestId('design-preview-artboard-select')
  const current = await waitForValue(() => select.inputValue(), ids.menu, 3000)
  await page.waitForTimeout(600)
  await screenshot(page, `${SHOT}-07-preview-cardapio`)
  await page.keyboard.press('Escape')
  const hidden = () =>
    root.waitFor({ state: 'hidden', timeout: 1500 }).then(
      () => true,
      () => false,
    )
  let closed = await hidden()
  if (!closed) {
    checker.log('UX: Escape did not close the preview (focus inside the frame?); using the X')
    await page.getByTestId('design-preview-close').click()
    closed = await hidden()
  }
  checker.check(
    '10 preview opens, CTA navigates to Cardápio, Esc closes',
    current === ids.menu && closed,
    `current=${current === ids.menu ? 'Cardápio' : current} closed=${closed}`,
  )
}

export async function step11AgentLive(ctx: Ctx): Promise<void> {
  const { page, mcp, ids, checker } = ctx
  const hero = await findNode(ctx, ids.home, byName('Hero'))
  // The toolbar badge names the action ("Claude · ajustando estilo · Hero").
  const badge = page.locator('.pw-design-shimmer').first()
  const visible = (loc: typeof badge, state: 'visible' | 'hidden') =>
    loc.waitFor({ state, timeout: 3000 }).then(
      () => true,
      () => false,
    )
  // "Claude atualizou" only toasts for an artboard the human cannot see; the
  // in-place pill + badge already cover a visible one.
  const homeInView = await page.evaluate((id) => {
    const el = document.querySelector(`[data-artboard="${id}"]`)
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight
  }, ids.home)
  await mcp.call('design_styles_update', {
    artboardId: ids.home,
    items: [{ id: hero.id, style: { 'background-color': '#f4e9d8' } }],
    summary: 'Hero bg',
  })
  const shown = await visible(badge, 'visible')
  const badgeText = shown ? await badge.textContent() : ''
  const toasted = await visible(page.getByText('Claude atualizou "Home"').first(), 'visible')
  await mcp.call('design_nodes_finish', {
    artboardId: ids.home,
    summary: 'Claude: hero',
  })
  const hidden = await visible(badge, 'hidden')
  checker.check(
    '11 badge names the action, toast only when Home is off-screen, badge clears on finish',
    shown && /ajustando estilo/.test(badgeText ?? '') && hidden && toasted === !homeInView,
    `badge=${JSON.stringify(badgeText)} hidden=${hidden} toast=${toasted} homeInView=${homeInView}`,
  )
}
