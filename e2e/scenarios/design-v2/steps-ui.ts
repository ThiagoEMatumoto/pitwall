// Steps 7-9: the inspector's Animação section on the hero, the Interagir
// mode playing entrances in the editor, and the preview player scrolling
// (in-view entrances) then navigating Landing → Cardápio through a smart
// transition.
import { screenshot } from '../../driver/capture'
import {
  clickAt,
  nodeCenterOnScreen,
  PREVIEW_IFRAME_SELECTOR,
  pwSelector,
  waitForPreviewFrame,
  waitForValue,
} from '../../driver/design'
import { LANDING_NODES } from './content'
import { clickNode, editFrame, fitAll, nodeAttrs, SHOT, type V2Ctx } from './ctx'

const PLAYED = (classes: string[]) => classes.includes('pw-m-play') || classes.includes('pw-m-done')

async function selectedName(ctx: V2Ctx): Promise<string> {
  const sel = await ctx.mcp.call<{
    nodes?: Array<{ tag: string; name?: string }>
  }>('design_selection_get', { docId: ctx.docId })
  return sel.nodes?.[0] ? `${sel.nodes[0].tag}:${sel.nodes[0].name ?? ''}` : 'none'
}

async function cardStates(ctx: V2Ctx, frame: Awaited<ReturnType<typeof editFrame>>) {
  const cards = await ctx.findId('landing', LANDING_NODES.cards)
  return frame.evaluate((sel) => {
    const list = document.querySelector(sel)
    const kids = list ? Array.from(list.children) : []
    return {
      frozen: document.documentElement.getAttribute('data-pw-motion'),
      cards: kids.map((k) => Array.from(k.classList).join(' ')),
    }
  }, pwSelector(cards))
}

export async function step7Inspector(ctx: V2Ctx): Promise<void> {
  const { page } = ctx
  await fitAll(ctx)
  await clickNode(ctx, 'landing', LANDING_NODES.hero, {
    ctrl: true,
    corner: true,
  })
  const selected = await selectedName(ctx)
  const inspector = page.locator('aside').last()
  const toggle = page.getByTestId('design-motion-toggle-entrance')
  if (!(await toggle.isVisible().catch(() => false))) {
    // The section keeps its last open/closed state; open it by its header.
    await inspector.getByRole('button', { name: 'Animação' }).click()
    await page.waitForTimeout(200)
  }
  const entranceOn = await toggle.getAttribute('aria-checked')
  ctx.check(
    '7 hero selected → Animação shows Entrada on',
    /Hero$/.test(selected) && entranceOn === 'true',
    `selected=${selected} entrance=${entranceOn}`,
  )

  // Segmented presets are icon buttons; the tooltip carries the label ("↑" = slide-up).
  await page.getByTestId('design-motion').locator('button[title="↑"]').click()
  await page.waitForTimeout(500)
  const hero = await ctx.findId('landing', LANDING_NODES.hero)
  const frame = await editFrame(ctx, 'landing')
  const attrs = await nodeAttrs(frame, hero)
  ctx.check(
    '7 preset slide-up via Segmented → frame attribute follows',
    attrs?.attrs['data-pw-m-in'] === 'slide-up',
    JSON.stringify(attrs?.attrs),
  )
  await screenshot(page, `${SHOT}-05-inspector-motion`)

  const replay = page.getByTestId('design-motion-replay')
  const enabled = await replay.isEnabled()
  await replay.click()
  await page.waitForTimeout(400)
  const stillThere = await nodeAttrs(frame, hero)
  ctx.check(
    '7 Reproduzir is enabled and leaves the node intact',
    enabled && stillThere?.attrs['data-pw-m-in'] === 'slide-up',
    `enabled=${enabled}`,
  )
}

export async function step8Interact(ctx: V2Ctx): Promise<void> {
  const { page } = ctx
  await fitAll(ctx)
  const button = page.getByTestId('design-interact')
  await button.click()
  const pressed = await waitForValue(() => button.getAttribute('aria-pressed'), 'true', 2000)
  // hero 600ms + cards 420ms with 2 × 80ms stagger: everything has played by now.
  await page.waitForTimeout(1600)
  const frame = await editFrame(ctx, 'landing')
  const states = await cardStates(ctx, frame)
  const hero = await nodeAttrs(frame, await ctx.findId('landing', LANDING_NODES.hero))
  await screenshot(page, `${SHOT}-07-interact`)
  ctx.check(
    '8 Interagir: frame unfrozen, hero and cards played (load; in-view degrades to load)',
    pressed === 'true' &&
      states.frozen === null &&
      states.cards.length === 3 &&
      states.cards.every((c) => PLAYED(c.split(' '))) &&
      PLAYED(hero?.classes ?? []),
    `pressed=${pressed} frozen=${states.frozen} cards=${JSON.stringify(states.cards)} hero=${hero?.classes.join(' ')}`,
  )

  await page.keyboard.press('Escape')
  let off = await waitForValue(() => button.getAttribute('aria-pressed'), 'false', 1500)
  const escWorked = off === 'false'
  if (!escWorked) {
    ctx.log('UX: Esc did not leave Interagir (focus inside the frame?); clicking the button')
    await button.click()
    off = await waitForValue(() => button.getAttribute('aria-pressed'), 'false', 1500)
  }
  const after = await cardStates(ctx, frame)
  ctx.check(
    '8 Esc leaves Interagir and the frame freezes again',
    off === 'false' && after.frozen === 'final',
    `esc=${escWorked} frozen=${after.frozen}`,
  )
}

export async function step9Preview(ctx: V2Ctx): Promise<void> {
  const { page } = ctx
  await fitAll(ctx)
  await clickNode(ctx, 'landing', 'Headline')
  await page.getByTestId('design-preview').click()
  const root = page.getByTestId('design-preview-root')
  await root.waitFor({ state: 'visible', timeout: 5000 })
  const select = page.getByTestId('design-preview-artboard-select')
  const stage = page.getByTestId('design-preview-stage')
  let frame = await waitForPreviewFrame(page)
  await page.waitForTimeout(900)

  const before = await cardStates(ctx, frame)
  // Scroll like a reader, in steps: in-view fires once, at the position
  // where the cards cross the viewport, not at the end of a jump.
  for (let guard = 0; guard < 40; guard++) {
    const atEnd = await stage.evaluate((el) => {
      el.scrollTop += 400
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 1
    })
    await page.waitForTimeout(120)
    if (atEnd) break
  }
  await page.waitForTimeout(1200)
  const scrolled = await stage.evaluate((el) => el.scrollTop)
  const after = await cardStates(ctx, frame)
  await screenshot(page, `${SHOT}-08-preview-scrolled`)
  ctx.check(
    '9 preview: cards below the fold play on scroll (in-view)',
    scrolled > 0 &&
      after.frozen === null &&
      after.cards.length === 3 &&
      after.cards.every((c) => PLAYED(c.split(' '))),
    `scrollTop=${scrolled} before=${JSON.stringify(before.cards)} after=${JSON.stringify(after.cards)}`,
  )

  await stage.evaluate((el) => {
    el.scrollTop = 0
  })
  await page.waitForTimeout(500)
  const navId = await ctx.findId('landing', LANDING_NODES.navMenu)
  const p = await nodeCenterOnScreen(
    page,
    frame,
    PREVIEW_IFRAME_SELECTOR,
    ctx.widths.landing,
    pwSelector(navId),
  )
  await clickAt(page, p)
  // The runtime marks <html data-pw-vt="smart"> for the 1000ms View
  // Transition; seeing it is the evidence the swap animated in place.
  let vtSeen = ''
  const vtDeadline = Date.now() + 900
  while (Date.now() < vtDeadline && vtSeen !== 'smart') {
    vtSeen =
      (await frame
        .evaluate(() => document.documentElement.getAttribute('data-pw-vt') ?? '')
        .catch(() => '')) || vtSeen
  }
  // Two frames of the transition, straight after the click.
  await screenshot(page, `${SHOT}-09-transition-a`)
  await screenshot(page, `${SHOT}-09-transition-b`)
  ctx.check('9 smart link: View Transition ran in the player (data-pw-vt=smart)', vtSeen === 'smart', `seen=${vtSeen}`)
  const current = await waitForValue(() => select.inputValue(), ctx.ids.menu, 4000)
  await page.waitForTimeout(600)
  frame = await waitForPreviewFrame(page)
  const title = await page.locator(PREVIEW_IFRAME_SELECTOR).first().getAttribute('title')
  const menuGrid = await frame.locator('[data-name="Menu grid"]').count()
  const header = await frame.locator(`[data-name="${LANDING_NODES.header}"]`).count()
  await screenshot(page, `${SHOT}-10-preview-cardapio`)
  ctx.check(
    '9 smart link: navigated to Cardápio in the single player (header kept by name)',
    current === ctx.ids.menu && title === 'Preview: Cardápio' && menuGrid === 1 && header === 1,
    `select=${current === ctx.ids.menu} title=${title} menuGrid=${menuGrid} header=${header}`,
  )

  await page.keyboard.press('Escape')
  const closed = await root
    .waitFor({ state: 'hidden', timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  ctx.check('9 Esc leaves the preview', closed)
}
